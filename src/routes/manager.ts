import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { farmProfileTable } from "../db/schema";
import { requireManager } from "../middlewares/firebaseAuth";

const router = Router();

// Called by the legacy standalone manager app right after Firebase phone-OTP
// sign-in. All the actual linking (matching the phone to an Owner's pending
// invite, flipping it to "active") already happened in firebaseAuthMiddleware
// — this just hands back what that app needs to show who they are and which
// farm they're working with. That app only ever supports one invite per
// person, so this always answers with the first (oldest) active one —
// req.managers is guaranteed non-empty here by requireManager.
router.get("/manager/me", requireManager, async (req, res) => {
  const manager = req.managers[0]!;
  const [farm] = await db
    .select({ farmName: farmProfileTable.farmName })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, manager.ownerId))
    .orderBy(farmProfileTable.id)
    .limit(1);

  return res.json({
    managerId: manager.id,
    name: manager.name,
    phone: manager.phone,
    ownerId: manager.ownerId,
    farmName: farm?.farmName ?? "My Farm",
  });
});

export default router;
