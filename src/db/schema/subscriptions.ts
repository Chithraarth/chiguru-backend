import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

// ── Subscription plans (DB-driven — never hardcode names/prices/limits) ─────
// One row per sellable plan (Basic/Premium/Pro today). The frontend only ever
// sees this table's contents via GET /subscriptions/plans; it never knows a
// Razorpay plan id. razorpayPlanId is filled in lazily the first time a plan
// is actually sold (see lib/razorpay.ts ensurePlan), since Razorpay plans are
// created via API rather than pre-provisioned in a dashboard.
export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  billingPeriod: text("billing_period").notNull().default("monthly"),
  managerLimit: integer("manager_limit").notNull(),
  razorpayPlanId: text("razorpay_plan_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlansTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type SubscriptionPlan = typeof subscriptionPlansTable.$inferSelect;
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;

// ── Subscriptions — one common model for every platform/provider ───────────
// Deliberately NOT split into web_subscriptions/android_subscriptions/etc.
// Phase 1 only ever writes platform="WEB", provider="RAZORPAY"; the columns
// already support ANDROID/GOOGLE_PLAY and IOS/APPLE for Phase 2 without a
// schema change.
export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  planId: integer("plan_id").notNull().references(() => subscriptionPlansTable.id),
  platform: text("platform").notNull(), // "WEB" | "ANDROID" | "IOS"
  provider: text("provider").notNull(), // "RAZORPAY" | "GOOGLE_PLAY" | "APPLE"
  providerPlanId: text("provider_plan_id"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerPaymentId: text("provider_payment_id"),
  // "PENDING" | "ACTIVE" | "EXPIRED" | "CANCELLED" | "PAUSED" | "GRACE_PERIOD" | "ON_HOLD"
  // — the backend is the only writer of this column; it is never set from a
  // client-supplied value, only from verified checkout or webhook events.
  status: text("status").notNull().default("PENDING"),
  startDate: timestamp("start_date"),
  expiryDate: timestamp("expiry_date"),
  autoRenew: boolean("auto_renew").notNull().default(true),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  providerSubscriptionIdUnique: uniqueIndex("subscriptions_provider_subscription_id_unique").on(t.providerSubscriptionId),
}));

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Subscription = typeof subscriptionsTable.$inferSelect;
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;

// ── Payments (ledger, per Owner) ─────────────────────────────────────────────
export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  subscriptionId: integer("subscription_id").references(() => subscriptionsTable.id),
  provider: text("provider").notNull(), // "RAZORPAY" | "GOOGLE_PLAY" | "APPLE"
  providerPaymentId: text("provider_payment_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // "succeeded" | "failed" | "pending" | "refunded"
  paymentStatus: text("payment_status").notNull().default("pending"),
  paymentDate: timestamp("payment_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // A provider payment id should only ever be recorded once, even if the
  // webhook that reports it fires more than once (no provider guarantees
  // exactly-once delivery).
  providerPaymentIdUnique: uniqueIndex("payments_provider_payment_id_unique").on(t.providerPaymentId),
}));

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export type Payment = typeof paymentsTable.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;

// ── Webhook event idempotency ────────────────────────────────────────────────
// Every processed webhook event id is recorded here first; a retried delivery
// with an id already present is ignored rather than reprocessed.
export const webhookEventsTable = pgTable("webhook_events", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(), // "RAZORPAY" | "GOOGLE_PLAY" | "APPLE"
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  providerEventIdUnique: uniqueIndex("webhook_events_provider_event_id_unique").on(t.provider, t.providerEventId),
}));

export type WebhookEvent = typeof webhookEventsTable.$inferSelect;
