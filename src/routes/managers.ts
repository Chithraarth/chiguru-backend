import { Router, type IRouter } from "express";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { db, managersTable, farmProfileTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";
import { firebaseAuth } from "../lib/firebase-admin";
import { logger } from "../lib/logger";
import { canCreateManager } from "../services/entitlement.service";
import { sendInviteEmail } from "../lib/invite-email";

const router: IRouter = Router();

const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// List every manager this Owner has ever added (pending/active/removed), newest first.
router.get("/managers", requireOwner, async (req, res) => {
  const rows = await db
    .select()
    .from(managersTable)
    .where(eq(managersTable.ownerId, req.owner!.id))
    .orderBy(desc(managersTable.createdAt));
  res.json(rows);
});

// Reserve a seat against a phone number OR an email — exactly one is
// required. No password/credential is created: the invitee claims this seat
// by simply signing into the Owner app with that same phone/email (see
// firebaseAuthMiddleware).
router.post("/managers", requireOwner, async (req, res) => {
  const { name, phone, email } = req.body as { name?: string; phone?: string; email?: string };
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
  const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!trimmedName) {
    res.status(400).json({ message: "Name is required", code: "INVALID_NAME" });
    return;
  }
  if (!trimmedPhone && !trimmedEmail) {
    res.status(400).json({ message: "A phone number or an email is required", code: "INVALID_CONTACT" });
    return;
  }
  if (trimmedPhone && !PHONE_RE.test(trimmedPhone)) {
    res.status(400).json({ message: "Phone number must be in international format, e.g. +919876543210", code: "INVALID_PHONE" });
    return;
  }
  if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
    res.status(400).json({ message: "Invalid email address", code: "INVALID_EMAIL" });
    return;
  }

  if (!(await canCreateManager(req.owner!.id))) {
    res.status(403).json({
      message: "Your current subscription does not have enough Manager seats.",
      code: "NO_SEATS_AVAILABLE",
    });
    return;
  }

  const duplicateConditions = [];
  if (trimmedPhone) duplicateConditions.push(eq(managersTable.phone, trimmedPhone));
  if (trimmedEmail) duplicateConditions.push(eq(managersTable.email, trimmedEmail));
  const [existing] = await db
    .select()
    .from(managersTable)
    .where(
      and(
        eq(managersTable.ownerId, req.owner!.id),
        or(...duplicateConditions),
        sql`${managersTable.status} != 'removed'`,
      ),
    );
  if (existing) {
    res.status(409).json({ message: "This phone number or email is already invited on your farm", code: "ALREADY_MANAGER" });
    return;
  }

  const [created] = await db
    .insert(managersTable)
    .values({
      ownerId: req.owner!.id,
      name: trimmedName,
      phone: trimmedPhone || null,
      email: trimmedEmail || null,
    })
    .returning();
  res.status(201).json(created);

  if (trimmedEmail) {
    const [farm] = await db
      .select({ farmName: farmProfileTable.farmName })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.ownerId, req.owner!.id))
      .orderBy(farmProfileTable.id)
      .limit(1);
    sendInviteEmail({
      toEmail: trimmedEmail,
      inviteeName: trimmedName,
      ownerName: req.owner!.fullName,
      farmName: farm?.farmName ?? null,
    }).catch((err) => logger.warn({ err, managerId: created!.id }, "Failed to send invite email"));
  }
});

// Edit a still-pending invite (e.g. the owner mistyped the number) — once a
// manager has actually signed in (status "active"), their identity is fixed;
// remove + re-invite instead.
router.patch("/managers/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { name, phone, email } = req.body as { name?: string; phone?: string; email?: string };

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
  if (typeof email === "string" && email.trim()) {
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      res.status(400).json({ message: "Invalid email address", code: "INVALID_EMAIL" });
      return;
    }
    updates.email = trimmed;
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
