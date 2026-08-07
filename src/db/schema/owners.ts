import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Multi-tenant Owner accounts (Firebase Auth) ──────────────────────────────
// One row per Owner who has signed in at least once. Firebase verifies the
// identity; this table is Chiguru's own record of who that Firebase user is
// and what they're entitled to (via subscriptionsTable/paymentsTable in
// ./subscriptions.ts).
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
  // next Razorpay subscription is created with its billing start delayed 30
  // days instead of charging immediately, then cleared once that completes.
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
