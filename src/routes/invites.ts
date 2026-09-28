import { Router, type IRouter } from "express";
import { eq, and, or } from "drizzle-orm";
import { db, managersTable, ownersTable, farmProfileTable } from "../db";

const router: IRouter = Router();

// ── Pending invite acceptance ────────────────────────────────────────────────
// A pending invite (see routes/managers.ts's POST /managers) is matched by
// phone/email but does NOT activate on its own — the invitee must explicitly
// accept or decline it here first. Until accepted, it never appears in
// req.managers (see firebaseAuthMiddleware) and can't be acted on.

// Every pending invite that matches this signed-in person's own phone or
// email — shown as an "Accept / Decline" prompt right after sign-in.
router.get("/me/invites", async (req, res) => {
  const identity = req.firebaseIdentity;
  if (!identity) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }

  const matchConditions = [];
  if (identity.phone) matchConditions.push(eq(managersTable.phone, identity.phone));
  if (identity.email) matchConditions.push(eq(managersTable.email, identity.email));
  if (matchConditions.length === 0) {
    res.json([]);
    return;
  }

  const rows = await db
    .select({
      id: managersTable.id,
      name: managersTable.name,
      estateId: managersTable.estateId,
      ownerId: managersTable.ownerId,
      ownerName: ownersTable.fullName,
      ownerEmail: ownersTable.email,
      ownerPhone: ownersTable.mobileNumber,
      createdAt: managersTable.createdAt,
    })
    .from(managersTable)
    .innerJoin(ownersTable, eq(ownersTable.id, managersTable.ownerId))
    .where(and(or(...matchConditions), eq(managersTable.status, "pending")));

  // A scoped invite (estateId set) names that one estate; a legacy unscoped
  // invite (estateId null) falls back to naming the Owner's first estate,
  // same heuristic used before per-estate scoping existed. Resolved
  // per-invite (not via a join) so each invite maps to exactly one farm name.
  const invites = await Promise.all(
    rows.map(async ({ estateId, ownerId, ...invite }) => {
      const [farm] = await db
        .select({ farmName: farmProfileTable.farmName })
        .from(farmProfileTable)
        .where(estateId != null ? eq(farmProfileTable.id, estateId) : eq(farmProfileTable.ownerId, ownerId))
        .orderBy(farmProfileTable.id)
        .limit(1);
      return { ...invite, farmName: farm?.farmName ?? null };
    }),
  );
  res.json(invites);
});

// Accept: links this person's Firebase identity to the invite and activates
// it. From this point it appears in req.managers on every future request.
router.post("/me/invites/:id/accept", async (req, res) => {
  const identity = req.firebaseIdentity;
  if (!identity) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }

  const id = Number(req.params.id);
  const matchConditions = [];
  if (identity.phone) matchConditions.push(eq(managersTable.phone, identity.phone));
  if (identity.email) matchConditions.push(eq(managersTable.email, identity.email));

  const [row] = await db
    .select()
    .from(managersTable)
    .where(and(eq(managersTable.id, id), or(...matchConditions), eq(managersTable.status, "pending")));
  if (!row) {
    res.status(404).json({ message: "Invite not found", code: "NOT_FOUND" });
    return;
  }

  const [updated] = await db
    .update(managersTable)
    .set({ firebaseUid: identity.uid, status: "active", activatedAt: new Date() })
    .where(eq(managersTable.id, id))
    .returning();
  res.json(updated);
});

// Decline: the invitee explicitly says no — frees the Owner's seat and the
// invite stops showing up, without ever linking a Firebase identity to it.
router.post("/me/invites/:id/decline", async (req, res) => {
  const identity = req.firebaseIdentity;
  if (!identity) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }

  const id = Number(req.params.id);
  const matchConditions = [];
  if (identity.phone) matchConditions.push(eq(managersTable.phone, identity.phone));
  if (identity.email) matchConditions.push(eq(managersTable.email, identity.email));

  const [row] = await db
    .select()
    .from(managersTable)
    .where(and(eq(managersTable.id, id), or(...matchConditions), eq(managersTable.status, "pending")));
  if (!row) {
    res.status(404).json({ message: "Invite not found", code: "NOT_FOUND" });
    return;
  }

  await db.update(managersTable).set({ status: "declined" }).where(eq(managersTable.id, id));
  res.status(204).send();
});

export default router;
