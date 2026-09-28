import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { farmProfileTable } from "./farm";

// ── Invitee accounts (per Owner) ─────────────────────────────────────────────
// An invitee (still "manager" in code/DB for now) is a person the Owner has
// invited to record attendance/work/expenses on their own phone, inside the
// same Owner app the invitee already uses for their own account. There is no
// password: the Owner reserves a seat against a phone number OR an email
// ("pending"). The invitee is matched by phone/email the first time they sign
// into the Owner app with that same phone/email, but the invite does NOT
// activate automatically — they must explicitly accept it (see
// routes/invites.ts's GET/POST /me/invites/:id/{accept,decline}), which is
// what links firebaseUid to this row and flips status to "active". One
// person can hold several active rows at once (invited by multiple Owners)
// — ownerId is per-row, not unique per firebaseUid.
export const managersTable = pgTable("managers", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => ownersTable.id),
  // Which one of the Owner's estates this invite grants access to. Nullable
  // only for rows created before per-estate scoping existed — those keep
  // legacy behavior (access to every estate that ownerId owns) rather than
  // being silently locked out; every new invite must set this.
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  name: text("name").notNull(),
  // E.164 (e.g. "+919876543210") — matched against the Firebase ID token's
  // phone_number claim, never typed by the invitee themselves.
  // Nullable: an invite may be created with an email instead of a phone.
  phone: text("phone"),
  // Matched against the Firebase ID token's email claim, same pairing
  // pattern as phone. Nullable: an invite may use phone instead.
  email: text("email"),
  firebaseUid: text("firebase_uid"),
  // "pending" (seat reserved, invite not yet accepted) | "active" (accepted,
  // can sign in and act) | "declined" (invitee explicitly said no) |
  // "removed" (seat freed by the Owner, Firebase account disabled).
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
