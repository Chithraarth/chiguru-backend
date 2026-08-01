import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, subscriptionsTable, managersTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";
import { firebaseAuth } from "../lib/firebase-admin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

async function purchasedSeats(ownerId: number): Promise<number> {
  const [sub] = await db
    .select({ managerSeats: subscriptionsTable.managerSeats })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.ownerId, ownerId))
    .orderBy(desc(subscriptionsTable.id))
    .limit(1);
  return sub?.managerSeats ?? 0;
}

async function activeSeatsUsed(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(managersTable)
    .where(and(eq(managersTable.ownerId, ownerId), eq(managersTable.status, "active")));
  return row?.count ?? 0;
}

// List every manager this Owner has ever added (pending/active/removed), newest first.
router.get("/managers", requireOwner, async (req, res) => {
  const rows = await db
    .select()
    .from(managersTable)
    .where(eq(managersTable.ownerId, req.owner!.id))
    .orderBy(desc(managersTable.createdAt));
  res.json(rows);
});

// Reserve a seat against a phone number. No password/credential is created —
// the manager claims this seat by simply signing in with this phone number in
// the manager app (see firebaseAuthMiddleware).
router.post("/managers", requireOwner, async (req, res) => {
  const { name, phone } = req.body as { name?: string; phone?: string };
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";

  if (!trimmedName) {
    res.status(400).json({ message: "Name is required", code: "INVALID_NAME" });
    return;
  }
  if (!PHONE_RE.test(trimmedPhone)) {
    res.status(400).json({ message: "Phone number must be in international format, e.g. +919876543210", code: "INVALID_PHONE" });
    return;
  }

  const [seats, used] = await Promise.all([purchasedSeats(req.owner!.id), activeSeatsUsed(req.owner!.id)]);
  if (used >= seats) {
    res.status(403).json({
      message: "You've used all your purchased manager seats. Buy more seats from Subscription to add another manager.",
      code: "NO_SEATS_AVAILABLE",
    });
    return;
  }

  const [existing] = await db
    .select()
    .from(managersTable)
    .where(
      and(
        eq(managersTable.ownerId, req.owner!.id),
        eq(managersTable.phone, trimmedPhone),
        sql`${managersTable.status} != 'removed'`,
      ),
    );
  if (existing) {
    res.status(409).json({ message: "This phone number is already a manager on your farm", code: "ALREADY_MANAGER" });
    return;
  }

  const [created] = await db
    .insert(managersTable)
    .values({ ownerId: req.owner!.id, name: trimmedName, phone: trimmedPhone })
    .returning();
  res.status(201).json(created);
});

// Edit a still-pending invite (e.g. the owner mistyped the number) — once a
// manager has actually signed in (status "active"), their identity is fixed;
// remove + re-invite instead.
router.patch("/managers/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { name, phone } = req.body as { name?: string; phone?: string };

  const [row] = await db
    .select()
    .from(managersTable)
    .where(and(eq(managersTable.id, id), eq(managersTable.ownerId, req.owner!.id)));
  if (!row) {
    res.status(404).json({ message: "Manager not found", code: "NOT_FOUND" });
    return;
  }
  if (row.status !== "pending") {
    res.status(400).json({ message: "Only a pending invite can be edited", code: "NOT_PENDING" });
    return;
  }

  const updates: Partial<typeof row> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof phone === "string" && phone.trim()) {
    if (!PHONE_RE.test(phone.trim())) {
      res.status(400).json({ message: "Phone number must be in international format, e.g. +919876543210", code: "INVALID_PHONE" });
      return;
    }
    updates.phone = phone.trim();
  }

  const [updated] = await db
    .update(managersTable)
    .set(updates)
    .where(eq(managersTable.id, id))
    .returning();
  res.json(updated);
});

// Remove a manager — frees their seat immediately. If they'd already signed
// in, disable their Firebase account too so a cached/offline token can't keep
// working against this farm.
router.delete("/managers/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(managersTable)
    .where(and(eq(managersTable.id, id), eq(managersTable.ownerId, req.owner!.id)));
  if (!row) {
    res.status(404).json({ message: "Manager not found", code: "NOT_FOUND" });
    return;
  }

  if (row.firebaseUid) {
    try {
      await firebaseAuth.updateUser(row.firebaseUid, { disabled: true });
    } catch (err) {
      logger.warn({ err, managerId: id }, "Could not disable manager's Firebase account");
    }
  }

  await db
    .update(managersTable)
    .set({ status: "removed", removedAt: new Date() })
    .where(eq(managersTable.id, id));
  res.status(204).send();
});

export default router;
