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
import { fetchSubscriptionState, acknowledgePurchase, decodePubSubMessage } from "../lib/google-play";
import { getCurrentSubscription, isSubStatusActiveLike, getManagersUsed } from "./entitlement.service";
import { logger } from "../lib/logger";
import { verifyAppleTransaction, verifyAppleNotification, verifyAppleRenewalInfo, applePaymentKey } from "../lib/apple";

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

  // Block a switch to a plan smaller than the manager seats already in use —
  // the owner would otherwise be left over the new plan's limit with no
  // guidance on which managers to remove. Checked here (before Razorpay is
  // even involved) rather than at activation time, so the owner sees this
  // before paying, not after.
  const managersUsed = await getManagersUsed(ownerId);
  if (managersUsed > plan.managerLimit) {
    throw new SubscriptionServiceError(
      409,
      "PLAN_TOO_SMALL",
      `You have ${managersUsed} managers, but this plan only allows ${plan.managerLimit}. Remove some managers first or choose a larger plan.`,
    );
  }

  const razorpayPlanId = await ensureRazorpayPlanId(plan);

  const razorpaySub = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    customer_notify: 1,
    total_count: totalCountForPeriod(plan.billingPeriod),
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

  logger.info({ ownerId, subscriptionId: params.subscriptionId }, "SUBSCRIPTION_ACTIVATED");
  return updated;
}

export async function cancel(ownerId: number): Promise<Subscription> {
  const sub = await getCurrentSubscription(ownerId);
  if (!sub || !sub.providerSubscriptionId || !isSubStatusActiveLike(sub.status)) {
    throw new SubscriptionServiceError(404, "NO_ACTIVE_SUBSCRIPTION", "No active subscription to cancel.");
  }

  if (sub.provider === "APPLE") {
    // Apple subscriptions can only be cancelled by the subscriber in their
    // Apple account settings; the App Store notification updates our row.
    throw new SubscriptionServiceError(409, "MANAGE_VIA_APPLE", "Manage this subscription from your Apple account (Settings → your name → Subscriptions).");
  }

  if (sub.provider === "GOOGLE_PLAY") {
    // Google's own guidance: don't cancel on the user's behalf via the
    // Developer API — send them to Play Store's subscription management UI,
    // which handles proration/refund correctly. The RTDN webhook (see
    // handleGooglePlayNotification) is what actually updates our row once
    // they cancel there.
    throw new SubscriptionServiceError(
      409,
      "MANAGE_VIA_GOOGLE_PLAY",
      "Manage this subscription from Google Play — it wasn't started through this screen.",
    );
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

/**
 * Verifies a Google Play purchase token server-side (never trusts the
 * client's own claim of success) and activates/updates the subscription row.
 * Unlike Razorpay, there's no separate "create" step before purchase — the
 * app buys directly through Play Billing, then hands us the resulting token.
 */
export async function verifyAndActivateGooglePlay(
  ownerId: number,
  params: { purchaseToken: string; productId: string },
): Promise<Subscription> {
  const [plan] = await db
    .select()
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.googlePlayProductId, params.productId));
  if (!plan) {
    throw new SubscriptionServiceError(404, "PLAN_NOT_FOUND", "No plan matches this Google Play product.");
  }

  const state = await fetchSubscriptionState(params.purchaseToken);
  if (state.status !== "ACTIVE" && state.status !== "GRACE_PERIOD") {
    throw new SubscriptionServiceError(422, "SUBSCRIPTION_NOT_ACTIVE", `Google Play reports this subscription as "${state.status}".`);
  }

  try {
    await acknowledgePurchase(params.purchaseToken, params.productId);
  } catch (err) {
    // Already-acknowledged purchases (e.g. a retry after a crash) throw here
    // — not a reason to fail activation, just log and continue.
    logger.info({ err, ownerId }, "Google Play acknowledge skipped (likely already acknowledged)");
  }

  const existing = await getCurrentSubscription(ownerId);
  const isSameSubscription = existing?.providerSubscriptionId === params.purchaseToken;

  const [row] = isSameSubscription
    ? await db
        .update(subscriptionsTable)
        .set({
          status: state.status,
          planId: plan.id,
          providerPlanId: state.productId,
          expiryDate: state.expiryTime,
          autoRenew: state.autoRenewing,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionsTable.id, existing.id))
        .returning()
    : await db
        .insert(subscriptionsTable)
        .values({
          ownerId,
          planId: plan.id,
          platform: "ANDROID",
          provider: "GOOGLE_PLAY",
          providerPlanId: state.productId,
          providerSubscriptionId: params.purchaseToken,
          providerPaymentId: state.latestOrderId,
          status: state.status,
          expiryDate: state.expiryTime,
          autoRenew: state.autoRenewing,
        })
        .returning();

  if (state.latestOrderId) {
    await db
      .insert(paymentsTable)
      .values({
        ownerId,
        subscriptionId: row.id,
        provider: "GOOGLE_PLAY",
        providerPaymentId: state.latestOrderId,
        amount: plan.price,
        currency: plan.currency,
        paymentStatus: "succeeded",
        paymentDate: new Date(),
      })
      .onConflictDoNothing();
  }

  logger.info({ ownerId, purchaseToken: params.purchaseToken, status: state.status }, "GOOGLE_PLAY_SUBSCRIPTION_ACTIVATED");
  return row;
}

