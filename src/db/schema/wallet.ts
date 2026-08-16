import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

// ── Wallet balances — one row per Owner ─────────────────────────────────────
// Separate from subscriptionsTable: a subscription unlocks app access;
// the wallet pays per-use for AI features (chat, disease check, accounts
// scan, etc.) on top of that. Recharges are real Razorpay one-time payments
// (see lib/razorpay.ts), not self-reported "I've paid".
export const walletBalancesTable = pgTable("wallet_balances", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id).unique(),
  balance: numeric("balance", { precision: 10, scale: 2 }).notNull().default("0"),
  sharePlatforms: text("share_platforms").notNull().default(""), // comma-separated, e.g. "whatsapp,facebook"
  shareRewardClaimedAt: timestamp("share_reward_claimed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WalletBalance = typeof walletBalancesTable.$inferSelect;

// ── Wallet transactions (ledger) ────────────────────────────────────────────
// aiCost/serviceFee are internal accounting fields (never returned by the API).
export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  type: text("type").notNull(), // "recharge" | "ai_charge" | "share_reward"
  feature: text("feature"), // set only for ai_charge, e.g. "disease_check"
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(), // positive=credit, negative=debit
  aiCost: numeric("ai_cost", { precision: 10, scale: 2 }),
  serviceFee: numeric("service_fee", { precision: 10, scale: 2 }),
  // Idempotency key: a client-generated id for recharges, or a fixed string
  // for one-time rewards (e.g. "share-reward-<ownerId>"). Razorpay's own
  // payment id also gets stored here for recharges, so a retried verify call
  // can never double-credit.
  clientId: text("client_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // Scoped per-owner (not globally unique) since clientId is client-generated
  // for recharges — two different owners could otherwise collide.
  ownerClientIdUnique: uniqueIndex("wallet_transactions_owner_client_id_unique").on(t.ownerId, t.clientId),
}));

export const insertWalletTransactionSchema = createInsertSchema(walletTransactionsTable).omit({
  id: true,
  createdAt: true,
});
export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
export type InsertWalletTransaction = z.infer<typeof insertWalletTransactionSchema>;
