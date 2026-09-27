import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

// ── Invitee accounts (per Owner) ─────────────────────────────────────────────
// An invitee (still "manager" in code/DB for now) is a person the Owner has
// invited to record attendance/work/expenses on their own phone, inside the
// same Owner app the invitee already uses for their own account. There is no
// password: the Owner reserves a seat against a phone number OR an email
// ("pending"), and the invitee claims it by simply signing into the Owner app
// with that same phone/email — see firebaseAuthMiddleware, which links
// firebaseUid to this row (and flips status to "active") the first time a
// matching phone number or email authenticates. One person can hold several
// active rows at once (invited by multiple Owners) — ownerId is per-row, not
// unique per firebaseUid.
export const managersTable = pgTable("managers", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  name: text("name").notNull(),
  // E.164 (e.g. "+919876543210") — matched against the Firebase ID token's
  // phone_number claim at first login, never typed by the manager themselves.
  // Nullable: an invite may be created with an email instead of a phone.
  phone: text("phone"),
  // Matched against the Firebase ID token's email claim at first login, same
  // pairing pattern as phone. Nullable: an invite may use phone instead.
  email: text("email"),
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
