import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db, paymentsTable, subscriptionPlansTable, ownersTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";
import {
  getCurrentSubscription,
  getPlan,
  getManagerLimit,
  getManagersUsed,
  getRemainingManagerSeats,
} from "../services/entitlement.service";
import {
  listActivePlans,
  createRazorpaySubscription,
  verifyAndActivate,
  verifyAndActivateGooglePlay,
  cancel,
  handleWebhookEvent,
  handleGooglePlayNotification,
  SubscriptionServiceError,
} from "../services/subscription.service";
import { verifyWebhookSignature, createOneTimeOrder, verifyOrderPaymentSignature, RAZORPAY_KEY_ID } from "../lib/razorpay";
import { logger } from "../lib/logger";

// One-time price for a permanent +1 manager seat add-on — never expires,
// unlike a subscription. Fixed (not user-entered) since this buys exactly
// one seat.
const MANAGER_SEAT_ADDON_PRICE = 199;

const router: IRouter = Router();

function sendServiceError(res: Response, err: unknown) {
  if (err instanceof SubscriptionServiceError) {
    res.status(err.status).json({ message: err.message, code: err.code });
    return;
  }
  logger.error({ err }, "Unhandled subscription error");
  res.status(500).json({ message: "Something went wrong. Please try again." });
}

// GET /api/subscriptions/plans — public, DB-driven, no secrets.
// googlePlayProductId IS included (unlike razorpayPlanId) because the
// Android app needs it to call Play Billing's requestSubscription() itself —
// there's no server-side "create" step for Play purchases the way there is
// for Razorpay, so the client has to already know the product id up front.
router.get("/subscriptions/plans", async (_req, res) => {
  const plans = await listActivePlans();
  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: Number(p.price),
      currency: p.currency,
      billingPeriod: p.billingPeriod,
      managerLimit: p.managerLimit,
      googlePlayProductId: p.googlePlayProductId,
    })),
  });
});

// GET /api/subscriptions/me — Owner derived from the verified Firebase token only.
router.get("/subscriptions/me", requireOwner, async (req, res) => {
  const ownerId = req.owner!.id;
  const [sub, plan, managerLimit, managersUsed, remainingManagers, [owner]] = await Promise.all([
    getCurrentSubscription(ownerId),
    getPlan(ownerId),
    getManagerLimit(ownerId),
    getManagersUsed(ownerId),
    getRemainingManagerSeats(ownerId),
    db.select({ extraManagerSeats: ownersTable.extraManagerSeats }).from(ownersTable).where(eq(ownersTable.id, ownerId)),
  ]);

  res.json({
    subscription: sub
      ? {
          status: sub.status,
          platform: sub.platform,
          provider: sub.provider,
          startDate: sub.startDate,
          expiryDate: sub.expiryDate,
          autoRenew: sub.autoRenew,
          cancelledAt: sub.cancelledAt,
          plan: plan ? { id: plan.id, name: plan.name, managerLimit: plan.managerLimit, price: Number(plan.price) } : null,
        }
      : null,
    entitlement: {
      managerLimit,
      managersUsed,
      remainingManagers,
      extraManagerSeats: owner?.extraManagerSeats ?? 0,
      managerSeatAddonPrice: MANAGER_SEAT_ADDON_PRICE,
    },
  });
});

/** Step 1 of a manager-seat add-on purchase: create the fixed-price Razorpay order the client's checkout.js opens. */
router.post("/subscriptions/manager-seat-addon/order", requireOwner, async (req, res) => {
  const order = await createOneTimeOrder(MANAGER_SEAT_ADDON_PRICE, req.owner!.id, "manager_seat_addon");
  res.json({ ...order, keyId: RAZORPAY_KEY_ID });
});

/**
 * Step 2: verify the signature, then permanently add +1 manager seat.
 * Idempotent via payments.provider_payment_id's unique constraint — a
 * retried verify call with the same Razorpay payment id can never
 * double-credit a seat.
 */
router.post("/subscriptions/manager-seat-addon/verify", requireOwner, async (req, res) => {
  const { orderId, paymentId, signature } = req.body as { orderId?: string; paymentId?: string; signature?: string };
  if (!orderId || !paymentId || !signature) {
    res.status(400).json({ message: "orderId, paymentId and signature are required", code: "INVALID_REQUEST" });
    return;
  }
  const valid = verifyOrderPaymentSignature(orderId, paymentId, signature);
  if (!valid) {
    res.status(400).json({ message: "Payment verification failed", code: "VERIFICATION_FAILED" });
    return;
  }

  const ownerId = req.owner!.id;
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(eq(paymentsTable.providerPaymentId, paymentId))
      .limit(1);

    const [owner] = await tx
      .select({ extraManagerSeats: ownersTable.extraManagerSeats })
      .from(ownersTable)
      .where(eq(ownersTable.id, ownerId))
      .for("update");

    if (existing[0]) return { extraManagerSeats: owner?.extraManagerSeats ?? 0, duplicate: true };

    const [updated] = await tx
      .update(ownersTable)
      .set({ extraManagerSeats: (owner?.extraManagerSeats ?? 0) + 1, updatedAt: new Date() })
      .where(eq(ownersTable.id, ownerId))
      .returning({ extraManagerSeats: ownersTable.extraManagerSeats });

    await tx.insert(paymentsTable).values({
      ownerId,
      provider: "RAZORPAY",
      providerPaymentId: paymentId,
      amount: String(MANAGER_SEAT_ADDON_PRICE),
      paymentStatus: "succeeded",
      paymentDate: new Date(),
    });

    return { extraManagerSeats: updated.extraManagerSeats, duplicate: false };
  });

  res.json({ ok: true, ...result });
});

