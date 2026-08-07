import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import {
  db,
  ownersTable,
  subscriptionsTable,
  subscriptionPlansTable,
  paymentsTable,
  webhookEventsTable,
  type Subscription,
  type SubscriptionPlan,
} from "../db";
import { razorpay, ensureRazorpayPlanId, totalCountForPeriod, verifyCheckoutSignature } from "../lib/razorpay";
import { getCurrentSubscription, isSubStatusActiveLike } from "./entitlement.service";
import { logger } from "../lib/logger";

export class SubscriptionServiceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function listActivePlans(): Promise<SubscriptionPlan[]> {
  return db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.active, true)).orderBy(subscriptionPlansTable.price);
}

async function getPlanOrThrow(planId: number): Promise<SubscriptionPlan> {
  const [plan] = await db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, planId));
  if (!plan || !plan.active) throw new SubscriptionServiceError(404, "PLAN_NOT_FOUND", "That plan doesn't exist.");
  return plan;
}

/**
 * Creates a Razorpay Subscription for the authenticated Owner's chosen plan
 * and a matching local row (status PENDING until checkout is verified).
 * The frontend sends only {planId} — everything else (price, Razorpay plan
 * id, owner identity) is resolved here, never trusted from the client.
 */
export async function createRazorpaySubscription(
  ownerId: number,
  planId: number,
): Promise<{ subscriptionId: string; keyId: string; amount: string; currency: string }> {
  const existing = await getCurrentSubscription(ownerId);
  if (existing && isSubStatusActiveLike(existing.status)) {
    throw new SubscriptionServiceError(409, "ALREADY_SUBSCRIBED", "You already have an active subscription. Cancel it first to switch plans.");
  }

  const plan = await getPlanOrThrow(planId);
  const razorpayPlanId = await ensureRazorpayPlanId(plan);

  const [owner] = await db.select().from(ownersTable).where(eq(ownersTable.id, ownerId));
  // Share-to-earn reward earned before subscribing: delay the first charge by
  // 30 days instead of charging immediately.
  const startAt = owner?.freeMonthPending
    ? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    : undefined;

  const razorpaySub = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    customer_notify: 1,
    total_count: totalCountForPeriod(plan.billingPeriod),
    start_at: startAt,
    notes: { ownerId: String(ownerId), planId: String(plan.id) },
  });

  await db.insert(subscriptionsTable).values({
    ownerId,
    planId: plan.id,
    platform: "WEB",
    provider: "RAZORPAY",
    providerPlanId: razorpayPlanId,
    providerSubscriptionId: razorpaySub.id,
    status: "PENDING",
    autoRenew: true,
  });

  return { subscriptionId: razorpaySub.id, keyId: process.env.RAZORPAY_KEY_ID!, amount: plan.price, currency: plan.currency };
}

/**
 * Verifies the checkout.js response server-side before trusting it: the
 * frontend's own "payment succeeded" callback is never sufficient on its own.
 */
export async function verifyAndActivate(
  ownerId: number,
  params: { paymentId: string; subscriptionId: string; signature: string },
): Promise<Subscription> {
  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.ownerId, ownerId), eq(subscriptionsTable.providerSubscriptionId, params.subscriptionId)));
  if (!row) {
    throw new SubscriptionServiceError(404, "SUBSCRIPTION_NOT_FOUND", "No matching subscription found for this owner.");
  }

  const validSignature = verifyCheckoutSignature(params.paymentId, params.subscriptionId, params.signature);
  if (!validSignature) {
    throw new SubscriptionServiceError(422, "INVALID_SIGNATURE", "Payment verification failed.");
  }

  // Never trust the client's own claim that payment succeeded — re-fetch the
  // authoritative state directly from Razorpay.
  const razorpaySub = await razorpay.subscriptions.fetch(params.subscriptionId);
  if (razorpaySub.status !== "active" && razorpaySub.status !== "authenticated") {
    throw new SubscriptionServiceError(422, "SUBSCRIPTION_NOT_ACTIVE", `Razorpay reports this subscription as "${razorpaySub.status}".`);
  }

  const [updated] = await db
    .update(subscriptionsTable)
    .set({
      status: "ACTIVE",
      providerPaymentId: params.paymentId,
      startDate: razorpaySub.start_at ? new Date(razorpaySub.start_at * 1000) : new Date(),
      expiryDate: razorpaySub.charge_at ? new Date(razorpaySub.charge_at * 1000) : null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.id, row.id))
    .returning();

  const plan = await getPlanOrThrow(row.planId);
  await db
    .insert(paymentsTable)
    .values({
      ownerId,
      subscriptionId: row.id,
      provider: "RAZORPAY",
      providerPaymentId: params.paymentId,
      amount: plan.price,
      currency: plan.currency,
      paymentStatus: "succeeded",
      paymentDate: new Date(),
    })
    .onConflictDoNothing();

  await db.update(ownersTable).set({ freeMonthPending: false }).where(eq(ownersTable.id, ownerId));

  logger.info({ ownerId, subscriptionId: params.subscriptionId }, "SUBSCRIPTION_ACTIVATED");
  return updated;
}

