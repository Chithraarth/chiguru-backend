import { Router, type IRouter } from "express";
import { requireOwner } from "../middlewares/firebaseAuth";
import { MIN_RECHARGE_AMOUNT, SHARE_TARGET, AI_PRICES, getWalletState, getWalletHistory, creditWallet, recordShare } from "../lib/wallet";
import { createOneTimeOrder, verifyOrderPaymentSignature, RAZORPAY_KEY_ID } from "../lib/razorpay";

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
    aiPrices: Object.fromEntries(Object.entries(AI_PRICES).map(([k, v]) => [k, { price: v.price, label: v.label }])),
    share: {
      target: SHARE_TARGET,
      reward: 300,
      platforms: state.sharePlatforms,
      rewarded: state.shareRewardClaimedAt != null,
    },
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
  const { orderId, paymentId, signature, amount } = req.body as {
    orderId?: string; paymentId?: string; signature?: string; amount?: number;
  };
  const amt = Number(amount);
  if (!orderId || !paymentId || !signature || !Number.isFinite(amt) || amt < MIN_RECHARGE_AMOUNT) {
    res.status(400).json({ message: "orderId, paymentId, signature and a valid amount are required", code: "INVALID_REQUEST" });
    return;
  }
  const valid = verifyOrderPaymentSignature(orderId, paymentId, signature);
  if (!valid) {
    res.status(400).json({ message: "Payment verification failed", code: "VERIFICATION_FAILED" });
    return;
  }
  const result = await creditWallet({
    ownerId: req.owner!.id,
    type: "recharge",
    amount: amt,
    clientId: paymentId, // Razorpay's payment id is already globally unique — a retried verify call can never double-credit.
  });
  res.json({ ok: true, balance: result.balance, duplicate: result.duplicate });
});

/** Share-to-earn: 3 different platforms → one-time ₹300 wallet credit. */
router.post("/wallet/share", requireOwner, async (req, res) => {
  const { platform } = req.body as { platform?: string };
  const allowed = ["whatsapp", "facebook", "instagram", "x", "telegram"];
  const p = String(platform ?? "").toLowerCase();
  if (!allowed.includes(p)) {
    res.status(400).json({ message: `platform must be one of: ${allowed.join(", ")}`, code: "INVALID_PLATFORM" });
    return;
  }
  const result = await recordShare(req.owner!.id, p);
  res.json(result);
});

export default router;