// POST /api/subscriptions/razorpay/create — body {planId} only. Everything
// else the client might try to send (price, razorpayPlanId, ownerId) is
// never read from the request.
router.post("/subscriptions/razorpay/create", requireOwner, async (req, res) => {
  const { planId } = req.body as { planId?: number };
  if (typeof planId !== "number") {
    res.status(400).json({ message: "planId is required", code: "INVALID_REQUEST" });
    return;
  }
  try {
    const result = await createRazorpaySubscription(req.owner!.id, planId);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err);
  }
});

// POST /api/subscriptions/razorpay/verify — verifies signature + re-fetches
// authoritative subscription state from Razorpay before touching the DB.
router.post("/subscriptions/razorpay/verify", requireOwner, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body as {
    razorpay_payment_id?: string;
    razorpay_subscription_id?: string;
    razorpay_signature?: string;
  };
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    res.status(400).json({ message: "Missing payment verification fields", code: "INVALID_REQUEST" });
    return;
  }
  try {
    const sub = await verifyAndActivate(req.owner!.id, {
      paymentId: razorpay_payment_id,
      subscriptionId: razorpay_subscription_id,
      signature: razorpay_signature,
    });
    res.json({ status: sub.status });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// POST /api/subscriptions/android/verify — body {purchaseToken, productId}.
// Mirrors /subscriptions/razorpay/verify's "never trust the client" shape:
// the token is re-checked against Google's own API before anything is
// written, same as Razorpay's signature+fetch re-check above.
router.post("/subscriptions/android/verify", requireOwner, async (req, res) => {
  const { purchaseToken, productId } = req.body as { purchaseToken?: string; productId?: string };
  if (!purchaseToken || !productId) {
    res.status(400).json({ message: "purchaseToken and productId are required", code: "INVALID_REQUEST" });
    return;
  }
  try {
    const sub = await verifyAndActivateGooglePlay(req.owner!.id, { purchaseToken, productId });
    res.json({ status: sub.status });
  } catch (err) {
    sendServiceError(res, err);
  }
});

router.post("/subscriptions/cancel", requireOwner, async (req, res) => {
  try {
    const sub = await cancel(req.owner!.id);
    res.json({ status: sub.status, expiryDate: sub.expiryDate });
  } catch (err) {
    sendServiceError(res, err);
  }
});

router.get("/payments", requireOwner, async (req, res) => {
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.ownerId, req.owner!.id))
    .orderBy(desc(paymentsTable.createdAt));
  res.json(rows);
});

// Admin/debug convenience — not part of the spec's endpoint list, but useful
// while there is no dashboard yet for editing subscription_plans directly.
router.get("/subscriptions/plans/all", requireOwner, async (_req, res) => {
  res.json(await db.select().from(subscriptionPlansTable).orderBy(subscriptionPlansTable.price));
});

export default router;

// ── Razorpay webhook ─────────────────────────────────────────────────────────
// Mounted separately in app.ts with express.raw() BEFORE the global
// express.json(), since the signature check needs the exact raw request
// bytes. This is the only place a subscription is activated/renewed/
// cancelled from a source Razorpay itself confirms — never from the
// frontend's own claim that checkout succeeded.
export async function razorpayWebhookHandler(req: Request, res: Response) {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = (req.body as Buffer).toString("utf8");

  if (typeof signature !== "string" || !verifyWebhookSignature(rawBody, signature)) {
    logger.warn("Razorpay webhook signature verification failed");
    res.status(400).send("Invalid signature");
    return;
  }

  try {
    await handleWebhookEvent(rawBody, req.headers["x-razorpay-event-id"] as string | undefined);
  } catch (err) {
    logger.error({ err }, "Failed processing Razorpay webhook");
    // Still 200 — Razorpay would otherwise retry indefinitely on a bug that
    // needs a server-side fix, not something a retry can resolve.
  }

  res.json({ received: true });
}

// ── Google Play RTDN webhook ─────────────────────────────────────────────────
// Cloud Pub/Sub push subscriptions have no signature header like Razorpay's —
// the standard way to secure one is a secret token in the endpoint URL itself
// (set this same value as the push subscription's URL query string in Google
// Cloud Console, e.g. .../webhooks/google-play?token=...). Mounted with
// express.json() like any normal route (no raw-body signature check needed).
export async function googlePlayWebhookHandler(req: Request, res: Response) {
  if (!process.env.GOOGLE_PLAY_WEBHOOK_TOKEN || req.query.token !== process.env.GOOGLE_PLAY_WEBHOOK_TOKEN) {
    logger.warn("Google Play webhook token verification failed");
    res.status(400).send("Invalid token");
    return;
  }

  try {
    await handleGooglePlayNotification(JSON.stringify(req.body));
  } catch (err) {
    logger.error({ err }, "Failed processing Google Play webhook");
    // Still 200 — Pub/Sub would otherwise retry indefinitely on a bug that
    // needs a server-side fix, not something a retry can resolve.
  }

  res.json({ received: true });
}
