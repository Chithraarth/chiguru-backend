import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { farmProfileTable } from "../db/schema";
import { requireManager } from "../middlewares/firebaseAuth";

const router = Router();

// Who this invitee is on the estate the request is acting on (the name the
// Owner gave them, shown on attendance/expenses/updates they record). A
// person can hold several invites, so this picks the one for the resolved
// Owner and estate, falling back to the oldest for the legacy manager app.
// req.managers is guaranteed non-empty here by requireManager.
router.get("/manager/me", requireManager, async (req, res) => {
  const manager =
    req.managers.find(
      (m) => m.ownerId === req.resolvedOwnerId && (m.estateId == null || m.estateId === req.inviteEstateId),
    ) ?? req.managers[0]!;
  const [farm] = await db
    .select({ farmName: farmProfileTable.farmName })
    .from(farmProfileTable)
    .where(manager.estateId != null ? eq(farmProfileTable.id, manager.estateId) : eq(farmProfileTable.ownerId, manager.ownerId))
    .orderBy(farmProfileTable.id)
    .limit(1);

  return res.json({
    managerId: manager.id,
    name: manager.name,
    phone: manager.phone,
    email: manager.email,
    ownerId: manager.ownerId,
    estateId: manager.estateId,
    farmName: farm?.farmName ?? "My Farm",
  });
});

export default router;
