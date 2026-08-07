import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db, subscriptionsTable, paymentsTable, ownersTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";
import { stripe, PLANS, planById, ESTATE_ADDON, MANAGER_DEVICE_ADDON, inlinePrice } from "../lib/stripe";
import { logger } from "../lib/logger";
import type Stripe from "stripe";

const router: IRouter = Router();

// Where Stripe Checkout sends the farmer back after payment. Point this at
// whatever domain is actually serving the app.
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://thechiguru.com";

const SHARE_PLATFORMS = ["whatsapp", "facebook", "x", "telegram", "other"];
const SHARE_TARGET = 3;

async function latestSubscription(ownerId: number) {
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.ownerId, ownerId))
    .orderBy(desc(subscriptionsTable.id))
    .limit(1);
  return sub ?? null;
}

async function getOrCreateStripeCustomer(ownerId: number, email: string | null): Promise<string> {
  const existing = await latestSubscription(ownerId);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { ownerId: String(ownerId) },
  });
  return customer.id;
}

router.get("/subscription/plans", (_req, res) => {
  res.json({ plans: Object.values(PLANS), estateAddon: ESTATE_ADDON, managerDeviceAddon: MANAGER_DEVICE_ADDON });
});

router.get("/subscription", requireOwner, async (req, res) => {
  const sub = await latestSubscription(req.owner!.id);
  res.json({
    subscription: sub,
    sharePlatforms: req.owner!.sharePlatforms,
    shareRewardClaimedAt: req.owner!.shareRewardClaimedAt,
    freeMonthPending: req.owner!.freeMonthPending,
  });
});

router.get("/payments", requireOwner, async (req, res) => {
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.ownerId, req.owner!.id))
    .orderBy(desc(paymentsTable.createdAt));
  res.json(rows);
});

// Owner picks a plan — new subscription, upgrade, or downgrade all go through
// the same Checkout Session; which one it is doesn't matter until the webhook
// confirms payment and we activate it. A share-to-earn reward earned while not
// yet subscribed rides along as a 30-day trial on this same checkout.
router.post("/subscription/checkout", requireOwner, async (req, res) => {
  const { planId } = req.body as { planId?: string };
  const plan = planId ? planById(planId) : undefined;
  if (!plan) {
    res.status(400).json({ message: "Unknown plan", code: "INVALID_PLAN" });
    return;
  }

  const customerId = await getOrCreateStripeCustomer(req.owner!.id, req.owner!.email);
  const freeMonthPending = req.owner!.freeMonthPending;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price_data: inlinePrice(plan.amount, `Chiguru ${plan.name} plan`), quantity: 1 }],
    subscription_data: freeMonthPending ? { trial_period_days: 30 } : undefined,
    success_url: `${APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/subscription`,
    metadata: { ownerId: String(req.owner!.id), kind: "plan", planId: plan.id },
  });

  res.json({ url: session.url });
});

// Extra estate on top of the plan's bundled allowance — its own Stripe
// subscription line so it renews independently of the main plan.
router.post("/subscription/estate-addon/checkout", requireOwner, async (req, res) => {
  const customerId = await getOrCreateStripeCustomer(req.owner!.id, req.owner!.email);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price_data: inlinePrice(ESTATE_ADDON.amount, "Chiguru estate add-on"), quantity: 1 }],
    success_url: `${APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/subscription`,
    metadata: { ownerId: String(req.owner!.id), kind: "estate_addon" },
  });

  res.json({ url: session.url });
});

// Extra manager device on top of the plan's bundled allowance.
router.post("/subscription/device-addon/checkout", requireOwner, async (req, res) => {
  const customerId = await getOrCreateStripeCustomer(req.owner!.id, req.owner!.email);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price_data: inlinePrice(MANAGER_DEVICE_ADDON.amount, "Chiguru manager device add-on"), quantity: 1 }],
    success_url: `${APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/subscription`,
    metadata: { ownerId: String(req.owner!.id), kind: "device_addon" },
  });

  res.json({ url: session.url });
});

// Share on 3 different apps → 1 month free. Recorded one platform at a time;
// once 3 distinct platforms have been shared and the reward hasn't already
// been claimed, it's granted immediately — as a Stripe balance credit if
// already subscribed (offsets the next invoice), or as a pending flag that
// turns the NEXT plan checkout into a 30-day free trial otherwise.
router.post("/subscription/share", requireOwner, async (req, res) => {
  const { platform } = req.body as { platform?: string };
  if (!platform || !SHARE_PLATFORMS.includes(platform)) {
    res.status(400).json({ message: "Unknown share platform", code: "INVALID_PLATFORM" });
    return;
  }

  const owner = req.owner!;
  const shared = new Set((owner.sharePlatforms ?? "").split(",").filter(Boolean));
  shared.add(platform);
  const sharePlatforms = Array.from(shared).join(",");

  let rewardGranted = false;
  const updates: Partial<typeof owner> = { sharePlatforms };

  if (!owner.shareRewardClaimedAt && shared.size >= SHARE_TARGET) {
    const sub = await latestSubscription(owner.id);
    if (sub?.status === "active" && sub.stripeCustomerId) {
      const plan = Object.values(PLANS).find((p) => p.name === sub.planName);
      const amount = plan?.amount ?? Number(sub.amount);
      try {
        await stripe.customers.createBalanceTransaction(sub.stripeCustomerId, {
          amount: -Math.round(amount * 100),
          currency: "inr",
          description: "Chiguru share-to-earn reward: 1 month free",
        });
      } catch (err) {
        logger.error({ err, ownerId: owner.id }, "Failed to apply share-to-earn balance credit");
        res.status(502).json({ message: "Couldn't apply your reward right now — try again shortly.", code: "REWARD_FAILED" });
        return;
      }
    } else {
      updates.freeMonthPending = true;
    }
    updates.shareRewardClaimedAt = new Date();
    rewardGranted = true;
  }

  const [updated] = await db.update(ownersTable).set(updates).where(eq(ownersTable.id, owner.id)).returning();
  res.json({
    sharePlatforms: updated.sharePlatforms,
    shareRewardClaimedAt: updated.shareRewardClaimedAt,
    freeMonthPending: updated.freeMonthPending,
    rewardGranted,
  });
});