export async function cancel(ownerId: number): Promise<Subscription> {
  const sub = await getCurrentSubscription(ownerId);
  if (!sub || !sub.providerSubscriptionId || !isSubStatusActiveLike(sub.status)) {
    throw new SubscriptionServiceError(404, "NO_ACTIVE_SUBSCRIPTION", "No active subscription to cancel.");
  }
  // cancelAtCycleEnd=true: access continues until the current billing period
  // ends — the actual status flip to CANCELLED/EXPIRED happens via webhook.
  await razorpay.subscriptions.cancel(sub.providerSubscriptionId, true);

  const [updated] = await db
    .update(subscriptionsTable)
    .set({ autoRenew: false, cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptionsTable.id, sub.id))
    .returning();

  logger.info({ ownerId, subscriptionId: sub.providerSubscriptionId }, "SUBSCRIPTION_CANCELLED");
  return updated;
}

const STATUS_BY_EVENT: Record<string, string> = {
  "subscription.activated": "ACTIVE",
  "subscription.charged": "ACTIVE",
  "subscription.pending": "GRACE_PERIOD",
  "subscription.halted": "ON_HOLD",
  "subscription.cancelled": "CANCELLED",
  "subscription.completed": "EXPIRED",
};

/**
 * Idempotent, retry-safe webhook processing: a Razorpay event id already seen
 * is ignored rather than reprocessed, and the subscription's latest state is
 * re-fetched from Razorpay's API rather than trusted purely from the payload,
 * so an out-of-order delivery can't regress a subscription to a stale status.
 */
export async function handleWebhookEvent(rawBody: string, eventIdHeader: string | undefined): Promise<void> {
  const event = JSON.parse(rawBody) as { event: string; payload?: { subscription?: { entity?: { id?: string } }; payment?: { entity?: { id?: string } } } };
  const eventId = eventIdHeader || crypto.createHash("sha256").update(rawBody).digest("hex");

  const inserted = await db
    .insert(webhookEventsTable)
    .values({ provider: "RAZORPAY", providerEventId: eventId, eventType: event.event })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    logger.info({ eventId, type: event.event }, "WEBHOOK_PROCESSED (duplicate, ignored)");
    return;
  }

  const subscriptionId = event.payload?.subscription?.entity?.id;
  const paymentId = event.payload?.payment?.entity?.id;
  if (!subscriptionId) {
    logger.info({ type: event.event }, "WEBHOOK_PROCESSED (no subscription id, ignored)");
    return;
  }

  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.providerSubscriptionId, subscriptionId));
  if (!row) {
    logger.warn({ subscriptionId, type: event.event }, "Webhook for unknown subscription id");
    return;
  }

  const newStatus = STATUS_BY_EVENT[event.event];
  if (newStatus) {
    const razorpaySub = await razorpay.subscriptions.fetch(subscriptionId);
    await db
      .update(subscriptionsTable)
      .set({
        status: newStatus,
        providerPaymentId: paymentId ?? row.providerPaymentId,
        expiryDate: razorpaySub.charge_at ? new Date(razorpaySub.charge_at * 1000) : row.expiryDate,
        cancelledAt: newStatus === "CANCELLED" ? new Date() : row.cancelledAt,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionsTable.id, row.id));

    if (event.event === "subscription.charged" && paymentId) {
      const plan = await getPlanOrThrow(row.planId);
      await db
        .insert(paymentsTable)
        .values({
          ownerId: row.ownerId,
          subscriptionId: row.id,
          provider: "RAZORPAY",
          providerPaymentId: paymentId,
          amount: plan.price,
          currency: plan.currency,
          paymentStatus: "succeeded",
          paymentDate: new Date(),
        })
        .onConflictDoNothing();
    }
  }

  logger.info({ ownerId: row.ownerId, subscriptionId, type: event.event }, "WEBHOOK_PROCESSED");
}