const GOOGLE_PLAY_EVENT_NAMES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  9: "SUBSCRIPTION_DEFERRED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
};

/**
 * Handles a Real-time Developer Notification pushed via Cloud Pub/Sub.
 * Same idempotency + re-fetch-don't-trust pattern as the Razorpay webhook:
 * the notification only tells us *something* changed for a purchase token —
 * the actual new state is always re-fetched from Google's API before the row
 * is updated.
 */
export async function handleGooglePlayNotification(rawBody: string): Promise<void> {
  const notification = decodePubSubMessage(rawBody);
  const sub = notification?.subscriptionNotification;
  if (!sub) {
    logger.info("GOOGLE_PLAY_WEBHOOK_PROCESSED (no subscription notification, ignored)");
    return;
  }

  const eventId = `${sub.purchaseToken}:${notification.eventTimeMillis}:${sub.notificationType}`;
  const inserted = await db
    .insert(webhookEventsTable)
    .values({ provider: "GOOGLE_PLAY", providerEventId: eventId, eventType: GOOGLE_PLAY_EVENT_NAMES[sub.notificationType] ?? String(sub.notificationType) })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    logger.info({ eventId }, "GOOGLE_PLAY_WEBHOOK_PROCESSED (duplicate, ignored)");
    return;
  }

  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.providerSubscriptionId, sub.purchaseToken));
  if (!row) {
    logger.warn({ purchaseToken: sub.purchaseToken }, "Google Play webhook for unknown purchase token");
    return;
  }

  const state = await fetchSubscriptionState(sub.purchaseToken);
  await db
    .update(subscriptionsTable)
    .set({
      status: state.status,
      expiryDate: state.expiryTime,
      autoRenew: state.autoRenewing,
      cancelledAt: state.status === "CANCELLED" ? new Date() : row.cancelledAt,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.id, row.id));

  logger.info({ ownerId: row.ownerId, purchaseToken: sub.purchaseToken, status: state.status }, "GOOGLE_PLAY_WEBHOOK_PROCESSED");
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

// ── Apple In-App Purchase ────────────────────────────────────────────────────

/**
 * Verifies a StoreKit 2 signed subscription transaction (Apple's signature,
 * never the client's word) and activates/updates the owner's subscription.
 * The subscription is keyed by Apple's originalTransactionId, which stays the
 * same across renewals, so renewals and notifications find the same row.
 */
export async function verifyAndActivateApple(ownerId: number, signedTransaction: string): Promise<Subscription> {
  const tx = await verifyAppleTransaction(signedTransaction);
  if (tx.type !== "Auto-Renewable Subscription" || !tx.productId || !tx.originalTransactionId || !tx.transactionId) {
    throw new SubscriptionServiceError(422, "NOT_A_SUBSCRIPTION", "This purchase isn't a Chiguru subscription.");
  }
  const [plan] = await db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.appleProductId, tx.productId));
  if (!plan) {
    throw new SubscriptionServiceError(404, "PLAN_NOT_FOUND", "No plan matches this App Store product.");
  }

  const expiry = tx.expiresDate ? new Date(tx.expiresDate) : null;
  const active = !tx.revocationDate && !!expiry && expiry.getTime() > Date.now();
  if (!active) {
    throw new SubscriptionServiceError(422, "SUBSCRIPTION_NOT_ACTIVE", "Apple reports this subscription as expired or refunded.");
  }

  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.providerSubscriptionId, tx.originalTransactionId));
  if (existing && existing.ownerId !== ownerId) {
    // One Apple ID's subscription can't unlock two Chiguru accounts.
    throw new SubscriptionServiceError(409, "APPLE_SUBSCRIPTION_IN_USE", "This Apple subscription is already linked to another Chiguru account.");
  }

  const values = {
    planId: plan.id,
    providerPlanId: tx.productId,
    providerPaymentId: tx.transactionId,
    status: "ACTIVE",
    startDate: tx.originalPurchaseDate ? new Date(tx.originalPurchaseDate) : new Date(),
    expiryDate: expiry,
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await db.update(subscriptionsTable).set(values).where(eq(subscriptionsTable.id, existing.id)).returning()
    : await db
        .insert(subscriptionsTable)
        .values({ ...values, ownerId, platform: "IOS", provider: "APPLE", providerSubscriptionId: tx.originalTransactionId, autoRenew: true })
        .returning();

  await db
    .insert(paymentsTable)
    .values({
      ownerId,
      subscriptionId: row.id,
      provider: "APPLE",
      providerPaymentId: applePaymentKey(tx.transactionId),
      amount: plan.price,
      currency: plan.currency,
      paymentStatus: "succeeded",
      paymentDate: tx.purchaseDate ? new Date(tx.purchaseDate) : new Date(),
    })
    .onConflictDoNothing();

  logger.info({ ownerId, originalTransactionId: tx.originalTransactionId, env: tx.verifiedEnv }, "APPLE_SUBSCRIPTION_ACTIVATED");
  return row;
}

