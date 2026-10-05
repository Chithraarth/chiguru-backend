import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import { db, farmProfileTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";
import { requestOwnerKey } from "../lib/owner-key";
import { deleteOwnerAccount } from "../services/account-deletion.service";

const router: IRouter = Router();

// Called right after sign-in. firebaseAuthMiddleware has already upserted the
// Owner row (created it on first-ever login, or bumped lastLogin) — this just
// reports it back plus whether the dashboard should show the empty state.
router.get("/owners/me", requireOwner, async (req, res) => {
  const [{ estateCount }] = await db
    .select({ estateCount: count() })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, req.owner!.id));

  res.json({ owner: req.owner, hasEstate: estateCount > 0 });
});

// DELETE /api/owners/me — permanently deletes the signed-in person's account
// and all of its data (App Store guideline 5.1.1(v); the same button exists
// on Android and the web). X-Owner-Key, when the device sends it, also
// removes that device's classified ads. Irreversible by design.
router.delete("/owners/me", requireOwner, async (req, res) => {
  await deleteOwnerAccount(req.owner!.id, { ownerKey: requestOwnerKey(req) || null });
  res.json({ deleted: true });
});

export default router;
