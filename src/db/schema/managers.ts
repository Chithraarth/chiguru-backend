import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

// ── Manager accounts (per Owner) ─────────────────────────────────────────────
// A manager is a worker the Owner has invited to record attendance/work/expenses
// on their own phone. There is no password: the Owner reserves a seat against a
// phone number ("pending"), and the manager claims it by signing in with that
// same phone number via Firebase phone-auth OTP — see firebaseAuthMiddleware,
// which links firebaseUid to this row (and flips status to "active") the first
// time a matching phone number authenticates.
export const managersTable = pgTable("managers", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  name: text("name").notNull(),
  // E.164 (e.g. "+919876543210") — matched against the Firebase ID token's
  // phone_number claim at first login, never typed by the manager themselves.
  phone: text("phone").notNull(),
  firebaseUid: text("firebase_uid"),
  // "pending" (seat reserved, manager hasn't logged in yet) | "active" (linked
  // and can sign in) | "removed" (seat freed, Firebase account disabled).
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  activatedAt: timestamp("activated_at"),
  removedAt: timestamp("removed_at"),
});

export const insertManagerSchema = createInsertSchema(managersTable).omit({
  id: true,
  firebaseUid: true,
  status: true,
  createdAt: true,
  activatedAt: true,
  removedAt: true,
});
export type ManagerRow = typeof managersTable.$inferSelect;
export type InsertManager = z.infer<typeof insertManagerSchema>;
