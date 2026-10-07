import { Router, type IRouter } from "express";
import { requireOwner } from "../middlewares/firebaseAuth";
import { MIN_RECHARGE_AMOUNT, AI_PRICES, getWalletState, getWalletHistory, creditWallet } from "../lib/wallet";
import { createOneTimeOrder, confirmOneTimePayment, OneTimePaymentError, RAZORPAY_KEY_ID } from "../lib/razorpay";
import { db, paymentsTable } from "../db";
import { eq } from "drizzle-orm";
import { verifyAppleTransaction, applePaymentKey, APPLE_WALLET_PACKS, AppleVerificationError } from "../lib/apple";

const router: IRouter = Router();

/**
 * Wallet — per-use AI feature credit, on top of (not instead of) the
 * Owner's subscription. Recharges are real Razorpay one-time orders,
 * verified the same way subscription checkout is verified (see
 * lib/razorpay.ts) — never self-reported.
 */

router.get("/wallet", requireOwner, async (req, res) => {
  const ownerId = req.owner!.id;
  const [state, history] = await Promise.all([getWalletState(ownerId), getWalletHistory(ownerId)]);
  res.json({
    balance: state.balance,
    minRechargeAmount: MIN_RECHARGE_AMOUNT,
    // iPhone recharges go through Apple In-App Purchase as fixed packs.
    applePacks: Object.entries(APPLE_WALLET_PACKS).map(([productId, amount]) => ({ productId, amount })),
    aiPrices: Object.fromEntries(Object.entries(AI_PRICES).map(([k, v]) => [k, { price: v.price, label: v.label }])),
    ...history,
  });
});

/** Step 1 of a recharge: create the Razorpay order the client's checkout.js opens. */
router.post("/wallet/recharge/order", requireOwner, async (req, res) => {
  const { amount } = req.body as { amount?: number };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < MIN_RECHARGE_AMOUNT) {
    res.status(400).json({ message: `amount must be at least ₹${MIN_RECHARGE_AMOUNT}`, code: "INVALID_AMOUNT" });
    return;
  }
  const order = await createOneTimeOrder(amt, req.owner!.id, "wallet_recharge");
  res.json({ ...order, keyId: RAZORPAY_KEY_ID });
});

/** Step 2 of a recharge: verify the signature Razorpay's checkout.js returns, then credit the wallet. */
router.post("/wallet/recharge/verify", requireOwner, async (req, res) => {
  // `amount` from the client is ignored: what's credited is what Razorpay
  // says was actually paid for this Owner's recharge order.
  const { orderId, paymentId, signature } = req.body as { orderId?: string; paymentId?: string; signature?: string };
  if (!orderId || !paymentId || !signature) {
    res.status(400).json({ message: "orderId, paymentId and signature are required", code: "INVALID_REQUEST" });
    return;
  }
  const ownerId = req.owner!.id;
  let amount: number;
  try {
    ({ amountRupees: amount } = await confirmOneTimePayment({ orderId, paymentId, signature, ownerId, purpose: "wallet_recharge" }));
  } catch (err) {
    if (err instanceof OneTimePaymentError) {
      res.status(400).json({ message: err.message, code: err.code });
      return;
    }
    throw err;
  }
  // One payment, one credit, one Owner: the payments row is unique per
  // Razorpay payment id across every account.
  await db
    .insert(paymentsTable)
    .values({ ownerId, provider: "RAZORPAY", providerPaymentId: paymentId, amount: String(amount), paymentStatus: "succeeded", paymentDate: new Date() })
    .onConflictDoNothing();
  const [payment] = await db.select({ ownerId: paymentsTable.ownerId }).from(paymentsTable).where(eq(paymentsTable.providerPaymentId, paymentId));
  if (payment && payment.ownerId !== ownerId) {
    res.status(409).json({ message: "This payment was already used on another account.", code: "PURCHASE_ALREADY_USED" });
    return;
  }
  const result = await creditWallet({ ownerId, type: "recharge", amount, clientId: paymentId });
  res.json({ ok: true, balance: result.balance, duplicate: result.duplicate });
});

/**
 * iPhone recharge: body {signedTransaction} — the StoreKit 2 JWS for a
 * wallet-pack consumable. The credited amount comes from our own pack table
 * keyed by Apple's verified productId, never from the client. A payments row
 * keyed apple:<transactionId> makes one Apple purchase credit at most one
 * Owner, and creditWallet's clientId makes retries a no-op.
 */
router.post("/wallet/apple/verify", requireOwner, async (req, res) => {
  const { signedTransaction } = req.body as { signedTransaction?: string };
  const ownerId = req.owner!.id;
  try {
    const tx = await verifyAppleTransaction(signedTransaction ?? "");
    const amount = tx.productId ? APPLE_WALLET_PACKS[tx.productId] : undefined;
    if (!amount || !tx.transactionId || tx.revocationDate) {
      res.status(422).json({ message: "This purchase isn't a Chiguru wallet pack.", code: "NOT_A_WALLET_PACK" });
      return;
    }
    const key = applePaymentKey(tx.transactionId);
    await db
      .insert(paymentsTable)
      .values({ ownerId, provider: "APPLE", providerPaymentId: key, amount: String(amount), paymentStatus: "succeeded", paymentDate: new Date() })
      .onConflictDoNothing();
    const [payment] = await db.select({ ownerId: paymentsTable.ownerId }).from(paymentsTable).where(eq(paymentsTable.providerPaymentId, key));
    if (payment && payment.ownerId !== ownerId) {
      res.status(409).json({ message: "This purchase was already used on another account.", code: "PURCHASE_ALREADY_USED" });
      return;
    }
    const result = await creditWallet({ ownerId, type: "recharge", amount, clientId: key });
    res.json({ ok: true, balance: result.balance, duplicate: result.duplicate });
  } catch (err) {
    if (err instanceof AppleVerificationError) {
      res.status(err.status).json({ message: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

export default router;
