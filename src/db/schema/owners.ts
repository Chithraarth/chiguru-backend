import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  date,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Multi-tenant Owner accounts (Firebase Auth) ──────────────────────────────
// One row per Owner who has signed in at least once. Firebase verifies the
// identity; this table is Chiguru's own record of who that Firebase user is
// and what they're entitled to (via subscriptionsTable/paymentsTable below).
export const ownersTable = pgTable("owners", {
  id: serial("id").primaryKey(),
  firebaseUid: text("firebase_uid").notNull().unique(),
  fullName: text("full_name"),
  email: text("email"),
  mobileNumber: text("mobile_number"),
  profileImage: text("profile_image"),
  // "password" | "google.com" | "facebook.com" | "phone" — Firebase's own
  // provider id from the ID token, kept as-is rather than remapped.
  loginProvider: text("login_provider"),
  role: text("role").notNull().default("OWNER"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLogin: timestamp("last_login").notNull().defaultNow(),
  // ── Share-to-earn referral (share on 3 different apps → 1 month free) ──────
  // Comma-separated platform ids the owner has shared to (whatsapp,facebook,x,telegram,other).
  sharePlatforms: text("share_platforms"),
  shareRewardClaimedAt: timestamp("share_reward_claimed_at"),
  // Set true the moment the reward is earned while NOT yet subscribed — the
  // next plan checkout applies a 30-day Stripe trial instead of charging
  // immediately, then cleared once that checkout completes.
  freeMonthPending: boolean("free_month_pending").notNull().default(false),
});

export const insertOwnerSchema = createInsertSchema(ownersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastLogin: true,
});
export type Owner = typeof ownersTable.$inferSelect;
export type InsertOwner = z.infer<typeof insertOwnerSchema>;

// ── Subscriptions (per Owner — replaces the old singleton app_settings row) ──
export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  planName: text("plan_name").notNull(),
  billingCycle: text("billing_cycle").notNull().default("monthly"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // "pending" | "active" | "past_due" | "canceled" — never set to "active"
  // anywhere except from a verified Stripe webhook.
  status: text("status").notNull().default("pending"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  startDate: date("start_date"),
  renewalDate: date("renewal_date"),
  // Bundled + purchased manager-device allowance (plan's bundled amount plus
  // any manager-device add-on purchases stacked on top).
  managerSeats: integer("manager_seats").notNull().default(0),
  // Purchased estate add-ons stacked on top of the plan's bundled estate allowance.
  extraEstates: integer("extra_estates").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Subscription = typeof subscriptionsTable.$inferSelect;
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;

// ── Payments (ledger of Stripe charges, per Owner) ───────────────────────────
export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  subscriptionId: integer("subscription_id").references(() => subscriptionsTable.id),
  stripePaymentIntent: text("stripe_payment_intent"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // "succeeded" | "failed" | "pending" | "refunded"
  paymentStatus: text("payment_status").notNull().default("pending"),
  paymentMethod: text("payment_method"),
  invoiceNumber: text("invoice_number"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // A Stripe payment intent should only ever be recorded once, even if the
  // webhook that reports it fires more than once (Stripe does not guarantee
  // exactly-once delivery).
  stripePaymentIntentUnique: uniqueIndex("payments_stripe_payment_intent_unique").on(t.stripePaymentIntent),
}));

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export type Payment = typeof paymentsTable.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
