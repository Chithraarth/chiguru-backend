import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import { db, farmProfileTable } from "../db";
import { requireOwner } from "../middlewares/firebaseAuth";

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

export default router;
