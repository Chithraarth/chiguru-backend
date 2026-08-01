import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { farmProfileTable } from "../db/schema";
import { requireManager } from "../middlewares/firebaseAuth";

const router = Router();

// Called by the manager app right after Firebase phone-OTP sign-in. All the
// actual linking (matching the phone to an Owner's pending invite, flipping
// it to "active") already happened in firebaseAuthMiddleware — this just
// hands back what the manager app needs to show the manager who they are and
// which farm they're now working with.
router.get("/manager/me", requireManager, async (req, res) => {
  const [farm] = await db
    .select({ farmName: farmProfileTable.farmName })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, req.manager!.ownerId))
    .orderBy(farmProfileTable.id)
    .limit(1);

  return res.json({
    managerId: req.manager!.id,
    name: req.manager!.name,
    phone: req.manager!.phone,
    ownerId: req.manager!.ownerId,
    farmName: farm?.farmName ?? "My Farm",
  });
});

export default router;