/**
 * App Store Server Notifications V2. Verified with Apple's signature, made
 * idempotent by notificationUUID, then the subscription row (found by
 * originalTransactionId) is moved to the state the notification describes.
 */
export async function handleAppleNotification(signedPayload: string): Promise<void> {
  const n = await verifyAppleNotification(signedPayload);
  const eventId = n.notificationUUID ?? crypto.createHash("sha256").update(signedPayload).digest("hex");
  const inserted = await db
    .insert(webhookEventsTable)
    .values({ provider: "APPLE", providerEventId: eventId, eventType: [n.notificationType, n.subtype].filter(Boolean).join(":") })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    logger.info({ eventId }, "APPLE_WEBHOOK_PROCESSED (duplicate, ignored)");
    return;
  }

  const signedTx = n.data?.signedTransactionInfo;
  if (!signedTx) {
    logger.info({ type: n.notificationType }, "APPLE_WEBHOOK_PROCESSED (no transaction, ignored)");
    return;
  }
  const tx = await verifyAppleTransaction(signedTx);
  const renewal = n.data?.signedRenewalInfo ? await verifyAppleRenewalInfo(n.data.signedRenewalInfo) : null;
  if (!tx.originalTransactionId) return;

  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.providerSubscriptionId, tx.originalTransactionId));
  if (!row) {
    // Bought on iOS but never verified by the app yet (e.g. app closed
    // mid-purchase) - the app's verify call creates the row on next launch.
    logger.warn({ originalTransactionId: tx.originalTransactionId, type: n.notificationType }, "Apple webhook for unknown subscription");
    return;
  }

  const type = String(n.notificationType);
  const subtype = n.subtype ? String(n.subtype) : "";
  let status = row.status;
  if (type === "SUBSCRIBED" || type === "DID_RENEW" || type === "OFFER_REDEEMED" || type === "DID_CHANGE_RENEWAL_PREF") status = "ACTIVE";
  else if (type === "DID_FAIL_TO_RENEW") status = subtype === "GRACE_PERIOD" ? "GRACE_PERIOD" : "ON_HOLD";
  else if (type === "GRACE_PERIOD_EXPIRED") status = "ON_HOLD";
  else if (type === "EXPIRED" || type === "REFUND" || type === "REVOKE") status = "EXPIRED";

  await db
    .update(subscriptionsTable)
    .set({
      status,
      expiryDate: tx.expiresDate ? new Date(tx.expiresDate) : row.expiryDate,
      autoRenew: renewal ? renewal.autoRenewStatus === 1 : row.autoRenew,
      cancelledAt: renewal && renewal.autoRenewStatus === 0 && !row.cancelledAt ? new Date() : row.cancelledAt,
      providerPaymentId: tx.transactionId ?? row.providerPaymentId,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.id, row.id));

  if (type === "DID_RENEW" && tx.transactionId) {
    const plan = await getPlanOrThrow(row.planId).catch(() => null);
    if (plan) {
      await db
        .insert(paymentsTable)
        .values({
          ownerId: row.ownerId,
          subscriptionId: row.id,
          provider: "APPLE",
          providerPaymentId: applePaymentKey(tx.transactionId),
          amount: plan.price,
          currency: plan.currency,
          paymentStatus: "succeeded",
          paymentDate: tx.purchaseDate ? new Date(tx.purchaseDate) : new Date(),
        })
        .onConflictDoNothing();
    }
  }

  logger.info({ ownerId: row.ownerId, originalTransactionId: tx.originalTransactionId, type, subtype, status }, "APPLE_WEBHOOK_PROCESSED");
}
