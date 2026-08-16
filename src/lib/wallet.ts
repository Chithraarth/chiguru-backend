import { and, eq, sql } from "drizzle-orm";
import { db, walletBalancesTable, walletTransactionsTable } from "../db";

/**
 * Per-Owner wallet + AI usage charging.
 *
 * Money model (India-only, INR):
 *  - Recharges: ₹5,000 or ₹10,000 top-ups, paid via Razorpay (a one-time
 *    order, verified the same way lib/razorpay.ts verifies checkout).
 *  - Every AI feature call debits a fixed price from the wallet, on top of
 *    (not instead of) the Owner's subscription — subscription unlocks the
 *    feature, wallet balance pays for each use.
 *
 * IMPORTANT: each AI debit is internally split for accounting (aiCost vs
 * serviceFee). This split is stored on the ledger row ONLY and must never be
 * included in any API response — the Owner always sees one single charge.
 */

export const RECHARGE_AMOUNTS = [5000, 10000];
/** Share the app on 3 different social platforms → one-time wallet credit. */
export const SHARE_REWARD = 300;
export const SHARE_TARGET = 3;

/** Server-side accounting only — never expose. */
const AI_COST_RATIO = 0.7;

/** Price per use, in rupees, of each AI feature. */
export const AI_PRICES: Record<string, { price: number; label: string }> = {
  ai_chat: { price: 5, label: "AI crop advisor" },
  disease_check: { price: 10, label: "AI disease check" },
  count_workers: { price: 5, label: "AI worker count" },
  accounts_scan: { price: 10, label: "AI accounts scan" },
  year_plan: { price: 25, label: "AI year plan" },
};

export class WalletError extends Error {
  status: number;
  code: string;
  balance: number;
  price: number;
  constructor(code: string, message: string, balance: number, price: number, status = 402) {
    super(message);
    this.code = code;
    this.status = status;
    this.balance = balance;
    this.price = price;
  }
}

async function getOrCreateBalanceRow(ownerId: number) {
  const rows = await db.select().from(walletBalancesTable).where(eq(walletBalancesTable.ownerId, ownerId)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(walletBalancesTable).values({ ownerId }).returning();
  return inserted[0];
}

export async function getWalletState(ownerId: number) {
  const row = await getOrCreateBalanceRow(ownerId);
  return {
    balance: Number(row.balance || 0),
    sharePlatforms: (row.sharePlatforms ?? "").split(",").filter(Boolean),
    shareRewardClaimedAt: row.shareRewardClaimedAt,
  };
}

/**
 * Cheap pre-check before running an (expensive) AI call, so an empty wallet
 * fails fast without spending model tokens. The actual debit happens after
 * the AI call succeeds via chargeAI().
 */
export async function requireAICredit(ownerId: number, feature: string): Promise<void> {
  const cfg = AI_PRICES[feature];
  if (!cfg) return;
  const { balance } = await getWalletState(ownerId);
  if (balance < cfg.price) {
    throw new WalletError(
      "WALLET_EMPTY",
      `Your wallet credit is too low for this AI feature (needs ₹${cfg.price}). Recharge your wallet to continue.`,
      balance,
      cfg.price,
    );
  }
}

/**
 * Debit one AI use from the wallet, atomically. Call AFTER the AI request
 * succeeded so a failed AI call is never charged.
 */
export async function chargeAI(ownerId: number, feature: string): Promise<{ balance: number; charged: number }> {
  const cfg = AI_PRICES[feature];
  if (!cfg) return { balance: (await getWalletState(ownerId)).balance, charged: 0 };
  const price = cfg.price;
  const aiCost = Math.round(price * AI_COST_RATIO * 100) / 100;
  const serviceFee = Math.round((price - aiCost) * 100) / 100;

  return db.transaction(async (tx) => {
    let [row] = await tx
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.ownerId, ownerId))
      .limit(1)
      .for("update");
    if (!row) [row] = await tx.insert(walletBalancesTable).values({ ownerId }).returning();

    const balance = Number(row.balance || 0);
    // Allow the balance to dip to exactly 0 but never below: if a race spent
    // the credit between pre-check and here, refuse (Owner was not charged
    // for the AI output they already got — acceptable, rare).
    const newBalance = Math.round((balance - price) * 100) / 100;
    if (newBalance < 0) {
      throw new WalletError(
        "WALLET_EMPTY",
        `Your wallet credit is too low for this AI feature (needs ₹${price}). Recharge your wallet to continue.`,
        balance,
        price,
      );
    }
    await tx
      .update(walletBalancesTable)
      .set({ balance: String(newBalance), updatedAt: new Date() })
      .where(eq(walletBalancesTable.id, row.id));
    await tx.insert(walletTransactionsTable).values({
      ownerId,
      type: "ai_charge",
      feature,
      amount: String(-price),
      aiCost: String(aiCost),
      serviceFee: String(serviceFee),
    });
    return { balance: newBalance, charged: price };
  });
}

