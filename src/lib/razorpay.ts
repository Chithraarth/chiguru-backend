import Razorpay from "razorpay";
import { validateWebhookSignature, validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";
import { eq } from "drizzle-orm";
import { db, subscriptionPlansTable, type SubscriptionPlan } from "../db";

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set. Did you forget to provision Razorpay?");
}

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/** Public — safe to send to the frontend for checkout.js. */
export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;

// A monthly plan billed "until cancelled" still needs a total_count in
// Razorpay's model, since it has no true "forever" value — Razorpay's own
// checkout displays this as "charges every month until <the resulting end
// date>", so a very large count (e.g. 100 years) reads as alarming to a real
// subscriber even though it's harmless (they can cancel anytime well before
// then). Capped at a few years instead — long enough nobody realistically
// hits the limit, short enough the checkout's own date doesn't look wrong.
const TOTAL_COUNT_BY_PERIOD: Record<string, number> = {
  monthly: 48, // 4 years
  yearly: 4,
};

/**
 * Razorpay Plans are created via API, not pre-provisioned in a dashboard like
 * Stripe Prices. This lazily creates one the first time a plan is actually
 * sold and caches the id on our own subscription_plans row, so later calls
 * never hit Razorpay's API again for the same plan.
 */
export async function ensureRazorpayPlanId(plan: SubscriptionPlan): Promise<string> {
  if (plan.razorpayPlanId) return plan.razorpayPlanId;

  const created = await razorpay.plans.create({
    period: plan.billingPeriod === "yearly" ? "yearly" : "monthly",
    interval: 1,
    item: {
      name: `Chiguru ${plan.name} plan`,
      amount: Math.round(Number(plan.price) * 100),
      currency: plan.currency,
    },
    notes: { planId: String(plan.id) },
  });

  await db
    .update(subscriptionPlansTable)
    .set({ razorpayPlanId: created.id, updatedAt: new Date() })
    .where(eq(subscriptionPlansTable.id, plan.id));

  return created.id;
}

export function totalCountForPeriod(billingPeriod: string): number {
  return TOTAL_COUNT_BY_PERIOD[billingPeriod] ?? TOTAL_COUNT_BY_PERIOD.monthly;
}

/** Verifies the {razorpay_payment_id, razorpay_subscription_id, razorpay_signature} the frontend sends back after checkout.js completes. Uses the account's key secret — NOT the webhook secret. */
export function verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
  return validatePaymentVerification(
    { payment_id: paymentId, subscription_id: subscriptionId },
    signature,
    process.env.RAZORPAY_KEY_SECRET!,
  );
}

/** One-time order (e.g. a wallet recharge or a manager-seat add-on) — creates the Razorpay order the client's checkout.js opens. */
export async function createOneTimeOrder(amountRupees: number, ownerId: number, purpose: string): Promise<{ orderId: string; amount: number; currency: string }> {
  const order = await razorpay.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: "INR",
    notes: { ownerId: String(ownerId), purpose },
  });
  return { orderId: order.id, amount: amountRupees, currency: order.currency };
}

/** Verifies the {razorpay_order_id, razorpay_payment_id, razorpay_signature} the frontend sends back after a one-time order (e.g. wallet recharge) completes. Payload order differs from the subscription case — order_id + "|" + payment_id. */
export function verifyOrderPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  return validatePaymentVerification(
    { order_id: orderId, payment_id: paymentId },
    signature,
    process.env.RAZORPAY_KEY_SECRET!,
  );
}

export class OneTimePaymentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Confirms a one-time order payment with Razorpay itself before anything is
 * credited: the signature only proves *a* payment happened, so we also check
 * the payment belongs to this order, actually went through, and the order was
 * created for this Owner and this purpose. Returns the rupees really paid, so
 * the amount never comes from the client.
 */
export async function confirmOneTimePayment(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  ownerId: number;
  purpose: string;
}): Promise<{ amountRupees: number }> {
  if (!verifyOrderPaymentSignature(params.orderId, params.paymentId, params.signature)) {
    throw new OneTimePaymentError("VERIFICATION_FAILED", "Payment verification failed");
  }
  const [payment, order] = await Promise.all([
    razorpay.payments.fetch(params.paymentId),
    razorpay.orders.fetch(params.orderId),
  ]);
  if (payment.order_id !== params.orderId || !["captured", "authorized"].includes(String(payment.status))) {
    throw new OneTimePaymentError("PAYMENT_NOT_COMPLETED", "This payment has not gone through.");
  }
  const notes = (order.notes ?? {}) as Record<string, unknown>;
  if (String(notes.ownerId) !== String(params.ownerId) || notes.purpose !== params.purpose) {
    throw new OneTimePaymentError("ORDER_MISMATCH", "This payment doesn't belong to this account or purchase.");
  }
  return { amountRupees: Number(payment.amount) / 100 };
}

/** Verifies the X-Razorpay-Signature header on an incoming webhook against the raw request body. Uses the separate webhook secret — NOT the key secret. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  return validateWebhookSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET);
}