router.post("/subscription/cancel-autorenew", requireOwner, async (req, res) => {
  const sub = await latestSubscription(req.owner!.id);
  if (!sub?.stripeSubscriptionId) {
    res.status(404).json({ message: "No active subscription", code: "NO_SUBSCRIPTION" });
    return;
  }
  await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  res.json({ ok: true });
});

export default router;

// ── Stripe webhook ────────────────────────────────────────────────────────
// Mounted separately in app.ts with express.raw() BEFORE the global
// express.json(), since Stripe's signature check needs the exact raw body
// bytes. This is the ONLY place a subscription is ever marked "active" —
// never trust the Checkout success redirect on its own.
export async function stripeWebhookHandler(req: Request, res: Response) {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    res.status(400).send("Missing signature or webhook secret");
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    logger.warn({ err }, "Stripe webhook signature verification failed");
    res.status(400).send("Invalid signature");
    return;
  }

  logger.info({ type: event.type }, "Stripe webhook received");

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, type: event.type }, "Failed processing Stripe webhook");
    // Still 200 — Stripe would otherwise retry indefinitely on a bug we need
    // to fix server-side, not something a retry can resolve.
  }

  res.json({ received: true });
}

function addOneMonth(from: Date): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const ownerId = Number(session.metadata?.ownerId);
  const kind = session.metadata?.kind;
  if (!ownerId) return;

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const stripeSubscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  if (kind === "plan") {
    const plan = planById(session.metadata?.planId ?? "");
    if (!plan) return;
    const now = new Date();
    const existing = await latestSubscription(ownerId);

    if (existing) {
      await db
        .update(subscriptionsTable)
        .set({
          planName: plan.name,
          amount: String(plan.amount),
          status: "active",
          stripeCustomerId: customerId ?? existing.stripeCustomerId,
          stripeSubscriptionId: stripeSubscriptionId ?? existing.stripeSubscriptionId,
          startDate: now.toISOString().slice(0, 10),
          renewalDate: addOneMonth(now),
          managerSeats: plan.maxManagerDevices,
          updatedAt: now,
        })
        .where(eq(subscriptionsTable.id, existing.id));
    } else {
      await db.insert(subscriptionsTable).values({
        ownerId,
        planName: plan.name,
        billingCycle: "monthly",
        amount: String(plan.amount),
        currency: "INR",
        status: "active",
        stripeCustomerId: customerId,
        stripeSubscriptionId,
        startDate: now.toISOString().slice(0, 10),
        renewalDate: addOneMonth(now),
        managerSeats: plan.maxManagerDevices,
      });
    }
    // The free-month reward (if any) was consumed as this checkout's trial.
    await db.update(ownersTable).set({ freeMonthPending: false }).where(eq(ownersTable.id, ownerId));
  } else if (kind === "estate_addon") {
    const existing = await latestSubscription(ownerId);
    if (existing) {
      await db
        .update(subscriptionsTable)
        .set({ extraEstates: existing.extraEstates + 1, updatedAt: new Date() })
        .where(eq(subscriptionsTable.id, existing.id));
    }
  } else if (kind === "device_addon") {
    const existing = await latestSubscription(ownerId);
    if (existing) {
      await db
        .update(subscriptionsTable)
        .set({ managerSeats: existing.managerSeats + 1, updatedAt: new Date() })
        .where(eq(subscriptionsTable.id, existing.id));
    }
  }

  const sub = await latestSubscription(ownerId);
  const amount = (session.amount_total ?? 0) / 100;
  await db
    .insert(paymentsTable)
    .values({
      ownerId,
      subscriptionId: sub?.id ?? null,
      // Subscription-mode Checkout Sessions carry the charge on the invoice,
      // not the session — the session id is still a stable, unique reference
      // Stripe won't reuse, so it's what dedupes a retried webhook delivery.
      stripePaymentIntent: session.id,
      amount: String(amount),
      currency: (session.currency ?? "inr").toUpperCase(),
      paymentStatus: "succeeded",
      paymentMethod: "card",
      invoiceNumber: session.id,
    })
    .onConflictDoNothing();
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subId) return;
  await db
    .update(subscriptionsTable)
    .set({ status: "active", renewalDate: addOneMonth(new Date()), updatedAt: new Date() })
    .where(eq(subscriptionsTable.stripeSubscriptionId, subId));
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subId) return;
  await db
    .update(subscriptionsTable)
    .set({ status: "past_due", updatedAt: new Date() })
    .where(eq(subscriptionsTable.stripeSubscriptionId, subId));
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  await db
    .update(subscriptionsTable)
    .set({ status: subscription.status, updatedAt: new Date() })
    .where(eq(subscriptionsTable.stripeSubscriptionId, subscription.id));
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  await db
    .update(subscriptionsTable)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(subscriptionsTable.stripeSubscriptionId, subscription.id));
}