/**
 * Route helper: pre-check credit and answer 402 when the wallet is too low.
 * Returns false when the response was already sent (route should return).
 */
export async function ensureAICredit(
  ownerId: number,
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  feature: string,
): Promise<boolean> {
  try {
    await requireAICredit(ownerId, feature);
    return true;
  } catch (e) {
    if (e instanceof WalletError) {
      res.status(e.status).json({ error: e.message, code: e.code, balance: e.balance, price: e.price });
      return false;
    }
    throw e;
  }
}

/** Fire the post-success debit; never let a charge failure break the AI response. */
export async function chargeAISafe(ownerId: number, feature: string): Promise<void> {
  try {
    await chargeAI(ownerId, feature);
  } catch (e) {
    console.error(`wallet: failed to charge owner ${ownerId} for feature ${feature}:`, e);
  }
}

/** Credit the wallet (recharge), idempotent by clientId (the Razorpay payment id). */
export async function creditWallet(opts: {
  ownerId: number;
  type: "recharge";
  amount: number;
  clientId: string;
}): Promise<{ balance: number; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: walletTransactionsTable.id })
      .from(walletTransactionsTable)
      .where(and(eq(walletTransactionsTable.ownerId, opts.ownerId), eq(walletTransactionsTable.clientId, opts.clientId)))
      .limit(1);

    let [row] = await tx
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.ownerId, opts.ownerId))
      .limit(1)
      .for("update");
    if (!row) [row] = await tx.insert(walletBalancesTable).values({ ownerId: opts.ownerId }).returning();

    const balance = Number(row.balance || 0);
    if (existing[0]) return { balance, duplicate: true };

    const newBalance = Math.round((balance + opts.amount) * 100) / 100;
    await tx
      .update(walletBalancesTable)
      .set({ balance: String(newBalance), updatedAt: new Date() })
      .where(eq(walletBalancesTable.id, row.id));
    await tx.insert(walletTransactionsTable).values({
      ownerId: opts.ownerId,
      type: opts.type,
      amount: String(opts.amount),
      clientId: opts.clientId,
    });
    return { balance: newBalance, duplicate: false };
  });
}

/** Share-to-earn: mark a platform shared, credit once the target is reached. */
export async function recordShare(ownerId: number, platform: string): Promise<{
  platforms: string[];
  rewarded: boolean;
  creditGiven: boolean;
  balance: number;
}> {
  return db.transaction(async (tx) => {
    let [row] = await tx
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.ownerId, ownerId))
      .limit(1)
      .for("update");
    if (!row) [row] = await tx.insert(walletBalancesTable).values({ ownerId }).returning();

    const set = new Set((row.sharePlatforms ?? "").split(",").filter(Boolean));
    set.add(platform);
    const platforms = [...set];
    let rewarded = row.shareRewardClaimedAt != null;
    let creditGiven = false;
    let balance = Number(row.balance || 0);

    if (!rewarded && set.size >= SHARE_TARGET) {
      balance = Math.round((balance + SHARE_REWARD) * 100) / 100;
      await tx.insert(walletTransactionsTable).values({
        ownerId,
        type: "share_reward",
        amount: String(SHARE_REWARD),
        clientId: `share-reward-${ownerId}`,
      });
      rewarded = true;
      creditGiven = true;
    }

    await tx.update(walletBalancesTable).set({
      sharePlatforms: platforms.join(","),
      updatedAt: new Date(),
      ...(creditGiven ? { shareRewardClaimedAt: new Date(), balance: String(balance) } : {}),
    }).where(eq(walletBalancesTable.id, row.id));

    return { platforms, rewarded, creditGiven, balance };
  });
}

/** Recent transactions + aggregate usage, for the wallet screen. */
export async function getWalletHistory(ownerId: number) {
  const txns = await db
    .select({
      id: walletTransactionsTable.id,
      type: walletTransactionsTable.type,
      feature: walletTransactionsTable.feature,
      amount: walletTransactionsTable.amount,
      createdAt: walletTransactionsTable.createdAt,
    })
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.ownerId, ownerId))
    .orderBy(sql`${walletTransactionsTable.id} desc`)
    .limit(100);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [monthAgg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(abs(${walletTransactionsTable.amount})), 0)`,
    })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.ownerId, ownerId),
      eq(walletTransactionsTable.type, "ai_charge"),
      sql`${walletTransactionsTable.createdAt} >= ${monthStart}`,
    ));

  return {
    transactions: txns,
    usage: { month: { count: monthAgg?.count ?? 0, total: Number(monthAgg?.total ?? 0) } },
  };
}
