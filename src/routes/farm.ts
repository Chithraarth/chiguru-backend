import { Router } from "express";
import { db } from "../db";
import {
  workerPaymentsTable,
  farmProfileTable,
  cropsTable,
  blocksTable,
  workersTable,
  workGroupsTable,
  groupWorkSessionsTable,
  groupAdvancePaymentsTable,
  attendanceTable,
  dailyWorkTable,
  expensesTable,
  spraysTable,
  harvestsTable,
  loansTable,
  loanPaymentsTable,
  estateUpdatesTable,
  nurseryVendorsTable,
  nurseryListingsTable,
  nurseryRatingsTable,
  syncConflictsTable,
  helpMessagesTable,
  mandiDailyPricesTable,
  mandiFetchLogTable,
  userDevicesTable,
  planTasksTable,
} from "../db/schema";
import { openai } from "../integrations-openai-ai-server";
import { requestOwnerKey, bodyOwnerKey } from "../lib/owner-key";
import { sendSuggestionEmail } from "../lib/gmail";
import { eq, and, or, gte, lte, lt, sql, desc, inArray, isNull, isNotNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireOwner, requireOwnerOrManager, effectiveOwnerId } from "../middlewares/firebaseAuth";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";
import { getMaxEstates } from "../services/entitlement.service";

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// Estates (multi-estate). Each farm_profile row is one estate. The client picks an
// "active estate" and sends its id in the X-Estate-Id header; data is scoped to it.
// ──────────────────────────────────────────────────────────────────────────────

// Resolve the active estate id for a request: the X-Estate-Id header if valid,
// otherwise the oldest estate (first onboarded). Returns null when none exist yet.
async function activeEstateId(
  req: { header(name: string): string | undefined; owner?: { id: number }; manager?: { ownerId: number } },
): Promise<number | null> {
  const ownerId = req.owner?.id ?? req.manager?.ownerId;
  const h = req.header("X-Estate-Id");
  const headerEid = h && !isNaN(Number(h)) ? Number(h) : null;

  if (headerEid != null) {
    if (!ownerId) return headerEid; // No authenticated identity at all — preserve legacy fallback below.
    // Never resolve to an estate that isn't actually owned by this request's
    // Owner (whether signed in directly or via a Manager acting for them),
    // even if the client sent a stale/forged header.
    const [row] = await db
      .select({ id: farmProfileTable.id })
      .from(farmProfileTable)
      .where(and(eq(farmProfileTable.id, headerEid), eq(farmProfileTable.ownerId, ownerId)))
      .limit(1);
    if (row) return row.id;
  }

  if (ownerId) {
    const [row] = await db
      .select({ id: farmProfileTable.id })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.ownerId, ownerId))
      .orderBy(farmProfileTable.id)
      .limit(1);
    return row?.id ?? null;
  }

  // No authenticated Owner/Manager on this request — preserve the original
  // single-farm-deployment fallback (oldest estate overall).
  const rows = await db
    .select({ id: farmProfileTable.id })
    .from(farmProfileTable)
    .orderBy(farmProfileTable.id)
    .limit(1);
  return rows[0]?.id ?? null;
}

// Build a WHERE clause that matches a row by id AND constrains it to the active
// estate, so ID-based reads/updates/deletes can never touch another estate's data.
function estateScoped(idCol: PgColumn, estateCol: PgColumn, id: number, eid: number | null) {
  return eid != null ? and(eq(idCol, id), eq(estateCol, eid)) : eq(idCol, id);
}

// Subquery of work_group ids belonging to an estate. Used to scope attendance/
// daily-work/sync-conflicts — which have no estate_id of their own — to the
// active estate via their parent work group.
function estateGroupIds(eid: number) {
  return db
    .select({ id: workGroupsTable.id })
    .from(workGroupsTable)
    .where(eq(workGroupsTable.estateId, eid));
}

// True when the given work group belongs to the active estate. Guards routes that
// take a workGroupId from the client (attendance/daily-work POST, work-group
// subroutes) against cross-estate writes.
async function groupInEstate(groupId: number, eid: number | null): Promise<boolean> {
  const [g] = await db
    .select({ id: workGroupsTable.id })
    .from(workGroupsTable)
    .where(
      and(
        eq(workGroupsTable.id, groupId),
        // A group in the recycle bin must behave as if deleted: no new
        // attendance/work/photos can be attached until it is restored.
        isNull(workGroupsTable.deletedAt),
        eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
      ),
    )
    .limit(1);
  return !!g;
}

// Same estate check but including soft-deleted groups — only for the recycle
// bin routes (restore / delete forever), which must reach binned groups.
async function binnedGroupInEstate(groupId: number, eid: number | null): Promise<boolean> {
  const [g] = await db
    .select({ id: workGroupsTable.id })
    .from(workGroupsTable)
    .where(
      and(
        eq(workGroupsTable.id, groupId),
        eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
      ),
    )
    .limit(1);
  return !!g;
}

// True when the given worker belongs to the active estate. Guards routes that
// accept a workerId from the client (loan create) against cross-estate linking.
async function workerInEstate(workerId: number | null | undefined, eid: number | null): Promise<boolean> {
  if (eid == null || workerId == null) return true;
  const [w] = await db
    .select({ id: workersTable.id })
    .from(workersTable)
    .where(and(eq(workersTable.id, workerId), eq(workersTable.estateId, eid)))
    .limit(1);
  return !!w;
}

// Subquery of crop ids belonging to an estate. Used to scope blocks (crop-bound,
// no estate_id of their own) to the active estate via their parent crop.
function estateCropIds(eid: number) {
  return db
    .select({ id: cropsTable.id })
    .from(cropsTable)
    .where(eq(cropsTable.estateId, eid));
}

// True when the given crop belongs to the active estate (or is unset). Guards
// routes that accept a cropId from the client (blocks/work-groups create+update)
// against cross-estate linking.
async function cropInEstate(cropId: number | null | undefined, eid: number | null): Promise<boolean> {
  if (eid == null || cropId == null) return true;
  const [c] = await db
    .select({ id: cropsTable.id })
    .from(cropsTable)
    .where(and(eq(cropsTable.id, cropId), eq(cropsTable.estateId, eid)))
    .limit(1);
  return !!c;
}

// ── Backup & Restore ──────────────────────────────────────────────────────────
// There are no user accounts. Each farm gets a short, human-friendly recovery code
// that IS its identity for backup: on a new/lost phone the farmer enters the code
// and reclaims all of this farm's synced records. Codes avoid ambiguous chars
// (0/O, 1/I/L) so they're easy to read aloud and type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  // Grouped for readability, e.g. "JAI-K7MP-9QRT" style: FARM-XXXX-XXXX.
  return `FARM-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// Return an unused recovery code (retries on the tiny chance of a collision).
async function uniqueRecoveryCode(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeRecoveryCode();
    const [clash] = await db
      .select({ id: farmProfileTable.id })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.recoveryCode, code))
      .limit(1);
    if (!clash) return code;
  }
  // Extremely unlikely; fall back to a timestamp-salted code.
  return `FARM-${Date.now().toString(36).toUpperCase().slice(-8)}`;
}

// Normalize user input: uppercase, keep only code chars, re-group as FARM-XXXX-XXXX.
function normalizeCode(input: string): string | null {
  const cleaned = (input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("FARM") ? cleaned.slice(4) : cleaned;
  if (body.length !== 8) return null;
  return `FARM-${body.slice(0, 4)}-${body.slice(4)}`;
}

// Get (creating on first use) the recovery code for the active estate.
router.get("/backup/code", async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(404).json({ message: "No farm found yet" });
  const [estate] = await db
    .select({ id: farmProfileTable.id, farmName: farmProfileTable.farmName, recoveryCode: farmProfileTable.recoveryCode })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.id, eid))
    .limit(1);
  if (!estate) return res.status(404).json({ message: "No farm found" });
  let code = estate.recoveryCode;
  if (!code) {
    code = await uniqueRecoveryCode();
    await db.update(farmProfileTable).set({ recoveryCode: code }).where(eq(farmProfileTable.id, eid));
  }
  return res.json({ estateId: estate.id, farmName: estate.farmName, recoveryCode: code });
});

// Restore on a new/lost phone: look up the farm by its recovery code and hand back
// its estate id so the client can point itself at that farm and re-sync everything.
router.post("/backup/restore", async (req, res) => {
  const code = normalizeCode(String(req.body?.code ?? ""));
  if (!code) {
    return res.status(400).json({ message: "That doesn't look like a backup code. It should look like FARM-XXXX-XXXX." });
  }
  const [estate] = await db
    .select({ id: farmProfileTable.id, farmName: farmProfileTable.farmName })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.recoveryCode, code))
    .limit(1);
  if (!estate) {
    return res.status(404).json({ message: "No farm found for that backup code. Please check and try again." });
  }
  return res.json({ estateId: estate.id, farmName: estate.farmName });
});

// ──────────────────────────────────────────────────────────────────────────────
// Account (Firebase-authenticated Owner). Every request that reaches these
// routes has already been through firebaseAuthMiddleware; requireOwner just
// 401s if that didn't produce a signed-in Owner.
// ──────────────────────────────────────────────────────────────────────────────

// Farms owned by the signed-in Owner.
router.get("/me/farms", requireOwner, async (req, res) => {
  const rows = await db
    .select({ id: farmProfileTable.id, farmName: farmProfileTable.farmName, village: farmProfileTable.village, district: farmProfileTable.district })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, req.owner!.id))
    .orderBy(farmProfileTable.id);
  return res.json(rows);
});

// Link the active farm to the signed-in Owner. Refuses to steal a farm that
// is already linked to a different Owner.
router.post("/me/link-farm", requireOwner, async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(404).json({ message: "No farm found yet" });
  const [estate] = await db
    .select({ id: farmProfileTable.id, farmName: farmProfileTable.farmName, ownerId: farmProfileTable.ownerId })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.id, eid))
    .limit(1);
  if (!estate) return res.status(404).json({ message: "No farm found" });
  if (estate.ownerId && estate.ownerId !== req.owner!.id) {
    return res.status(403).json({ message: "This farm is already linked to a different account." });
  }
  if (!estate.ownerId) {
    await db
      .update(farmProfileTable)
      .set({ ownerId: req.owner!.id, updatedAt: new Date() })
      .where(eq(farmProfileTable.id, eid));
  }
  return res.json({ estateId: estate.id, farmName: estate.farmName, linked: true });
});

// Unlink the active farm from the signed-in Owner.
router.post("/me/unlink-farm", requireOwner, async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(404).json({ message: "No farm found yet" });
  const [row] = await db
    .update(farmProfileTable)
    .set({ ownerId: null, updatedAt: new Date() })
    .where(and(eq(farmProfileTable.id, eid), eq(farmProfileTable.ownerId, req.owner!.id)))
    .returning({ id: farmProfileTable.id });
  if (!row) return res.status(404).json({ message: "This farm is not linked to your account." });
  return res.json({ estateId: row.id, linked: false });
});

// ──────────────────────────────────────────────────────────────────────────────
// Device limit — one Owner account may be active on at most
// MAX_DEVICES_PER_ACCOUNT devices at the same time. Each device registers a
// stable random id; a 3rd device is refused until an old one is logged out.
// (userDevicesTable's "clerkUserId" column now holds the Owner's numeric id as
// a string — kept as-is rather than renamed, to avoid an extra migration.)
// ──────────────────────────────────────────────────────────────────────────────

const MAX_DEVICES_PER_ACCOUNT = 2;

async function listUserDevices(userId: string) {
  return db
    .select({
      id: userDevicesTable.id,
      deviceId: userDevicesTable.deviceId,
      deviceName: userDevicesTable.deviceName,
      lastSeenAt: userDevicesTable.lastSeenAt,
      createdAt: userDevicesTable.createdAt,
    })
    .from(userDevicesTable)
    .where(eq(userDevicesTable.clerkUserId, userId))
    .orderBy(userDevicesTable.createdAt);
}

// Register (or refresh) this device for the signed-in Owner.
// 403 { error: "device_limit" } when the account already uses 2 other devices.
router.post("/me/devices/register", requireOwner, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const deviceName = typeof b.deviceName === "string" ? b.deviceName.trim().slice(0, 120) : null;
  if (!deviceId || deviceId.length > 80) {
    return res.status(400).json({ message: "deviceId is required" });
  }

  const userId = String(req.owner!.id);
  // Transaction + per-user advisory lock so two devices registering at the same
  // moment can't both pass the count check and exceed the limit.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"device_limit:" + userId}))`);

    const [existing] = await tx
      .select({ id: userDevicesTable.id })
      .from(userDevicesTable)
      .where(and(eq(userDevicesTable.clerkUserId, userId), eq(userDevicesTable.deviceId, deviceId)))
      .limit(1);

    if (existing) {
      await tx
        .update(userDevicesTable)
        .set({ lastSeenAt: new Date(), ...(deviceName ? { deviceName } : {}) })
        .where(eq(userDevicesTable.id, existing.id));
      return { ok: true as const };
    }

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userDevicesTable)
      .where(eq(userDevicesTable.clerkUserId, userId));
    if ((countRow?.count ?? 0) >= MAX_DEVICES_PER_ACCOUNT) {
      return { ok: false as const };
    }

    await tx.insert(userDevicesTable).values({ clerkUserId: userId, deviceId, deviceName });
    return { ok: true as const };
  });

  if (!outcome.ok) {
    return res.status(403).json({
      error: "device_limit",
      message: `This account is already in use on ${MAX_DEVICES_PER_ACCOUNT} devices. Log out one of them to use this device.`,
      maxDevices: MAX_DEVICES_PER_ACCOUNT,
      devices: await listUserDevices(userId),
    });
  }
  return res.json({ ok: true, devices: await listUserDevices(userId) });
});

// Devices currently using this account.
router.get("/me/devices", requireOwner, async (req, res) => {
  return res.json(await listUserDevices(String(req.owner!.id)));
});

// Log a device out of this account (frees one of the 2 slots).
router.delete("/me/devices/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid device id" });
  const [row] = await db
    .delete(userDevicesTable)
    .where(and(eq(userDevicesTable.id, id), eq(userDevicesTable.clerkUserId, String(req.owner!.id))))
    .returning({ id: userDevicesTable.id });
  if (!row) return res.status(404).json({ message: "Device not found" });
  return res.status(204).send();
});

// List the Owner's estates (newest first), so the switcher can show them —
// a signed-in Manager can list them too, scoped to the Owner they work for.
router.get("/estates", requireOwnerOrManager, async (req, res) => {
  const rows = await db
    .select()
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, effectiveOwnerId(req)!))
    .orderBy(farmProfileTable.id);
  return res.json(rows);
});

router.post("/estates", requireOwner, async (req, res) => {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, req.owner!.id));
  const estateCount = countRow?.count ?? 0;
  const maxEstates = await getMaxEstates(req.owner!.id);
  if (estateCount >= maxEstates) {
    return res.status(403).json({
      message: maxEstates === 0
        ? "An active subscription is required to create a farm."
        : "You've reached your estate limit for your current plan. Upgrade your subscription to add more estates.",
      code: maxEstates === 0 ? "SUBSCRIPTION_REQUIRED" : "ESTATE_LIMIT_REACHED",
    });
  }
  // Every new farm gets a recovery code at creation so backup works from day one.
  const recoveryCode = await uniqueRecoveryCode();
  const [row] = await db
    .insert(farmProfileTable)
    .values({ ...req.body, ownerId: req.owner!.id, recoveryCode })
    .returning();
  return res.status(201).json(row);
});

// A manager acting for their linked owner may rename the estate too (e.g.
// from the manager app's estate switcher) - scoped by the owner they're
// actually linked to, same as every other manager-writable resource.
router.patch("/estates/:id", requireOwnerOrManager, async (req, res) => {
  const ownerId = effectiveOwnerId(req);
  const [row] = await db
    .update(farmProfileTable)
    .set({ ...req.body, updatedAt: new Date() })
    .where(and(eq(farmProfileTable.id, Number(req.params.id)), eq(farmProfileTable.ownerId, ownerId!)))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/estates/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  // Never allow deleting the last estate — the app always needs an active estate.
  const all = await db
    .select({ id: farmProfileTable.id })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, req.owner!.id));
  if (all.length <= 1) {
    return res.status(400).json({ message: "Cannot delete the last estate" });
  }
  if (!all.some((e) => e.id === id)) {
    return res.status(404).json({ message: "Not found" });
  }
  // Cascade: the estate's child rows (and their grandchildren) reference it via
  // FKs with no ON DELETE CASCADE, so remove them in dependency order inside a
  // transaction before deleting the estate itself.
  await db.transaction(async (tx) => {
    const groupIds = tx
      .select({ id: workGroupsTable.id })
      .from(workGroupsTable)
      .where(eq(workGroupsTable.estateId, id));
    const cropIds = tx
      .select({ id: cropsTable.id })
      .from(cropsTable)
      .where(eq(cropsTable.estateId, id));
    const workerIds = tx
      .select({ id: workersTable.id })
      .from(workersTable)
      .where(eq(workersTable.estateId, id));
    const loanIds = tx
      .select({ id: loansTable.id })
      .from(loansTable)
      .where(eq(loansTable.estateId, id));

    // Attendance references both the estate's groups and its workers.
    await tx.delete(attendanceTable).where(inArray(attendanceTable.workGroupId, groupIds));
    await tx.delete(attendanceTable).where(inArray(attendanceTable.workerId, workerIds));
    await tx.delete(dailyWorkTable).where(inArray(dailyWorkTable.workGroupId, groupIds));
    await tx
      .delete(groupAdvancePaymentsTable)
      .where(inArray(groupAdvancePaymentsTable.workGroupId, groupIds));
    await tx
      .delete(groupWorkSessionsTable)
      .where(inArray(groupWorkSessionsTable.workGroupId, groupIds));
    // Loans chain: payments -> loans -> workers. Detach any stray loans that
    // point at this estate's groups first, then delete the estate's own loans.
    await tx.delete(loanPaymentsTable).where(inArray(loanPaymentsTable.loanId, loanIds));
    await tx
      .update(loansTable)
      .set({ workGroupId: null })
      .where(inArray(loansTable.workGroupId, groupIds));
    await tx.delete(loansTable).where(eq(loansTable.estateId, id));
    // Harvests reference work groups, so they must go before the groups do.
    await tx.delete(harvestsTable).where(eq(harvestsTable.estateId, id));
    await tx.delete(workGroupsTable).where(eq(workGroupsTable.estateId, id));
    await tx.delete(workersTable).where(eq(workersTable.estateId, id));

    await tx.delete(blocksTable).where(inArray(blocksTable.cropId, cropIds));
    await tx.delete(spraysTable).where(eq(spraysTable.estateId, id));
    await tx.delete(expensesTable).where(eq(expensesTable.estateId, id));
    await tx.delete(estateUpdatesTable).where(eq(estateUpdatesTable.estateId, id));
    await tx.delete(cropsTable).where(eq(cropsTable.estateId, id));

    // Per-estate mandi price cache rows also reference the estate.
    await tx.delete(mandiDailyPricesTable).where(eq(mandiDailyPricesTable.estateId, id));
    await tx.delete(mandiFetchLogTable).where(eq(mandiFetchLogTable.estateId, id));

    await tx.delete(farmProfileTable).where(eq(farmProfileTable.id, id));
  });
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Farm Profile (returns the ACTIVE estate, per X-Estate-Id header)
// ──────────────────────────────────────────────────────────────────────────────

router.get("/farm/profile", async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(404).json({ message: "Not found" });
  const rows = await db
    .select()
    .from(farmProfileTable)
    .where(eq(farmProfileTable.id, eid))
    .limit(1);
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json(rows[0]);
});

router.patch("/farm/profile", async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(404).json({ message: "Not found" });
  const [row] = await db
    .update(farmProfileTable)
    .set({ ...req.body, updatedAt: new Date() })
    .where(eq(farmProfileTable.id, eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

// ──────────────────────────────────────────────────────────────────────────────
// Crops
// ──────────────────────────────────────────────────────────────────────────────

router.get("/crops", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(cropsTable)
    .where(eid != null ? eq(cropsTable.estateId, eid) : undefined)
    .orderBy(cropsTable.name);
  return res.json(rows);
});

router.post("/crops", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  const [row] = await db
    .insert(cropsTable)
    .values({ ...body, estateId: eid })
    .returning();
  return res.status(201).json(row);
});

router.get("/crops/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(cropsTable)
    .where(estateScoped(cropsTable.id, cropsTable.estateId, Number(req.params.id), eid));
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json(rows[0]);
});

router.patch("/crops/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  const [row] = await db
    .update(cropsTable)
    .set(body)
    .where(estateScoped(cropsTable.id, cropsTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/crops/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  await db
    .delete(cropsTable)
    .where(estateScoped(cropsTable.id, cropsTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

// Merges a duplicate crop's records (blocks, work groups, expenses, sprays,
// harvests, plan tasks) into another crop, then deletes the source crop.
router.post("/crops/:id/merge", async (req, res) => {
  const eid = await activeEstateId(req);
  const sourceId = Number(req.params.id);
  const intoId = Number(req.body?.intoId);
  if (!Number.isInteger(sourceId) || !Number.isInteger(intoId)) {
    return res.status(400).json({ message: "intoId is required" });
  }
  if (sourceId === intoId) {
    return res.status(400).json({ message: "Cannot merge a crop into itself" });
  }
  // Both rows must exist and belong to the active estate - client-supplied ids
  // must never re-parent data across estates.
  const rows = await db
    .select({ id: cropsTable.id })
    .from(cropsTable)
    .where(
      and(
        inArray(cropsTable.id, [sourceId, intoId]),
        eid != null ? eq(cropsTable.estateId, eid) : undefined,
      ),
    );
  if (rows.length !== 2) return res.status(404).json({ message: "Not found" });

  await db.transaction(async (tx) => {
    await tx.update(blocksTable).set({ cropId: intoId }).where(eq(blocksTable.cropId, sourceId));
    await tx.update(workGroupsTable).set({ cropId: intoId }).where(eq(workGroupsTable.cropId, sourceId));
    await tx.update(expensesTable).set({ cropId: intoId }).where(eq(expensesTable.cropId, sourceId));
    await tx.update(spraysTable).set({ cropId: intoId }).where(eq(spraysTable.cropId, sourceId));
    await tx.update(harvestsTable).set({ cropId: intoId }).where(eq(harvestsTable.cropId, sourceId));
    await tx.update(planTasksTable).set({ cropId: intoId }).where(eq(planTasksTable.cropId, sourceId));
    await tx.delete(cropsTable).where(eq(cropsTable.id, sourceId));
  });
  return res.json({ merged: true, sourceId, intoId });
});

// ──────────────────────────────────────────────────────────────────────────────
// Blocks
// ──────────────────────────────────────────────────────────────────────────────

router.get("/blocks", async (req, res) => {
  // Blocks belong to crops, which are estate-scoped, so only return blocks of the
  // active estate's crops.
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(blocksTable)
    .where(eid != null ? inArray(blocksTable.cropId, estateCropIds(eid)) : undefined)
    .orderBy(blocksTable.name);
  return res.json(rows);
});

router.post("/blocks", async (req, res) => {
  const eid = await activeEstateId(req);
  if (!(await cropInEstate(Number(req.body?.cropId), eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db.insert(blocksTable).values(req.body).returning();
  return res.status(201).json(row);
});

router.get("/blocks/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  const where =
    eid != null
      ? and(eq(blocksTable.id, id), inArray(blocksTable.cropId, estateCropIds(eid)))
      : eq(blocksTable.id, id);
  const [row] = await db.select().from(blocksTable).where(where);
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.patch("/blocks/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  // Block any re-parenting to a crop outside the active estate.
  if (
    req.body?.cropId != null &&
    !(await cropInEstate(Number(req.body.cropId), eid))
  ) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const where =
    eid != null
      ? and(eq(blocksTable.id, id), inArray(blocksTable.cropId, estateCropIds(eid)))
      : eq(blocksTable.id, id);
  const [row] = await db.update(blocksTable).set(req.body).where(where).returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/blocks/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  const where =
    eid != null
      ? and(eq(blocksTable.id, id), inArray(blocksTable.cropId, estateCropIds(eid)))
      : eq(blocksTable.id, id);
  await db.delete(blocksTable).where(where);
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Workers
// ──────────────────────────────────────────────────────────────────────────────

router.get("/workers", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(workersTable)
    .where(eid != null ? eq(workersTable.estateId, eid) : undefined)
    .orderBy(workersTable.name);

  // Sort by location proximity to the active estate's profile (taluk → district → state)
  const [farmProfile] = await db
    .select()
    .from(farmProfileTable)
    .where(eid != null ? eq(farmProfileTable.id, eid) : undefined)
    .limit(1);
  if (!farmProfile) return res.json(rows);

  const norm = (s?: string | null) => (s || "").trim().toLowerCase();

  const scored = rows.map(w => {
    let locationScore = 0;
    if (farmProfile.taluk && w.taluk && norm(w.taluk) === norm(farmProfile.taluk)) locationScore = 3;
    else if (farmProfile.district && w.district && norm(w.district) === norm(farmProfile.district)) locationScore = 2;
    else if (farmProfile.state && w.state && norm(w.state) === norm(farmProfile.state)) locationScore = 1;
    return { ...w, locationScore };
  });

  scored.sort((a, b) => {
    if (b.locationScore !== a.locationScore) return b.locationScore - a.locationScore;
    return a.name.localeCompare(b.name);
  });

  return res.json(scored.map(({ locationScore: _ls, ...w }) => w));
});

router.post("/workers", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  // Quick-add flows (e.g. "type new worker" in loan/attendance forms) send only
  // a name — fill the DB-required fields with sensible defaults.
  const values = {
    type: "Daily wage",
    wageRate: "0",
    ...body,
    estateId: eid,
  };
  const [row] = await db.insert(workersTable).values(values).returning();
  return res.status(201).json(row);
});

router.get("/workers/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(workersTable)
    .where(estateScoped(workersTable.id, workersTable.estateId, Number(req.params.id), eid));
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json(rows[0]);
});

router.patch("/workers/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  // faceDescriptor: JSON of one 128-number embedding, or up to 5 of them (multi-pose).
  if (body.faceDescriptor != null) {
    const is128 = (a: unknown) =>
      Array.isArray(a) && a.length === 128 && a.every((n) => typeof n === "number" && Number.isFinite(n));
    let ok = false;
    if (typeof body.faceDescriptor === "string" && body.faceDescriptor.length <= 40000) {
      try {
        const arr = JSON.parse(body.faceDescriptor);
        ok = is128(arr) || (Array.isArray(arr) && arr.length >= 1 && arr.length <= 5 && arr.every(is128));
      } catch {
        ok = false;
      }
    }
    if (!ok) return res.status(400).json({ message: "Invalid face data" });
  }
  const [row] = await db
    .update(workersTable)
    .set(body)
    .where(estateScoped(workersTable.id, workersTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/workers/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  await db
    .update(workersTable)
    .set({ isActive: false })
    .where(estateScoped(workersTable.id, workersTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

router.get("/workers/:id/wages", async (req, res) => {
  const workerId = Number(req.params.id);
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const startDate = `${month}-01`;
  const [yr, mo] = month.split("-").map(Number);
  const lastDay = new Date(yr, mo, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

  const eid = await activeEstateId(req);
  const workers = await db
    .select()
    .from(workersTable)
    .where(estateScoped(workersTable.id, workersTable.estateId, workerId, eid));
  if (workers.length === 0) return res.status(404).json({ message: "Not found" });

  // Wages are earned per estate (via the work group the worker attended), so only
  // count attendance from the active estate's groups.
  const attConditions = [
    eq(attendanceTable.workerId, workerId),
    gte(attendanceTable.date, startDate),
    lte(attendanceTable.date, endDate),
  ];
  if (eid != null) {
    attConditions.push(inArray(attendanceTable.workGroupId, estateGroupIds(eid)));
  }
  const attRows = await db
    .select()
    .from(attendanceTable)
    .where(and(...attConditions));

  const totalDays = attRows.length;
  const totalHours = attRows.reduce((s, r) => s + Number(r.hoursWorked), 0);
  const totalWage = attRows.reduce((s, r) => s + Number(r.wageAmount), 0);

  const loanRows = await db
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.workerId, workerId), eid != null ? eq(loansTable.estateId, eid) : undefined));
  const pendingLoan = loanRows.reduce(
    (s, r) => s + (Number(r.totalDue) - Number(r.repaidAmount)),
    0
  );

  const loanIds = loanRows.map((r) => r.id);
  let loanDeductions = 0;
  if (loanIds.length > 0) {
    const paymentRows = await db
      .select({ amount: loanPaymentsTable.amount })
      .from(loanPaymentsTable)
      .where(
        and(
          sql`${loanPaymentsTable.loanId} = ANY(${sql.raw(`ARRAY[${loanIds.join(",")}]::integer[]`)})`,
          gte(loanPaymentsTable.date, startDate),
          lte(loanPaymentsTable.date, endDate)
        )
      );
    loanDeductions = paymentRows.reduce((s, r) => s + Number(r.amount), 0);
  }

  return res.json({
    workerId,
    workerName: workers[0].name,
    totalDays,
    totalHours,
    totalWage,
    loanDeductions,
    netPayable: totalWage - loanDeductions,
    pendingLoanBalance: pendingLoan,
    month,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Work Groups
// ──────────────────────────────────────────────────────────────────────────────

router.get("/work-groups", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select({
      id: workGroupsTable.id,
      name: workGroupsTable.name,
      cropId: workGroupsTable.cropId,
      cropName: cropsTable.name,
      blockName: workGroupsTable.blockName,
      category: workGroupsTable.category,
      labourType: workGroupsTable.labourType,
      paymentType: workGroupsTable.paymentType,
      rate: workGroupsTable.rate,
      advancePerUnit: workGroupsTable.advancePerUnit,
      payFrequency: workGroupsTable.payFrequency,
      targetQuantity: workGroupsTable.targetQuantity,
      targetUnit: workGroupsTable.targetUnit,
      notes: workGroupsTable.notes,
      loanTaken: workGroupsTable.loanTaken,
      loanNotes: workGroupsTable.loanNotes,
      upiId: workGroupsTable.upiId,
      isActive: workGroupsTable.isActive,
      createdAt: workGroupsTable.createdAt,
    })
    .from(workGroupsTable)
    .leftJoin(cropsTable, eq(workGroupsTable.cropId, cropsTable.id))
    .where(
      and(
        isNull(workGroupsTable.deletedAt),
        eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
      ),
    )
    .orderBy(desc(workGroupsTable.createdAt));

  // Aggregate attendance cost per work group in a single grouped query
  // instead of one query per work group (avoids an N+1 as groups grow).
  const costRows = await db
    .select({
      workGroupId: attendanceTable.workGroupId,
      total: sql<string>`coalesce(sum(wage_amount),0)`,
    })
    .from(attendanceTable)
    .groupBy(attendanceTable.workGroupId);

  const costMap = new Map(costRows.map((c) => [c.workGroupId, Number(c.total)]));
  const withCosts = rows.map((wg) => ({
    ...wg,
    totalCostToDate: costMap.get(wg.id) ?? 0,
  }));

  return res.json(withCosts);
});

router.post("/work-groups", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db
    .insert(workGroupsTable)
    .values({ ...body, estateId: eid })
    .returning();
  return res.status(201).json(row);
});

router.get("/work-groups/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(workGroupsTable)
    .where(estateScoped(workGroupsTable.id, workGroupsTable.estateId, Number(req.params.id), eid));
  // Groups in the recycle bin behave as deleted until restored.
  if (rows.length === 0 || rows[0].deletedAt != null) {
    return res.status(404).json({ message: "Not found" });
  }
  return res.json(rows[0]);
});

router.patch("/work-groups/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db
    .update(workGroupsTable)
    .set(body)
    .where(estateScoped(workGroupsTable.id, workGroupsTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

// Permanently delete a work group and every row that references it. Used by
// the recycle bin ("delete forever" + 30-day auto-purge). The group's children
// are removed inside a transaction (no ON DELETE CASCADE in the schema);
// loans belong to the worker and harvests to the crop, so those rows are kept
// and merely detached from the group.
async function hardDeleteWorkGroup(groupId: number) {
  await db.transaction(async (tx) => {
    await tx.delete(attendanceTable).where(eq(attendanceTable.workGroupId, groupId));
    await tx.delete(dailyWorkTable).where(eq(dailyWorkTable.workGroupId, groupId));
    await tx
      .delete(groupAdvancePaymentsTable)
      .where(eq(groupAdvancePaymentsTable.workGroupId, groupId));
    await tx
      .delete(groupWorkSessionsTable)
      .where(eq(groupWorkSessionsTable.workGroupId, groupId));
    await tx.update(loansTable).set({ workGroupId: null }).where(eq(loansTable.workGroupId, groupId));
    await tx
      .update(harvestsTable)
      .set({ workGroupId: null })
      .where(eq(harvestsTable.workGroupId, groupId));
    await tx.delete(workGroupsTable).where(eq(workGroupsTable.id, groupId));
  });
}

router.delete("/work-groups/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const groupId = Number(req.params.id);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  // Soft delete → recycle bin. Children stay intact so the group can be
  // restored from the bin; permanent cleanup happens via the bin routes.
  await db
    .update(workGroupsTable)
    .set({ deletedAt: new Date() })
    .where(eq(workGroupsTable.id, groupId));
  return res.status(204).end();
});

// ── Group Work Sessions ───────────────────────────────────────────────────────
// A session tracks a gang's day: check-in time+photo, up to 2 work-update
// photos in between, and check-out time+photo when they leave.

type UpdatePhoto = { takenAt: string; photo: string };

// Headcounts must be positive integers; anything else is treated as absent.
function parseHeadcount(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

router.get("/work-groups/:id/sessions", async (req, res) => {
  const eid = await activeEstateId(req);
  const groupId = Number(req.params.id);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const conds = [eq(groupWorkSessionsTable.workGroupId, groupId)];
  if (typeof req.query.date === "string") {
    conds.push(eq(groupWorkSessionsTable.date, req.query.date));
  }
  const rows = await db.select()
    .from(groupWorkSessionsTable)
    .where(and(...conds))
    .orderBy(desc(groupWorkSessionsTable.checkInAt));
  return res.json(rows);
});

// Check-in. Idempotent per group+date: if an open session already exists for
// that date, it is returned as-is (200) instead of creating a duplicate.
router.post("/work-groups/:id/sessions", async (req, res) => {
  const eid = await activeEstateId(req);
  const groupId = Number(req.params.id);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const { date, checkInPhoto, headcountIn } = req.body ?? {};
  const day = typeof date === "string" && date ? date : new Date().toISOString().slice(0, 10);
  const existing = await db.select()
    .from(groupWorkSessionsTable)
    .where(and(
      eq(groupWorkSessionsTable.workGroupId, groupId),
      eq(groupWorkSessionsTable.date, day),
      isNull(groupWorkSessionsTable.checkOutAt),
    ));
  if (existing.length > 0) {
    // Open session already exists — allow updating the headcount (e.g. the
    // "Total people working" field in the Mark Attendance form) and fill in
    // the arrival photo if it wasn't captured yet.
    const cur = existing[0];
    const patch: Partial<typeof groupWorkSessionsTable.$inferInsert> = {};
    const newCount = parseHeadcount(headcountIn);
    if (newCount != null && newCount !== cur.headcountIn) {
      patch.headcountIn = newCount;
    }
    if (checkInPhoto && !cur.checkInPhoto) patch.checkInPhoto = checkInPhoto;
    if (Object.keys(patch).length > 0) {
      const [row] = await db.update(groupWorkSessionsTable)
        .set(patch)
        .where(eq(groupWorkSessionsTable.id, cur.id))
        .returning();
      return res.json(row);
    }
    return res.json(cur);
  }
  try {
    const [row] = await db.insert(groupWorkSessionsTable).values({
      estateId: eid,
      workGroupId: groupId,
      date: day,
      checkInPhoto: checkInPhoto || null,
      headcountIn: parseHeadcount(headcountIn),
    }).returning();
    return res.status(201).json(row);
  } catch (err: unknown) {
    // Partial unique index (one open session per group+day) lost a race —
    // another request just created the session; return that one.
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      const [row] = await db.select()
        .from(groupWorkSessionsTable)
        .where(and(
          eq(groupWorkSessionsTable.workGroupId, groupId),
          eq(groupWorkSessionsTable.date, day),
          isNull(groupWorkSessionsTable.checkOutAt),
        ));
      if (row) return res.json(row);
    }
    throw err;
  }
});

// Add a work-update photo (max 2 per session, only while checked in).
router.post("/work-sessions/:id/update-photo", async (req, res) => {
  const eid = await activeEstateId(req);
  const sessionId = Number(req.params.id);
  const rows = await db.select().from(groupWorkSessionsTable)
    .where(eq(groupWorkSessionsTable.id, sessionId));
  const session = rows[0];
  if (!session || !(await groupInEstate(session.workGroupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  if (session.checkOutAt) {
    return res.status(400).json({ message: "Work already ended for this session" });
  }
  const photos = (session.updatePhotos as UpdatePhoto[] | null) ?? [];
  if (photos.length >= 2) {
    return res.status(400).json({ message: "Maximum 2 work photos per session" });
  }
  const { photo } = req.body ?? {};
  if (!photo || typeof photo !== "string") {
    return res.status(400).json({ message: "photo is required" });
  }
  const next = [...photos, { takenAt: new Date().toISOString(), photo }];
  // Guarded update: only applies while the session is still open and the
  // photo count hasn't changed under us (concurrent uploads/checkout).
  const [row] = await db.update(groupWorkSessionsTable)
    .set({ updatePhotos: next })
    .where(and(
      eq(groupWorkSessionsTable.id, sessionId),
      isNull(groupWorkSessionsTable.checkOutAt),
      sql`jsonb_array_length(${groupWorkSessionsTable.updatePhotos}) = ${photos.length}`,
    ))
    .returning();
  if (!row) {
    return res.status(409).json({ message: "Session changed — please refresh and try again" });
  }
  return res.json(row);
});

// Check-out: leaving time + last photo (+ optional AI leaving headcount).
router.post("/work-sessions/:id/checkout", async (req, res) => {
  const eid = await activeEstateId(req);
  const sessionId = Number(req.params.id);
  const rows = await db.select().from(groupWorkSessionsTable)
    .where(eq(groupWorkSessionsTable.id, sessionId));
  const session = rows[0];
  if (!session || !(await groupInEstate(session.workGroupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  if (session.checkOutAt) {
    return res.status(400).json({ message: "Already checked out" });
  }
  const { checkOutPhoto, headcountOut } = req.body ?? {};
  // Guarded update: a concurrent checkout can't overwrite the first one.
  const [row] = await db.update(groupWorkSessionsTable)
    .set({
      checkOutAt: new Date(),
      checkOutPhoto: checkOutPhoto || null,
      headcountOut: parseHeadcount(headcountOut),
    })
    .where(and(
      eq(groupWorkSessionsTable.id, sessionId),
      isNull(groupWorkSessionsTable.checkOutAt),
    ))
    .returning();
  if (!row) {
    return res.status(400).json({ message: "Already checked out" });
  }
  return res.json(row);
});

// ── Advance Payments ──────────────────────────────────────────────────────────

router.get("/work-groups/:id/advance-payments", async (req, res) => {
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(Number(req.params.id), eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const rows = await db.select()
    .from(groupAdvancePaymentsTable)
    .where(eq(groupAdvancePaymentsTable.workGroupId, Number(req.params.id)))
    .orderBy(desc(groupAdvancePaymentsTable.createdAt));
  return res.json(rows);
});

router.post("/work-groups/:id/advance-payments", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const { periodLabel, daysCount, workerCount, advancePerWorkerPerDay, paymentDate, notes } = req.body;
  const totalAdvancePaid = Number(daysCount) * Number(workerCount) * Number(advancePerWorkerPerDay);
  const [row] = await db.insert(groupAdvancePaymentsTable).values({
    workGroupId: groupId,
    paymentDate: paymentDate ?? new Date().toISOString().slice(0, 10),
    periodLabel,
    daysCount: Number(daysCount),
    workerCount: Number(workerCount),
    advancePerWorkerPerDay: String(advancePerWorkerPerDay),
    totalAdvancePaid: String(totalAdvancePaid),
    notes: notes || null,
  }).returning();
  return res.status(201).json(row);
});

router.delete("/work-groups/:id/advance-payments/:payId", async (req, res) => {
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(Number(req.params.id), eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  // Scope the delete to the named group too, so a payId from another group can't
  // be removed via this group's path.
  await db.delete(groupAdvancePaymentsTable)
    .where(and(
      eq(groupAdvancePaymentsTable.id, Number(req.params.payId)),
      eq(groupAdvancePaymentsTable.workGroupId, Number(req.params.id)),
    ));
  return res.status(204).end();
});

// Overtime money status for a group: pending (not yet paid out) vs cleared.
// Falls back to the group's day-rate/8 (or hourly rate) when a row predates
// having its own overtimeRate.
router.get("/work-groups/:id/overtime-summary", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const [grp] = await db.select().from(workGroupsTable).where(eq(workGroupsTable.id, groupId));
  const rows = await db
    .select({ h: attendanceTable.overtimeHours, r: attendanceTable.overtimeRate, paidAt: attendanceTable.overtimePaidAt })
    .from(attendanceTable)
    .where(and(eq(attendanceTable.workGroupId, groupId), isNotNull(attendanceTable.overtimeHours)));
  const fallbackRate = grp ? (grp.paymentType === "Per hour" ? Number(grp.rate) : Number(grp.rate) / 8) : 0;
  let pendingHours = 0, pendingAmount = 0, clearedAmount = 0;
  for (const row of rows) {
    const amt = Number(row.h ?? 0) * (Number(row.r ?? 0) || fallbackRate);
    if (row.paidAt) clearedAmount += amt;
    else { pendingHours += Number(row.h ?? 0); pendingAmount += amt; }
  }
  return res.json({
    overtimeSettlement: grp?.overtimeSettlement ?? "weekly",
    pendingHours,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
    clearedAmount: Math.round(clearedAmount * 100) / 100,
  });
});

// Manually mark all pending overtime for a group as paid out.
router.post("/work-groups/:id/overtime/settle", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const rawClientId = req.body?.clientId;
  const clientId = typeof rawClientId === "string" && rawClientId.trim() !== "" ? rawClientId : null;

  // Idempotent replay: a double tap or offline retry re-sends the same
  // clientId. If the payout ledger row for this clientId already exists, the
  // settle already ran - return the stored result without touching anything.
  if (clientId) {
    const [existing] = await db.select().from(groupAdvancePaymentsTable)
      .where(and(eq(groupAdvancePaymentsTable.clientId, clientId), eq(groupAdvancePaymentsTable.workGroupId, groupId)))
      .limit(1);
    if (existing) return res.json({ clearedCount: 0, clearedAmount: Number(existing.totalAdvancePaid) });
  }

  const [grp] = await db.select().from(workGroupsTable).where(eq(workGroupsTable.id, groupId));
  const { clearedCount, amount } = await db.transaction(async (tx) => {
    const cleared = await tx
      .update(attendanceTable)
      .set({ overtimePaidAt: new Date() })
      .where(and(eq(attendanceTable.workGroupId, groupId), isNotNull(attendanceTable.overtimeHours), isNull(attendanceTable.overtimePaidAt)))
      .returning({ h: attendanceTable.overtimeHours, r: attendanceTable.overtimeRate });
    const fallbackRate = grp ? (grp.paymentType === "Per hour" ? Number(grp.rate) : Number(grp.rate) / 8) : 0;
    const amt = Math.round(cleared.reduce((s, c) => s + Number(c.h ?? 0) * (Number(c.r ?? 0) || fallbackRate), 0) * 100) / 100;
    if (amt > 0) {
      const insert = tx.insert(groupAdvancePaymentsTable).values({
        workGroupId: groupId,
        paymentDate: new Date().toISOString().slice(0, 10),
        periodLabel: "Overtime payout",
        daysCount: 1,
        workerCount: 1,
        advancePerWorkerPerDay: String(amt),
        totalAdvancePaid: String(amt),
        notes: "Overtime marked as paid",
        clientId,
      });
      if (clientId) await insert.onConflictDoNothing({ target: groupAdvancePaymentsTable.clientId });
      else await insert;
    }
    return { clearedCount: cleared.length, amount: amt };
  });
  return res.json({ clearedCount, clearedAmount: amount });
});

// Picking-bonus money status for a group: pending (not yet paid out) vs
// cleared. Bonus per day = max(0, kg - threshold) * bonusPerKg from the
// group's current rule; rows with kg but no rule contribute 0.
router.get("/work-groups/:id/harvest-bonus-summary", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const [grp] = await db.select().from(workGroupsTable).where(eq(workGroupsTable.id, groupId));
  const threshold = Number(grp?.harvestThresholdKg ?? 0);
  const perKg = Number(grp?.harvestBonusPerKg ?? 0);
  const rows = await db
    .select({ kg: attendanceTable.harvestedKg, paidAt: attendanceTable.harvestBonusPaidAt })
    .from(attendanceTable)
    .where(and(eq(attendanceTable.workGroupId, groupId), isNotNull(attendanceTable.harvestedKg)));
  let pendingKg = 0, pendingAmount = 0, clearedAmount = 0;
  for (const r of rows) {
    const amt = threshold > 0 && perKg > 0 ? Math.max(0, Number(r.kg ?? 0) - threshold) * perKg : 0;
    if (r.paidAt) clearedAmount += amt;
    else { pendingKg += Number(r.kg ?? 0); pendingAmount += amt; }
  }
  return res.json({
    harvestBonusSettlement: grp?.harvestBonusSettlement ?? "weekly",
    pendingKg,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
    clearedAmount: Math.round(clearedAmount * 100) / 100,
  });
});

// Manually mark all pending picking bonus for a group as paid out.
router.post("/work-groups/:id/harvest-bonus/settle", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }
  const rawClientId = req.body?.clientId;
  const clientId = typeof rawClientId === "string" && rawClientId.trim() !== "" ? rawClientId : null;
  if (clientId) {
    const [existing] = await db.select().from(groupAdvancePaymentsTable)
      .where(and(eq(groupAdvancePaymentsTable.clientId, clientId), eq(groupAdvancePaymentsTable.workGroupId, groupId)))
      .limit(1);
    if (existing) return res.json({ clearedCount: 0, clearedAmount: Number(existing.totalAdvancePaid) });
  }
  const [grp] = await db.select().from(workGroupsTable).where(eq(workGroupsTable.id, groupId));
  const threshold = Number(grp?.harvestThresholdKg ?? 0);
  const perKg = Number(grp?.harvestBonusPerKg ?? 0);
  const { clearedCount, amount } = await db.transaction(async (tx) => {
    const cleared = await tx
      .update(attendanceTable)
      .set({ harvestBonusPaidAt: new Date() })
      .where(and(eq(attendanceTable.workGroupId, groupId), isNotNull(attendanceTable.harvestedKg), isNull(attendanceTable.harvestBonusPaidAt)))
      .returning({ kg: attendanceTable.harvestedKg });
    const amt = threshold > 0 && perKg > 0
      ? Math.round(cleared.reduce((s, c) => s + Math.max(0, Number(c.kg ?? 0) - threshold) * perKg, 0) * 100) / 100
      : 0;
    if (amt > 0) {
      const insert = tx.insert(groupAdvancePaymentsTable).values({
        workGroupId: groupId,
        paymentDate: new Date().toISOString().slice(0, 10),
        periodLabel: "Picking bonus payout",
        daysCount: 1,
        workerCount: 1,
        advancePerWorkerPerDay: String(amt),
        totalAdvancePaid: String(amt),
        notes: "Picking bonus marked as paid",
        clientId,
      });
      if (clientId) await insert.onConflictDoNothing({ target: groupAdvancePaymentsTable.clientId });
      else await insert;
    }
    return { clearedCount: cleared.length, amount: amt };
  });
  return res.json({ clearedCount, clearedAmount: amount });
});

// ── Direct worker/group payments ─────────────────────────────────────────────
// The owner's own ledger of payments made to labourers (cash / UPI / wallet /
// bank). The app never moves money itself: for digital methods it deep-links
// the owner's own payment app and the owner completes the payment there, then
// records it here.

router.get("/worker-payments", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const conditions = [eid != null ? eq(workerPaymentsTable.estateId, eid) : undefined];
  const groupId = req.query.workGroupId != null ? Number(req.query.workGroupId) : null;
  if (groupId != null && Number.isFinite(groupId)) {
    conditions.push(eq(workerPaymentsTable.workGroupId, groupId));
  }
  const rows = await db.select()
    .from(workerPaymentsTable)
    .where(and(...conditions.filter((c): c is NonNullable<typeof c> => c != null)))
    .orderBy(desc(workerPaymentsTable.createdAt));
  return res.json(rows);
});

router.post("/worker-payments", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, workerId, workGroupId, payeeName, amount, method, methodLabel, payeeHandle, paymentDate, note, clientId } = req.body ?? {};

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 10_000_000) {
    return res.status(400).json({ message: "Enter a valid amount" });
  }
  if (!payeeName || typeof payeeName !== "string" || !payeeName.trim() || payeeName.length > 200) {
    return res.status(400).json({ message: "Payee name is required" });
  }
  if ((typeof note === "string" && note.length > 500) || (typeof payeeHandle === "string" && payeeHandle.length > 200)) {
    return res.status(400).json({ message: "Text too long" });
  }
  const allowedMethods = ["cash", "upi", "bank", "wallet", "other"];
  if (!allowedMethods.includes(method)) {
    return res.status(400).json({ message: "Invalid payment method" });
  }
  // Client-supplied FKs must belong to the active estate (no cross-estate rows).
  if (workerId != null && !(await workerInEstate(Number(workerId), eid))) {
    return res.status(404).json({ message: "Worker not found" });
  }
  if (workGroupId != null && !(await groupInEstate(Number(workGroupId), eid))) {
    return res.status(404).json({ message: "Work group not found" });
  }

  const values = {
    estateId: eid,
    workerId: workerId != null ? Number(workerId) : null,
    workGroupId: workGroupId != null ? Number(workGroupId) : null,
    payeeName: payeeName.trim(),
    amount: String(amt),
    method,
    methodLabel: methodLabel || null,
    payeeHandle: payeeHandle || null,
    paymentDate: paymentDate ?? new Date().toISOString().slice(0, 10),
    note: note || null,
    clientId: typeof clientId === "string" && clientId.trim() !== "" ? clientId : null,
  };

  // Idempotent replay: a flaky network can drop the response after the row was
  // committed; the offline queue then re-sends the same clientId. Never insert a
  // duplicate money record — return the row already stored.
  let row;
  if (values.clientId) {
    const [inserted] = await db.insert(workerPaymentsTable).values(values)
      .onConflictDoNothing({ target: workerPaymentsTable.clientId })
      .returning();
    if (inserted) {
      row = inserted;
    } else {
      const [existing] = await db.select().from(workerPaymentsTable)
        .where(
          eid != null
            ? and(eq(workerPaymentsTable.clientId, values.clientId), eq(workerPaymentsTable.estateId, eid))
            : eq(workerPaymentsTable.clientId, values.clientId)
        )
        .limit(1);
      if (!existing) return res.status(404).json({ message: "Not found" });
      // Replay of an already-saved payment: skip the payee-handle side effect too.
      return res.status(200).json(existing);
    }
  } else {
    [row] = await db.insert(workerPaymentsTable).values(values).returning();
  }

  // Remember the payee handle on the worker/group so next payment is one tap.
  if (payeeHandle && typeof payeeHandle === "string") {
    if (workerId != null) {
      await db.update(workersTable).set({ upiId: payeeHandle })
        .where(estateScoped(workersTable.id, workersTable.estateId, Number(workerId), eid));
    } else if (workGroupId != null) {
      await db.update(workGroupsTable).set({ upiId: payeeHandle })
        .where(estateScoped(workGroupsTable.id, workGroupsTable.estateId, Number(workGroupId), eid));
    }
  }
  return res.status(201).json(row);
});

router.delete("/worker-payments/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  await db.delete(workerPaymentsTable)
    .where(estateScoped(workerPaymentsTable.id, workerPaymentsTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

// ── Season-end AI accounting ─────────────────────────────────────────────────

router.post("/work-groups/:id/season-end", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);

  const [group] = await db.select().from(workGroupsTable)
    .where(
      and(
        eq(workGroupsTable.id, groupId),
        isNull(workGroupsTable.deletedAt),
        eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
      ),
    );
  if (!group) return res.status(404).json({ error: "Group not found" });

  const allAttendance = await db.select({
    workerId: attendanceTable.workerId,
    workerName: workersTable.name,
    wageAmount: attendanceTable.wageAmount,
  })
    .from(attendanceTable)
    .leftJoin(workersTable, eq(attendanceTable.workerId, workersTable.id))
    .where(eq(attendanceTable.workGroupId, groupId));

  const payments = await db.select()
    .from(groupAdvancePaymentsTable)
    .where(eq(groupAdvancePaymentsTable.workGroupId, groupId));

  const workerMap = new Map<number, { name: string; days: number; earned: number }>();
  for (const att of allAttendance) {
    if (!workerMap.has(att.workerId)) {
      workerMap.set(att.workerId, { name: att.workerName ?? "Unknown", days: 0, earned: 0 });
    }
    const w = workerMap.get(att.workerId)!;
    w.days += 1;
    w.earned += Number(att.wageAmount);
  }

  const totalAdvancePaid = payments.reduce((s, p) => s + Number(p.totalAdvancePaid), 0);
  const totalEarned = [...workerMap.values()].reduce((s, w) => s + w.earned, 0);
  const totalRemaining = totalEarned - totalAdvancePaid;
  const workerCount = workerMap.size || 1;

  const workerLines = [...workerMap.values()]
    .map(w => `  - ${w.name}: ${w.days} days worked, ₹${w.earned.toLocaleString("en-IN")} earned, approx ₹${Math.round(totalAdvancePaid / workerCount).toLocaleString("en-IN")} advance paid, balance ₹${Math.round(w.earned - totalAdvancePaid / workerCount).toLocaleString("en-IN")}`).join("\n");
  const paymentLines = payments
    .map(p => `  - ${p.periodLabel} (${p.paymentDate}): ${p.workerCount} workers × ${p.daysCount} days × ₹${p.advancePerWorkerPerDay}/day = ₹${Number(p.totalAdvancePaid).toLocaleString("en-IN")}`)
    .join("\n") || "  No advance payments recorded.";

  const prompt = `You are an agricultural estate accountant helping an Indian farmer do final season settlement.

Work Group: "${group.name}"
Category: ${group.category}
Rate: ₹${group.rate} per day
Advance per day paid: ₹${group.advancePerUnit ?? "not set"}
Payment frequency: ${group.payFrequency}

Worker Summary:
${workerLines || "  No attendance recorded."}

Advance Payments Made:
${paymentLines}

Totals:
  Total wages earned: ₹${totalEarned.toLocaleString("en-IN")}
  Total advance paid: ₹${totalAdvancePaid.toLocaleString("en-IN")}
  Net remaining to pay: ₹${totalRemaining.toLocaleString("en-IN")}

Write a clear final season account in simple Hindi-English (Hinglish) language suitable for an Indian farm owner. Include:
1. A 2-line season summary
2. Per-worker settlement table (name | days | earned | advance paid | final balance)
3. Total settlement line
4. One sentence about closing the account

Keep it short, practical, and formatted with clear sections.`;

  const aiResp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 900,
  });

  const aiSummary = aiResp.choices[0]?.message?.content ?? "";

  await db.update(workGroupsTable)
    .set({ seasonClosed: true, seasonSummary: aiSummary })
    .where(eq(workGroupsTable.id, groupId));

  return res.json({
    aiSummary,
    totals: { totalEarned, totalAdvancePaid, totalRemaining },
    workerCount,
  });
});

// ── Loans for a work group ────────────────────────────────────────────────────

router.get("/work-groups/:id/loans", async (req, res) => {
  const groupId = Number(req.params.id);
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ message: "Not found" });
  }

  // Distinct worker IDs who attended this group
  const workerRows = await db
    .selectDistinct({ workerId: attendanceTable.workerId })
    .from(attendanceTable)
    .where(eq(attendanceTable.workGroupId, groupId));

  const workerIds = workerRows.map((r) => r.workerId);

  // A loan belongs in this group's view if it is tagged to the group directly
  // (loans added from the Loans section folder or this page's loan form) OR its
  // worker has attended this group (legacy loans recorded before group tagging).
  const membership =
    workerIds.length > 0
      ? or(
          eq(loansTable.workGroupId, groupId),
          inArray(loansTable.workerId, workerIds),
        )
      : eq(loansTable.workGroupId, groupId);

  const loans = await db
    .select({
      id: loansTable.id,
      workerId: loansTable.workerId,
      workerName: workersTable.name,
      workGroupId: loansTable.workGroupId,
      workGroupName: workGroupsTable.name,
      amount: loansTable.amount,
      totalDue: loansTable.totalDue,
      repaidAmount: loansTable.repaidAmount,
      issuedDate: loansTable.issuedDate,
      dueDate: loansTable.dueDate,
      status: loansTable.status,
      proofPhotoUrl: loansTable.proofPhotoUrl,
      notes: loansTable.notes,
      repaymentMethod: loansTable.repaymentMethod,
      createdAt: loansTable.createdAt,
    })
    .from(loansTable)
    .leftJoin(workersTable, eq(loansTable.workerId, workersTable.id))
    .leftJoin(workGroupsTable, eq(loansTable.workGroupId, workGroupsTable.id))
    .where(and(
      membership,
      eid != null ? eq(loansTable.estateId, eid) : undefined,
    ))
    .orderBy(desc(loansTable.createdAt));

  return res.json(loans.map((l) => ({
    ...l,
    remainingAmount: Math.max(0, Number(l.totalDue) - Number(l.repaidAmount)),
  })));
});

// ──────────────────────────────────────────────────────────────────────────────
// Attendance
// ──────────────────────────────────────────────────────────────────────────────

router.get("/attendance", requireActiveSubscription, async (req, res) => {
  const { workGroupId, date } = req.query as Record<string, string>;
  const eid = await activeEstateId(req);
  const conditions = [];
  if (eid != null) conditions.push(inArray(attendanceTable.workGroupId, estateGroupIds(eid)));
  if (workGroupId) conditions.push(eq(attendanceTable.workGroupId, Number(workGroupId)));
  if (date) conditions.push(eq(attendanceTable.date, date));

  const rows = await db
    .select({
      id: attendanceTable.id,
      workGroupId: attendanceTable.workGroupId,
      workGroupName: workGroupsTable.name,
      workerId: attendanceTable.workerId,
      workerName: workersTable.name,
      date: attendanceTable.date,
      hoursWorked: attendanceTable.hoursWorked,
      overtimeHours: attendanceTable.overtimeHours,
      overtimeRate: attendanceTable.overtimeRate,
      wageAmount: attendanceTable.wageAmount,
      harvestedKg: attendanceTable.harvestedKg,
      harvestCrop: attendanceTable.harvestCrop,
      notes: attendanceTable.notes,
      createdAt: attendanceTable.createdAt,
    })
    .from(attendanceTable)
    .leftJoin(workGroupsTable, eq(attendanceTable.workGroupId, workGroupsTable.id))
    .leftJoin(workersTable, eq(attendanceTable.workerId, workersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(attendanceTable.date));

  return res.json(rows);
});

router.post("/attendance", requireActiveSubscription, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const workGroupId = Number(b.workGroupId);
  const workerId = Number(b.workerId);
  const date = String(b.date ?? "");
  if (!workGroupId || !workerId || !date) {
    return res
      .status(400)
      .json({ error: "workGroupId, workerId and date are required" });
  }
  // The work group must belong to the active estate — otherwise a client could
  // record attendance against another estate's group by passing its id.
  const eid = await activeEstateId(req);
  if (!(await groupInEstate(workGroupId, eid))) {
    return res.status(404).json({ error: "Work group not found" });
  }
  const deviceLabel =
    typeof b.deviceLabel === "string" && b.deviceLabel.trim() !== ""
      ? b.deviceLabel.trim()
      : null;
  const incoming = {
    hoursWorked: String(b.hoursWorked ?? "0"),
    // Overtime pay and picking bonus are already folded into wageAmount by
    // the client - these fields are kept purely for display/settlement.
    overtimeHours: b.overtimeHours != null && Number(b.overtimeHours) > 0 ? String(b.overtimeHours) : null,
    overtimeRate:
      b.overtimeHours != null && Number(b.overtimeHours) > 0 && b.overtimeRate != null && Number(b.overtimeRate) > 0
        ? String(b.overtimeRate)
        : null,
    wageAmount: String(b.wageAmount ?? "0"),
    harvestedKg: b.harvestedKg != null && Number(b.harvestedKg) > 0 ? String(b.harvestedKg) : null,
    harvestCrop: typeof b.harvestCrop === "string" && b.harvestCrop.trim() !== "" ? b.harvestCrop.trim() : null,
    notes: typeof b.notes === "string" && b.notes.trim() !== "" ? b.notes : null,
  };

  // Idempotent: marking the same worker present in the same group on the same day
  // must not create duplicates. Offline devices replay queued marks at-least-once,
  // so a re-send must not double-charge wages — we match on the natural key.
  const [existing] = await db
    .select()
    .from(attendanceTable)
    .where(
      and(
        eq(attendanceTable.workGroupId, workGroupId),
        eq(attendanceTable.workerId, workerId),
        eq(attendanceTable.date, date),
      ),
    )
    .limit(1);

  if (existing) {
    // Compare numbers numerically: the DB stores decimals as "8.00"/"400.00"
    // while a replay sends "8"/"400". A string compare would treat an identical
    // re-send as a conflict and spam the log, so normalize before comparing.
    const changed =
      Number(existing.hoursWorked) !== Number(incoming.hoursWorked) ||
      Number(existing.wageAmount) !== Number(incoming.wageAmount) ||
      Number(existing.overtimeHours ?? 0) !== Number(incoming.overtimeHours ?? 0) ||
      Number(existing.overtimeRate ?? 0) !== Number(incoming.overtimeRate ?? 0) ||
      Number(existing.harvestedKg ?? 0) !== Number(incoming.harvestedKg ?? 0) ||
      (existing.notes ?? null) !== incoming.notes;
    // Identical re-send = a harmless at-least-once replay, not a real conflict.
    if (!changed) return res.status(200).json(existing);

    // Two devices recorded different values for the same worker/group/day.
    // Last write wins, but we never drop the old value silently — log it so the
    // owner can review what changed and who changed it.
    const [updated] = await db
      .update(attendanceTable)
      .set({ ...incoming, lastEditedBy: deviceLabel })
      .where(eq(attendanceTable.id, existing.id))
      .returning();
    await db.insert(syncConflictsTable).values({
      entityType: "attendance",
      entityId: existing.id,
      workGroupId,
      summary: `Attendance for the same worker on ${date} was changed by a second device. Latest value kept.`,
      previousValue: {
        hoursWorked: String(existing.hoursWorked),
        wageAmount: String(existing.wageAmount),
        overtimeHours: existing.overtimeHours != null ? String(existing.overtimeHours) : null,
        harvestedKg: existing.harvestedKg != null ? String(existing.harvestedKg) : null,
        notes: existing.notes ?? null,
      },
      newValue: incoming,
      previousDevice: existing.lastEditedBy ?? null,
      newDevice: deviceLabel,
      resolution: "last-write-wins",
    });
    return res.status(200).json(updated);
  }

  // No row existed when we read. Insert, but upsert onto the natural key so a
  // concurrent at-least-once replay (two devices flushing the same mark at once)
  // can never create a duplicate row that double-charges wages — the loser of
  // the race becomes a last-write-wins update instead.
  const [row] = await db
    .insert(attendanceTable)
    .values({
      workGroupId,
      workerId,
      date,
      ...incoming,
      lastEditedBy: deviceLabel,
    })
    .onConflictDoUpdate({
      target: [
        attendanceTable.workGroupId,
        attendanceTable.workerId,
        attendanceTable.date,
      ],
      set: { ...incoming, lastEditedBy: deviceLabel },
    })
    .returning();
  return res.status(201).json(row);
});

// ── Sync conflict log (last-write-wins audit trail for the owner) ──────────────
router.get("/sync-conflicts", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select({
      id: syncConflictsTable.id,
      entityType: syncConflictsTable.entityType,
      entityId: syncConflictsTable.entityId,
      workGroupId: syncConflictsTable.workGroupId,
      workGroupName: workGroupsTable.name,
      summary: syncConflictsTable.summary,
      previousValue: syncConflictsTable.previousValue,
      newValue: syncConflictsTable.newValue,
      previousDevice: syncConflictsTable.previousDevice,
      newDevice: syncConflictsTable.newDevice,
      resolution: syncConflictsTable.resolution,
      createdAt: syncConflictsTable.createdAt,
    })
    .from(syncConflictsTable)
    .leftJoin(workGroupsTable, eq(syncConflictsTable.workGroupId, workGroupsTable.id))
    // Conflicts are work-group bound; scope them to the active estate via the group.
    .where(eid != null ? inArray(syncConflictsTable.workGroupId, estateGroupIds(eid)) : undefined)
    .orderBy(desc(syncConflictsTable.createdAt))
    .limit(100);
  return res.json(rows);
});

// ── Helpline: questions & suggestions sent to the Chiguru team ─────────────────
router.get("/help-messages", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(helpMessagesTable)
    .where(eid != null ? eq(helpMessagesTable.estateId, eid) : undefined)
    .orderBy(desc(helpMessagesTable.createdAt))
    .limit(100);
  return res.json(rows);
});

// AI auto-answers "question" type help messages instantly. "suggestion" type
// stays open for the Chiguru team to review and reply manually.
async function answerHelpQuestion(estateId: number, question: string): Promise<string | null> {
  try {
    const [profile, crops] = await Promise.all([
      db.select().from(farmProfileTable).where(eq(farmProfileTable.id, estateId)).limit(1).then((r) => r[0]),
      db.select().from(cropsTable).where(eq(cropsTable.estateId, estateId)),
    ]);
    const farmContext = profile
      ? `FARM: ${profile.farmName} | ${profile.village}, ${profile.district}, ${profile.state} | ${profile.totalAcres} acres | Crops: ${crops.map((c) => `${c.name} (${c.acres} ac)`).join(", ") || "not specified"}`
      : "Farm profile not yet set up.";

    const systemPrompt = `You are the Chiguru helpline assistant. Chiguru is a mobile app for Indian smallholder farmers. A farmer has asked a question on the help page — solve their problem directly, right now, in your reply.

${farmContext}

CHIGURU APP FEATURES (for "how do I…" questions):
- Dashboard (home): today's summary, quick actions, MORE grid with all features.
- Attendance: mark workers present/absent daily, organised into work groups; workers can be moved between groups from the worker's detail page.
- Expenses: record daily costs by category; Reports show totals and charts.
- Harvests & Sprays: log harvest weight/price and spray products per date.
- Loans: track loans and repayments.
- Shop / Nursery: browse and list plants for sale.
- Agri Doctor & Plant Scan: photo-based disease detection with AI treatment advice.
- Manager Device: a companion app for the estate manager to mark attendance and send work updates that sync to the owner.
- Profile & Data backup: sign in with Google to back up data; a backup code can restore a farm on a new phone.
- Language: 7 languages available from the menu (top-right ☰ → Language).
- The app works offline — records save on the phone and sync when internet returns.

Guidelines:
- Answer in the same language the farmer wrote in.
- Give clear, numbered steps in simple words. Keep it short and practical.
- For farming/agronomy questions, give practical advice suited to Indian conditions; for exact chemical dosages tell them to use the Agri Doctor feature in the app, and to confirm with their local KVK for serious cases.
- If the question is about something the app cannot do yet, say so honestly and tell them it has been noted for the team.
- Never invent app features that are not listed above.
- Reply as "Chiguru Helpline". NEVER say you are an AI, a bot, an assistant or a language model — even if asked directly. If asked who you are, say you are the Chiguru helpline team.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim();
    return answer || null;
  } catch (err) {
    console.error("Help AI answer failed:", err);
    return null;
  }
}

router.post("/help-messages", async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) return res.status(400).json({ message: "No active farm" });
  const { type, message, phone } = req.body ?? {};
  if (type !== "question" && type !== "suggestion") {
    return res.status(400).json({ message: "Invalid type" });
  }
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > 2000) {
    return res.status(400).json({ message: "Message must be 1–2000 characters" });
  }
  const phoneVal =
    typeof phone === "string" && phone.trim() ? phone.trim().slice(0, 20) : null;
  const [row] = await db
    .insert(helpMessagesTable)
    .values({ estateId: eid, type, message: text, phone: phoneVal })
    .returning();

  // Questions: AI solves the problem in the background so this request returns
  // fast (the offline-first client aborts slow requests and re-queues them,
  // which would create duplicates). If the AI call fails, the message stays
  // "open" so the team can reply manually — no silent loss.
  // Suggestions: email the owner in the background (fails softly until the
  // owner connects their Gmail — the suggestion always stays in the DB).
  if (type === "suggestion") {
    void db
      .select({ farmName: farmProfileTable.farmName })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.id, eid))
      .limit(1)
      .then(([p]) =>
        sendSuggestionEmail({
          farmName: p?.farmName ?? null,
          message: text,
          phone: phoneVal,
          createdAt: row.createdAt ?? new Date(),
        }),
      )
      .catch((err) => console.warn("Suggestion email failed:", err));
  }

  if (type === "question") {
    void answerHelpQuestion(eid, text)
      .then(async (answer) => {
        if (!answer) return;
        await db
          .update(helpMessagesTable)
          .set({ reply: answer, status: "replied", repliedAt: new Date() })
          .where(eq(helpMessagesTable.id, row.id));
      })
      .catch((err) => console.error("Help AI background answer failed:", err));
  }
  return res.status(201).json(row);
});

router.patch("/attendance/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  // Block re-parenting the row to a work group outside the active estate.
  if (
    req.body?.workGroupId != null &&
    !(await groupInEstate(Number(req.body.workGroupId), eid))
  ) {
    return res.status(404).json({ message: "Work group not found" });
  }
  const where =
    eid != null
      ? and(eq(attendanceTable.id, id), inArray(attendanceTable.workGroupId, estateGroupIds(eid)))
      : eq(attendanceTable.id, id);
  const [row] = await db.update(attendanceTable).set(req.body).where(where).returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/attendance/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  const where =
    eid != null
      ? and(eq(attendanceTable.id, id), inArray(attendanceTable.workGroupId, estateGroupIds(eid)))
      : eq(attendanceTable.id, id);
  await db.delete(attendanceTable).where(where);
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Daily Work
// ──────────────────────────────────────────────────────────────────────────────

router.get("/daily-work", async (req, res) => {
  const { workGroupId, date } = req.query as Record<string, string>;
  const eid = await activeEstateId(req);
  const conditions = [];
  if (eid != null) conditions.push(inArray(dailyWorkTable.workGroupId, estateGroupIds(eid)));
  if (workGroupId) conditions.push(eq(dailyWorkTable.workGroupId, Number(workGroupId)));
  if (date) conditions.push(eq(dailyWorkTable.date, date));

  const rows = await db
    .select({
      id: dailyWorkTable.id,
      workGroupId: dailyWorkTable.workGroupId,
      workGroupName: workGroupsTable.name,
      date: dailyWorkTable.date,
      quantityDone: dailyWorkTable.quantityDone,
      quantityUnit: dailyWorkTable.quantityUnit,
      materialUsed: dailyWorkTable.materialUsed,
      materialQty: dailyWorkTable.materialQty,
      materialUnit: dailyWorkTable.materialUnit,
      photoUrl: dailyWorkTable.photoUrl,
      notes: dailyWorkTable.notes,
      createdAt: dailyWorkTable.createdAt,
    })
    .from(dailyWorkTable)
    .leftJoin(workGroupsTable, eq(dailyWorkTable.workGroupId, workGroupsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(dailyWorkTable.date));

  return res.json(rows);
});

router.post("/daily-work", async (req, res) => {
  // The work group must belong to the active estate to block cross-estate writes.
  const eid = await activeEstateId(req);
  const groupId = Number((req.body as Record<string, unknown>).workGroupId);
  if (!(await groupInEstate(groupId, eid))) {
    return res.status(404).json({ error: "Work group not found" });
  }
  const [row] = await db.insert(dailyWorkTable).values(req.body).returning();
  return res.status(201).json(row);
});

router.patch("/daily-work/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  // Block re-parenting the row to a work group outside the active estate.
  if (
    req.body?.workGroupId != null &&
    !(await groupInEstate(Number(req.body.workGroupId), eid))
  ) {
    return res.status(404).json({ message: "Work group not found" });
  }
  const where =
    eid != null
      ? and(eq(dailyWorkTable.id, id), inArray(dailyWorkTable.workGroupId, estateGroupIds(eid)))
      : eq(dailyWorkTable.id, id);
  const [row] = await db.update(dailyWorkTable).set(req.body).where(where).returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/daily-work/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  const where =
    eid != null
      ? and(eq(dailyWorkTable.id, id), inArray(dailyWorkTable.workGroupId, estateGroupIds(eid)))
      : eq(dailyWorkTable.id, id);
  await db.delete(dailyWorkTable).where(where);
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Expenses
// ──────────────────────────────────────────────────────────────────────────────

router.get("/expenses", requireActiveSubscription, async (req, res) => {
  const { cropId, category, startDate, endDate } = req.query as Record<string, string>;
  const eid = await activeEstateId(req);
  const conditions = [];
  if (eid != null) conditions.push(eq(expensesTable.estateId, eid));
  if (cropId) conditions.push(eq(expensesTable.cropId, Number(cropId)));
  if (category) conditions.push(eq(expensesTable.category, category));
  if (startDate) conditions.push(gte(expensesTable.date, startDate));
  if (endDate) conditions.push(lte(expensesTable.date, endDate));

  const rows = await db
    .select({
      id: expensesTable.id,
      date: expensesTable.date,
      cropId: expensesTable.cropId,
      cropName: cropsTable.name,
      category: expensesTable.category,
      amount: expensesTable.amount,
      description: expensesTable.description,
      vendor: expensesTable.vendor,
      receiptUrl: expensesTable.receiptUrl,
      addedBy: expensesTable.addedBy,
      createdAt: expensesTable.createdAt,
    })
    .from(expensesTable)
    .leftJoin(cropsTable, eq(expensesTable.cropId, cropsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(expensesTable.date));

  return res.json(rows.map(({ receiptUrl, ...r }) => ({ ...r, hasReceipt: receiptUrl != null })));
});

router.get("/expenses/:id/receipt", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const [row] = await db
    .select({ receiptUrl: expensesTable.receiptUrl })
    .from(expensesTable)
    .where(estateScoped(expensesTable.id, expensesTable.estateId, Number(req.params.id), eid));
  if (!row || !row.receiptUrl) return res.status(404).json({ message: "No receipt" });
  return res.json({ receiptUrl: row.receiptUrl });
});

const MAX_RECEIPT_CHARS = 700_000; // ~500 KB of image data

function invalidReceipt(receiptUrl: unknown): string | null {
  if (receiptUrl == null) return null;
  if (typeof receiptUrl !== "string") return "Invalid receipt image";
  if (!receiptUrl.startsWith("data:image/")) return "Invalid receipt image";
  if (receiptUrl.length > MAX_RECEIPT_CHARS) return "Receipt photo is too large";
  return null;
}

router.post("/expenses", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  const receiptErr = invalidReceipt(body.receiptUrl);
  if (receiptErr) return res.status(413).json({ message: receiptErr });
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const addedBy =
    typeof body.addedBy === "string" && body.addedBy.trim()
      ? body.addedBy.trim().slice(0, 100)
      : null;
  const [row] = await db
    .insert(expensesTable)
    .values({ ...body, addedBy, estateId: eid })
    .returning();
  return res.status(201).json(row);
});

router.patch("/expenses/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  const receiptErr = invalidReceipt(body.receiptUrl);
  if (receiptErr) return res.status(413).json({ message: receiptErr });
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db
    .update(expensesTable)
    .set(body)
    .where(estateScoped(expensesTable.id, expensesTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/expenses/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  await db
    .delete(expensesTable)
    .where(estateScoped(expensesTable.id, expensesTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Sprays
// ──────────────────────────────────────────────────────────────────────────────

router.get("/sprays", async (req, res) => {
  const { cropId } = req.query as Record<string, string>;
  const eid = await activeEstateId(req);
  const conditions = [];
  if (eid != null) conditions.push(eq(spraysTable.estateId, eid));
  if (cropId) conditions.push(eq(spraysTable.cropId, Number(cropId)));

  const rows = await db
    .select({
      id: spraysTable.id,
      date: spraysTable.date,
      cropId: spraysTable.cropId,
      cropName: cropsTable.name,
      blockName: spraysTable.blockName,
      productName: spraysTable.productName,
      productType: spraysTable.productType,
      concentrationPct: spraysTable.concentrationPct,
      barrelsUsed: spraysTable.barrelsUsed,
      litresUsed: spraysTable.litresUsed,
      areaAcres: spraysTable.areaAcres,
      cost: spraysTable.cost,
      weatherCondition: spraysTable.weatherCondition,
      notes: spraysTable.notes,
      createdAt: spraysTable.createdAt,
    })
    .from(spraysTable)
    .leftJoin(cropsTable, eq(spraysTable.cropId, cropsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(spraysTable.date));

  return res.json(rows);
});

router.post("/sprays", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db
    .insert(spraysTable)
    .values({ ...body, estateId: eid })
    .returning();
  return res.status(201).json(row);
});

router.patch("/sprays/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  const [row] = await db
    .update(spraysTable)
    .set(body)
    .where(estateScoped(spraysTable.id, spraysTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/sprays/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  await db
    .delete(spraysTable)
    .where(estateScoped(spraysTable.id, spraysTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Harvests
// ──────────────────────────────────────────────────────────────────────────────

router.get("/harvests", requireActiveSubscription, async (req, res) => {
  const { cropId } = req.query as Record<string, string>;
  const eid = await activeEstateId(req);
  const conditions = [];
  if (eid != null) conditions.push(eq(harvestsTable.estateId, eid));
  if (cropId) conditions.push(eq(harvestsTable.cropId, Number(cropId)));

  const rows = await db
    .select({
      id: harvestsTable.id,
      date: harvestsTable.date,
      cropId: harvestsTable.cropId,
      cropName: cropsTable.name,
      workGroupId: harvestsTable.workGroupId,
      workGroupName: workGroupsTable.name,
      blockName: harvestsTable.blockName,
      weightKg: harvestsTable.weightKg,
      grade: harvestsTable.grade,
      pricePerKg: harvestsTable.pricePerKg,
      totalIncome: harvestsTable.totalIncome,
      buyer: harvestsTable.buyer,
      paymentStatus: harvestsTable.paymentStatus,
      notes: harvestsTable.notes,
      createdAt: harvestsTable.createdAt,
    })
    .from(harvestsTable)
    .leftJoin(cropsTable, eq(harvestsTable.cropId, cropsTable.id))
    .leftJoin(workGroupsTable, eq(harvestsTable.workGroupId, workGroupsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(harvestsTable.date));

  return res.json(rows);
});

router.post("/harvests", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  // A client-supplied workGroupId must belong to the active estate, or the row
  // would link across estates and leak the foreign group's name via the GET join.
  if (body.workGroupId != null && !(await groupInEstate(Number(body.workGroupId), eid))) {
    return res.status(404).json({ message: "Work group not found" });
  }
  if (!body.totalIncome) {
    body.totalIncome = (Number(body.weightKg) * Number(body.pricePerKg)).toFixed(2);
  }
  const [row] = await db
    .insert(harvestsTable)
    .values({ ...body, estateId: eid })
    .returning();
  return res.status(201).json(row);
});

router.patch("/harvests/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (!(await cropInEstate(body.cropId != null ? Number(body.cropId) : null, eid))) {
    return res.status(404).json({ message: "Crop not found" });
  }
  if (body.workGroupId != null && !(await groupInEstate(Number(body.workGroupId), eid))) {
    return res.status(404).json({ message: "Work group not found" });
  }
  const [row] = await db
    .update(harvestsTable)
    .set(body)
    .where(estateScoped(harvestsTable.id, harvestsTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/harvests/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  await db
    .delete(harvestsTable)
    .where(estateScoped(harvestsTable.id, harvestsTable.estateId, Number(req.params.id), eid));
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Loans
// ──────────────────────────────────────────────────────────────────────────────

router.get("/loans", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { workerId } = req.query as Record<string, string>;
  const conditions = [];
  if (eid != null) conditions.push(eq(loansTable.estateId, eid));
  if (workerId) conditions.push(eq(loansTable.workerId, Number(workerId)));

  const rows = await db
    .select({
      id: loansTable.id,
      workerId: loansTable.workerId,
      workerName: workersTable.name,
      workGroupId: loansTable.workGroupId,
      workGroupName: workGroupsTable.name,
      amount: loansTable.amount,
      interestPct: loansTable.interestPct,
      totalDue: loansTable.totalDue,
      issuedDate: loansTable.issuedDate,
      dueDate: loansTable.dueDate,
      repaidAmount: loansTable.repaidAmount,
      repaymentMethod: loansTable.repaymentMethod,
      status: loansTable.status,
      aadhaarPhotoUrl: loansTable.aadhaarPhotoUrl,
      proofPhotoUrl: loansTable.proofPhotoUrl,
      notes: loansTable.notes,
      createdAt: loansTable.createdAt,
    })
    .from(loansTable)
    .leftJoin(workersTable, eq(loansTable.workerId, workersTable.id))
    .leftJoin(workGroupsTable, eq(loansTable.workGroupId, workGroupsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(loansTable.createdAt));

  const withRemaining = rows.map((r) => ({
    ...r,
    remainingAmount: Number(r.totalDue) - Number(r.repaidAmount),
  }));

  return res.json(withRemaining);
});

router.post("/loans", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  // The worker this loan is for must belong to the active estate, or the loan row
  // would mix estates (loan.estateId = A, workerId from B) and pollute joins.
  if (!(await workerInEstate(Number(body.workerId), eid))) {
    return res.status(404).json({ message: "Worker not found" });
  }
  // Same cross-estate guard for the optional work group the loan is tied to.
  if (body.workGroupId != null && !(await groupInEstate(Number(body.workGroupId), eid))) {
    return res.status(404).json({ message: "Work group not found" });
  }
  // Proof-of-loan photo (optional): must be a reasonably sized image data URL,
  // same limits as expense receipts, so one giant upload can't bloat the DB.
  if (body.proofPhotoUrl != null) {
    const bad = invalidReceipt(body.proofPhotoUrl);
    if (bad) return res.status(400).json({ message: bad });
  }
  const principal = Number(body.amount);
  const interest = Number(body.interestPct ?? 0);
  if (!body.totalDue) {
    body.totalDue = (principal * (1 + interest / 100)).toFixed(2);
  }
  const [row] = await db.insert(loansTable).values({ ...body, estateId: eid }).returning();
  return res.status(201).json(row);
});

router.get("/loans/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(loansTable)
    .where(estateScoped(loansTable.id, loansTable.estateId, Number(req.params.id), eid));
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json({ ...rows[0], remainingAmount: Number(rows[0].totalDue) - Number(rows[0].repaidAmount) });
});

router.patch("/loans/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { estateId: _ignore, ...body } = req.body ?? {};
  if (body.workerId != null && !(await workerInEstate(Number(body.workerId), eid))) {
    return res.status(404).json({ message: "Worker not found" });
  }
  if (body.workGroupId != null && !(await groupInEstate(Number(body.workGroupId), eid))) {
    return res.status(404).json({ message: "Work group not found" });
  }
  // Same proof-photo size/type guard as on create, so edits can't bypass it.
  if (body.proofPhotoUrl != null) {
    const bad = invalidReceipt(body.proofPhotoUrl);
    if (bad) return res.status(400).json({ message: bad });
  }
  const [row] = await db
    .update(loansTable)
    .set(body)
    .where(estateScoped(loansTable.id, loansTable.estateId, Number(req.params.id), eid))
    .returning();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

router.delete("/loans/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const loanId = Number(req.params.id);
  // Confirm the loan belongs to the active estate before touching its payments.
  const [loan] = await db
    .select({ id: loansTable.id })
    .from(loansTable)
    .where(estateScoped(loansTable.id, loansTable.estateId, loanId, eid));
  if (!loan) return res.status(204).end();
  // Payments reference the loan (FK), so remove them first or the delete fails.
  await db.delete(loanPaymentsTable).where(eq(loanPaymentsTable.loanId, loanId));
  await db.delete(loansTable).where(eq(loansTable.id, loanId));
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Loan Payments
// ──────────────────────────────────────────────────────────────────────────────

router.get("/loan-payments", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { loanId } = req.query as Record<string, string>;
  const conditions = [];
  // Payments belong to a loan, and loans are estate-scoped; restrict payments to
  // loans in the active estate so one farm can't see another farm's repayments.
  if (eid != null) conditions.push(eq(loansTable.estateId, eid));
  if (loanId) conditions.push(eq(loanPaymentsTable.loanId, Number(loanId)));

  const rows = await db
    .select({
      id: loanPaymentsTable.id,
      loanId: loanPaymentsTable.loanId,
      date: loanPaymentsTable.date,
      amount: loanPaymentsTable.amount,
      method: loanPaymentsTable.method,
      notes: loanPaymentsTable.notes,
      createdAt: loanPaymentsTable.createdAt,
    })
    .from(loanPaymentsTable)
    .leftJoin(loansTable, eq(loanPaymentsTable.loanId, loansTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(loanPaymentsTable.date));

  return res.json(rows);
});

router.post("/loan-payments", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const { loanId } = req.body ?? {};
  // The loan being paid must belong to the active estate, or one farm could pay
  // down (and mutate) another farm's loan by guessing its id.
  const [loan] = await db
    .select({ id: loansTable.id })
    .from(loansTable)
    .where(estateScoped(loansTable.id, loansTable.estateId, Number(loanId), eid))
    .limit(1);
  if (!loan) return res.status(404).json({ message: "Loan not found" });

  const [row] = await db.insert(loanPaymentsTable).values(req.body).returning();

  await db
    .update(loansTable)
    .set({
      repaidAmount: sql`repaid_amount + ${row.amount}`,
      status: sql`CASE WHEN repaid_amount + ${row.amount} >= total_due THEN 'closed' ELSE status END`,
    })
    .where(eq(loansTable.id, row.loanId));

  return res.status(201).json(row);
});

router.delete("/loan-payments/:id", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  // Load the payment only if its loan is in the active estate (join guard), so a
  // known payment id from another farm can't be used to alter loan state here.
  const rows = await db
    .select({ id: loanPaymentsTable.id, loanId: loanPaymentsTable.loanId, amount: loanPaymentsTable.amount })
    .from(loanPaymentsTable)
    .leftJoin(loansTable, eq(loanPaymentsTable.loanId, loansTable.id))
    .where(and(
      eq(loanPaymentsTable.id, Number(req.params.id)),
      eid != null ? eq(loansTable.estateId, eid) : undefined,
    ));

  if (rows.length > 0) {
    await db
      .update(loansTable)
      .set({
        repaidAmount: sql`GREATEST(0, repaid_amount - ${rows[0].amount})`,
        status: "active",
      })
      .where(eq(loansTable.id, rows[0].loanId));

    await db
      .delete(loanPaymentsTable)
      .where(eq(loanPaymentsTable.id, Number(req.params.id)));
  }
  return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard Summary
// ──────────────────────────────────────────────────────────────────────────────

router.get("/dashboard/summary", async (req, res) => {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 6);
  const weekStart = weekAgo.toISOString().slice(0, 10);

  const eid = await activeEstateId(req);
  // Every farm-account surface is scoped to the active estate.
  const cropEstate = eid != null ? eq(cropsTable.estateId, eid) : undefined;
  const wgEstate = eid != null ? eq(workGroupsTable.estateId, eid) : undefined;
  const expEstate = eid != null ? eq(expensesTable.estateId, eid) : undefined;
  const harEstate = eid != null ? eq(harvestsTable.estateId, eid) : undefined;
  const workerEstate = eid != null ? eq(workersTable.estateId, eid) : undefined;
  const loanEstate = eid != null ? eq(loansTable.estateId, eid) : undefined;

  const [cropCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cropsTable)
    .where(cropEstate);
  const [jobWorkerCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workersTable)
    .where(and(eq(workersTable.isActive, true), sql`type != 'Contractor'`, workerEstate));

  const [contractWorkerCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workersTable)
    .where(and(eq(workersTable.isActive, true), eq(workersTable.type, "Contractor"), workerEstate));

  const [pendingWorkGroupCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workGroupsTable)
    .where(and(eq(workGroupsTable.isActive, true), isNull(workGroupsTable.deletedAt), wgEstate));

  const [monthExpenses] = await db
    .select({ total: sql<string>`coalesce(sum(amount),0)` })
    .from(expensesTable)
    .where(and(gte(expensesTable.date, monthStart), expEstate));

  const [weekExpenses] = await db
    .select({ total: sql<string>`coalesce(sum(amount),0)` })
    .from(expensesTable)
    .where(and(gte(expensesTable.date, weekStart), expEstate));

  const [monthIncome] = await db
    .select({ total: sql<string>`coalesce(sum(total_income),0)` })
    .from(harvestsTable)
    .where(and(gte(harvestsTable.date, monthStart), harEstate));

  const [yearExpenses] = await db
    .select({ total: sql<string>`coalesce(sum(amount),0)` })
    .from(expensesTable)
    .where(and(gte(expensesTable.date, yearStart), expEstate));

  const [yearIncome] = await db
    .select({ total: sql<string>`coalesce(sum(total_income),0)` })
    .from(harvestsTable)
    .where(and(gte(harvestsTable.date, yearStart), harEstate));

  const activeLoans = await db
    .select({ remaining: sql<string>`coalesce(sum(total_due - repaid_amount),0)` })
    .from(loansTable)
    .where(and(eq(loansTable.status, "active"), loanEstate));

  // Attendance has no estate column of its own — it inherits the estate of its
  // work group, so join through work_groups to keep labour cost estate-scoped.
  const [todayLabour] = await db
    .select({ total: sql<string>`coalesce(sum(${attendanceTable.wageAmount}),0)` })
    .from(attendanceTable)
    .leftJoin(workGroupsTable, eq(attendanceTable.workGroupId, workGroupsTable.id))
    .where(and(eq(attendanceTable.date, today), wgEstate));

  const recentExpenses = await db
    .select()
    .from(expensesTable)
    .where(expEstate)
    .orderBy(desc(expensesTable.date))
    .limit(5);

  const recentHarvests = await db
    .select()
    .from(harvestsTable)
    .where(harEstate)
    .orderBy(desc(harvestsTable.date))
    .limit(5);

  const recentActivities = [
    ...recentExpenses.map((e) => ({
      type: "expense",
      description: `${e.category}: ${e.description ?? ""}`,
      date: e.date,
      amount: -Number(e.amount),
    })),
    ...recentHarvests.map((h) => ({
      type: "harvest",
      description: `Harvest income`,
      date: h.date,
      amount: Number(h.totalIncome),
    })),
  ]
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, 8);

  return res.json({
    totalCrops: Number(cropCount.count),
    totalJobWorkers: Number(jobWorkerCount.count),
    totalContractWorkers: Number(contractWorkerCount.count),
    totalExpensesThisMonth: Number(monthExpenses.total),
    totalExpensesThisWeek: Number(weekExpenses.total),
    totalIncomeThisMonth: Number(monthIncome.total),
    pendingWorkGroups: Number(pendingWorkGroupCount.count),
    totalExpensesThisYear: Number(yearExpenses.total),
    totalIncomeThisYear: Number(yearIncome.total),
    pendingLoanAmount: Number(activeLoans[0]?.remaining ?? 0),
    todayLabourCost: Number(todayLabour.total),
    recentActivities,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Reports
// ──────────────────────────────────────────────────────────────────────────────

router.get("/reports/season", requireActiveSubscription, async (req, res) => {
  const now = new Date();
  const startDate = (req.query.startDate as string) ?? `${now.getFullYear()}-01-01`;
  const endDate = (req.query.endDate as string) ?? `${now.getFullYear()}-12-31`;

  const eid = await activeEstateId(req);
  const allCrops = await db
    .select()
    .from(cropsTable)
    .where(eid != null ? eq(cropsTable.estateId, eid) : undefined);

  const cropSummaries = await Promise.all(
    allCrops.map(async (crop) => {
      const [income] = await db
        .select({ total: sql<string>`coalesce(sum(total_income),0)`, kg: sql<string>`coalesce(sum(weight_kg),0)` })
        .from(harvestsTable)
        .where(
          and(
            eq(harvestsTable.cropId, crop.id),
            gte(harvestsTable.date, startDate),
            lte(harvestsTable.date, endDate)
          )
        );

      const expenseRows = await db
        .select({ category: expensesTable.category, total: sql<string>`coalesce(sum(amount),0)` })
        .from(expensesTable)
        .where(
          and(
            eq(expensesTable.cropId, crop.id),
            gte(expensesTable.date, startDate),
            lte(expensesTable.date, endDate)
          )
        )
        .groupBy(expensesTable.category);

      const labourCost = await db
        .select({ total: sql<string>`coalesce(sum(${attendanceTable.wageAmount}),0)` })
        .from(attendanceTable)
        .innerJoin(workGroupsTable, eq(attendanceTable.workGroupId, workGroupsTable.id))
        .where(
          and(
            eq(workGroupsTable.cropId, crop.id),
            gte(attendanceTable.date, startDate),
            lte(attendanceTable.date, endDate)
          )
        );

      const sprayCost = await db
        .select({ total: sql<string>`coalesce(sum(cost),0)` })
        .from(spraysTable)
        .where(
          and(
            eq(spraysTable.cropId, crop.id),
            gte(spraysTable.date, startDate),
            lte(spraysTable.date, endDate)
          )
        );

      const expByCategory: Record<string, number> = {};
      expenseRows.forEach((r) => {
        expByCategory[r.category] = Number(r.total);
      });

      const fertCost = expByCategory["fertilizer"] ?? 0;
      const otherCost = Object.entries(expByCategory)
        .filter(([k]) => k !== "fertilizer")
        .reduce((s, [, v]) => s + v, 0);

      const totalIncome = Number(income.total);
      const totalLabour = Number(labourCost[0]?.total ?? 0);
      const totalSpray = Number(sprayCost[0]?.total ?? 0);
      const totalExpenses = totalLabour + totalSpray + fertCost + otherCost;
      const netProfit = totalIncome - totalExpenses;
      const acres = Number(crop.acres);

      return {
        cropId: crop.id,
        cropName: crop.name,
        acres,
        totalYieldKg: Number(income.kg),
        totalIncome,
        labourCost: totalLabour,
        fertilizerCost: fertCost,
        sprayCost: totalSpray,
        otherCost,
        totalExpenses,
        netProfit,
        profitPerAcre: acres > 0 ? netProfit / acres : 0,
      };
    })
  );

  // Expenses with no crop attached (crop is optional on the expense form, and
  // manager-added expenses usually have none). Without this bucket they'd be
  // invisible in the Season P&L, which otherwise only sums crop-linked rows.
  const unassignedRows = await db
    .select({ category: expensesTable.category, total: sql<string>`coalesce(sum(amount),0)` })
    .from(expensesTable)
    .where(
      and(
        isNull(expensesTable.cropId),
        eid != null ? eq(expensesTable.estateId, eid) : undefined,
        gte(expensesTable.date, startDate),
        lte(expensesTable.date, endDate)
      )
    )
    .groupBy(expensesTable.category);

  const unassignedByCategory: Record<string, number> = {};
  unassignedRows.forEach((r) => {
    unassignedByCategory[r.category] = Number(r.total);
  });
  const unassignedFert = unassignedByCategory["fertilizer"] ?? 0;
  const unassignedOther = Object.entries(unassignedByCategory)
    .filter(([k]) => k !== "fertilizer")
    .reduce((s, [, v]) => s + v, 0);
  const unassignedTotal = unassignedFert + unassignedOther;

  if (unassignedTotal > 0) {
    cropSummaries.push({
      cropId: 0,
      cropName: "General (no crop)",
      acres: 0,
      totalYieldKg: 0,
      totalIncome: 0,
      labourCost: 0,
      fertilizerCost: unassignedFert,
      sprayCost: 0,
      otherCost: unassignedOther,
      totalExpenses: unassignedTotal,
      netProfit: -unassignedTotal,
      profitPerAcre: 0,
    });
  }

  const totals = cropSummaries.reduce(
    (acc, c) => ({
      totalIncome: acc.totalIncome + c.totalIncome,
      totalExpenses: acc.totalExpenses + c.totalExpenses,
    }),
    { totalIncome: 0, totalExpenses: 0 }
  );

  return res.json({
    startDate,
    endDate,
    totalIncome: totals.totalIncome,
    totalExpenses: totals.totalExpenses,
    netProfit: totals.totalIncome - totals.totalExpenses,
    crops: cropSummaries,
  });
});

router.get("/reports/monthly", requireActiveSubscription, async (req, res) => {
  const now = new Date();
  const month = (req.query.month as string) ?? now.toISOString().slice(0, 7);
  const startDate = `${month}-01`;
  const [yr, mo] = month.split("-").map(Number);
  const lastDay = new Date(yr, mo, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

  const eid = await activeEstateId(req);
  const expEstate = eid != null ? eq(expensesTable.estateId, eid) : undefined;
  const harEstate = eid != null ? eq(harvestsTable.estateId, eid) : undefined;

  const expenseRows = await db
    .select({
      category: expensesTable.category,
      total: sql<string>`coalesce(sum(amount),0)`,
    })
    .from(expensesTable)
    .where(and(gte(expensesTable.date, startDate), lte(expensesTable.date, endDate), expEstate))
    .groupBy(expensesTable.category);

  const [incomeRow] = await db
    .select({ total: sql<string>`coalesce(sum(total_income),0)` })
    .from(harvestsTable)
    .where(and(gte(harvestsTable.date, startDate), lte(harvestsTable.date, endDate), harEstate));

  const totalExpenses = expenseRows.reduce((s, r) => s + Number(r.total), 0);
  const totalIncome = Number(incomeRow.total);

  const breakdown = expenseRows.map((r) => ({
    category: r.category,
    amount: Number(r.total),
    percentage: totalExpenses > 0 ? (Number(r.total) / totalExpenses) * 100 : 0,
  }));

  return res.json({
    month,
    totalExpenses,
    totalIncome,
    netProfit: totalIncome - totalExpenses,
    breakdown,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Reports — Weekly
// ──────────────────────────────────────────────────────────────────────────────

router.get("/reports/weekly", requireActiveSubscription, async (req, res) => {
  const weekStart = (req.query.weekStart as string) ?? new Date().toISOString().slice(0, 10);
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const endStr = end.toISOString().slice(0, 10);

  const eid = await activeEstateId(req);
  const expEstate = eid != null ? eq(expensesTable.estateId, eid) : undefined;
  const harEstate = eid != null ? eq(harvestsTable.estateId, eid) : undefined;
  const wgEstate = eid != null ? eq(workGroupsTable.estateId, eid) : undefined;

  const expenseRows = await db
    .select({ date: expensesTable.date, amount: expensesTable.amount })
    .from(expensesTable)
    .where(and(gte(expensesTable.date, weekStart), lte(expensesTable.date, endStr), expEstate));

  const harvestRows = await db
    .select({ date: harvestsTable.date, totalIncome: harvestsTable.totalIncome })
    .from(harvestsTable)
    .where(and(gte(harvestsTable.date, weekStart), lte(harvestsTable.date, endStr), harEstate));

  // Attendance inherits the estate of its work group — join through work_groups
  // so weekly labour cost stays scoped to the active estate.
  const attRows = await db
    .select({ date: attendanceTable.date, wageAmount: attendanceTable.wageAmount })
    .from(attendanceTable)
    .leftJoin(workGroupsTable, eq(attendanceTable.workGroupId, workGroupsTable.id))
    .where(and(gte(attendanceTable.date, weekStart), lte(attendanceTable.date, endStr), wgEstate));

  const days: Array<{ date: string; income: number; expenses: number }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const income = harvestRows.filter((r) => r.date === ds).reduce((s, r) => s + Number(r.totalIncome), 0);
    const expenses =
      expenseRows.filter((r) => r.date === ds).reduce((s, r) => s + Number(r.amount), 0) +
      attRows.filter((r) => r.date === ds).reduce((s, r) => s + Number(r.wageAmount), 0);
    days.push({ date: ds, income, expenses });
  }

  const totalIncome = days.reduce((s, d) => s + d.income, 0);
  const totalExpenses = days.reduce((s, d) => s + d.expenses, 0);

  return res.json({
    weekStart,
    weekEnd: endStr,
    totalIncome,
    totalExpenses,
    netProfit: totalIncome - totalExpenses,
    days,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Old Ledger — year-by-year historical summary for years before the current one
// ──────────────────────────────────────────────────────────────────────────────

// One row per past year with rolled-up totals. Detail rows are served per-year
// by GET /ledger/old-years/:year below.
router.get("/ledger/old-years", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const curYear = new Date().getFullYear();
  const cutoff = `${curYear}-01-01`;

  const yearOf = (col: PgColumn) => sql<string>`substr(${col}::text, 1, 4)`;

  const [expByYear, harvByYear, attByYear, payByYear, advByYear, loanByYear] = await Promise.all([
    db.select({
      year: yearOf(expensesTable.date).as("year"),
      total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)`,
    }).from(expensesTable)
      .where(and(lt(expensesTable.date, cutoff), eid != null ? eq(expensesTable.estateId, eid) : undefined))
      .groupBy(sql`year`),
    db.select({
      year: yearOf(harvestsTable.date).as("year"),
      total: sql<string>`coalesce(sum(${harvestsTable.totalIncome}), 0)`,
    }).from(harvestsTable)
      .where(and(lt(harvestsTable.date, cutoff), eid != null ? eq(harvestsTable.estateId, eid) : undefined))
      .groupBy(sql`year`),
    db.select({
      year: yearOf(attendanceTable.date).as("year"),
      total: sql<string>`coalesce(sum(${attendanceTable.wageAmount}), 0)`,
      days: sql<string>`count(*)`,
      workerCount: sql<string>`count(distinct ${attendanceTable.workerId})`,
    }).from(attendanceTable)
      .where(and(
        lt(attendanceTable.date, cutoff),
        eid != null ? inArray(attendanceTable.workGroupId, estateGroupIds(eid)) : undefined,
      ))
      .groupBy(sql`year`),
    db.select({
      year: yearOf(workerPaymentsTable.paymentDate).as("year"),
      total: sql<string>`coalesce(sum(${workerPaymentsTable.amount}), 0)`,
    }).from(workerPaymentsTable)
      .where(and(lt(workerPaymentsTable.paymentDate, cutoff), eid != null ? eq(workerPaymentsTable.estateId, eid) : undefined))
      .groupBy(sql`year`),
    db.select({
      year: yearOf(groupAdvancePaymentsTable.paymentDate).as("year"),
      total: sql<string>`coalesce(sum(${groupAdvancePaymentsTable.totalAdvancePaid}), 0)`,
    }).from(groupAdvancePaymentsTable)
      .where(and(
        lt(groupAdvancePaymentsTable.paymentDate, cutoff),
        eid != null ? inArray(groupAdvancePaymentsTable.workGroupId, estateGroupIds(eid)) : undefined,
      ))
      .groupBy(sql`year`),
    db.select({
      year: yearOf(loansTable.issuedDate).as("year"),
      total: sql<string>`coalesce(sum(${loansTable.amount}), 0)`,
    }).from(loansTable)
      .where(and(lt(loansTable.issuedDate, cutoff), eid != null ? eq(loansTable.estateId, eid) : undefined))
      .groupBy(sql`year`),
  ]);

  type Totals = { expenses: number; income: number; wages: number; attendanceDays: number; workerCount: number; payments: number; advances: number; loansGiven: number };
  const years = new Map<number, Totals>();
  const totals = (yearStr: string): Totals => {
    const y = Number(yearStr);
    let t = years.get(y);
    if (!t) {
      t = { expenses: 0, income: 0, wages: 0, attendanceDays: 0, workerCount: 0, payments: 0, advances: 0, loansGiven: 0 };
      years.set(y, t);
    }
    return t;
  };
  for (const r of expByYear) totals(r.year).expenses += Number(r.total);
  for (const r of harvByYear) totals(r.year).income += Number(r.total);
  for (const r of attByYear) {
    const t = totals(r.year);
    t.wages += Number(r.total);
    t.attendanceDays += Number(r.days);
    t.workerCount += Number(r.workerCount);
  }
  for (const r of payByYear) totals(r.year).payments += Number(r.total);
  for (const r of advByYear) totals(r.year).advances += Number(r.total);
  for (const r of loanByYear) totals(r.year).loansGiven += Number(r.total);

  const out = [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, t]) => ({ year, totals: t }));

  return res.json(out);
});

// Full detail for a single past year: expense list + by-category rollup,
// harvests, per-worker attendance totals, per-work-type wage totals, and every
// payment/advance/loan row issued that year.
router.get("/ledger/old-years/:year", requireActiveSubscription, async (req, res) => {
  const eid = await activeEstateId(req);
  const curYear = new Date().getFullYear();
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 1900 || year >= curYear) {
    return res.status(400).json({ message: "Invalid year" });
  }
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const inYear = (col: PgColumn) => and(gte(col, from), lt(col, to));

  const [expenses, expenseCategories, harvests, workers, workTypes, payments, advances, loans] = await Promise.all([
    db.select({
      date: expensesTable.date,
      category: expensesTable.category,
      amount: expensesTable.amount,
      description: expensesTable.description,
    }).from(expensesTable)
      .where(and(inYear(expensesTable.date), eid != null ? eq(expensesTable.estateId, eid) : undefined))
      .orderBy(desc(expensesTable.date)),
    // Expenses rolled up by category (fertiliser, spray, fuel...): the "where
    // did the money go" view the owner asks for first.
    db.select({
      category: expensesTable.category,
      total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)`,
      count: sql<string>`count(*)`,
    }).from(expensesTable)
      .where(and(inYear(expensesTable.date), eid != null ? eq(expensesTable.estateId, eid) : undefined))
      .groupBy(expensesTable.category)
      .orderBy(sql`coalesce(sum(${expensesTable.amount}), 0) desc`),
    db.select({
      date: harvestsTable.date,
      cropName: cropsTable.name,
      weightKg: harvestsTable.weightKg,
      totalIncome: harvestsTable.totalIncome,
      buyer: harvestsTable.buyer,
    }).from(harvestsTable)
      .leftJoin(cropsTable, eq(harvestsTable.cropId, cropsTable.id))
      .where(and(inYear(harvestsTable.date), eid != null ? eq(harvestsTable.estateId, eid) : undefined))
      .orderBy(desc(harvestsTable.date)),
    // Attendance rolls up per worker for the year in SQL (day-level rows would be huge).
    // Grouped by worker id - two workers sharing a name must stay separate rows.
    db.select({
      name: sql<string | null>`max(${workersTable.name})`,
      days: sql<string>`count(*)`,
      earned: sql<string>`coalesce(sum(${attendanceTable.wageAmount}), 0)`,
    }).from(attendanceTable)
      .leftJoin(workersTable, eq(attendanceTable.workerId, workersTable.id))
      .where(and(
        inYear(attendanceTable.date),
        eid != null ? inArray(attendanceTable.workGroupId, estateGroupIds(eid)) : undefined,
      ))
      .groupBy(attendanceTable.workerId)
      .orderBy(sql`coalesce(sum(${attendanceTable.wageAmount}), 0) desc`),
    // Wages by work type: per work group for the year - category of work, daily
    // rate, how many works (person-days), how many people, and wages earned.
    db.select({
      name: sql<string | null>`max(${workGroupsTable.name})`,
      category: sql<string | null>`max(${workGroupsTable.category})`,
      rate: sql<string | null>`max(${workGroupsTable.rate}::text)`,
      paymentType: sql<string | null>`max(${workGroupsTable.paymentType})`,
      days: sql<string>`count(*)`,
      workers: sql<string>`count(distinct coalesce(${attendanceTable.workerId}::text, ${workersTable.name}, '?'))`,
      wages: sql<string>`coalesce(sum(${attendanceTable.wageAmount}), 0)`,
    }).from(attendanceTable)
      .leftJoin(workersTable, eq(attendanceTable.workerId, workersTable.id))
      .leftJoin(workGroupsTable, eq(attendanceTable.workGroupId, workGroupsTable.id))
      .where(and(
        inYear(attendanceTable.date),
        eid != null ? inArray(attendanceTable.workGroupId, estateGroupIds(eid)) : undefined,
      ))
      .groupBy(attendanceTable.workGroupId)
      .orderBy(sql`coalesce(sum(${attendanceTable.wageAmount}), 0) desc`),
    db.select({
      date: workerPaymentsTable.paymentDate,
      payeeName: workerPaymentsTable.payeeName,
      amount: workerPaymentsTable.amount,
      method: workerPaymentsTable.method,
    }).from(workerPaymentsTable)
      .where(and(inYear(workerPaymentsTable.paymentDate), eid != null ? eq(workerPaymentsTable.estateId, eid) : undefined))
      .orderBy(desc(workerPaymentsTable.paymentDate)),
    db.select({
      date: groupAdvancePaymentsTable.paymentDate,
      groupName: workGroupsTable.name,
      amount: groupAdvancePaymentsTable.totalAdvancePaid,
      notes: groupAdvancePaymentsTable.notes,
    }).from(groupAdvancePaymentsTable)
      .leftJoin(workGroupsTable, eq(groupAdvancePaymentsTable.workGroupId, workGroupsTable.id))
      .where(and(
        inYear(groupAdvancePaymentsTable.paymentDate),
        eid != null ? inArray(groupAdvancePaymentsTable.workGroupId, estateGroupIds(eid)) : undefined,
      ))
      .orderBy(desc(groupAdvancePaymentsTable.paymentDate)),
    db.select({
      date: loansTable.issuedDate,
      workerName: workersTable.name,
      amount: loansTable.amount,
      totalDue: loansTable.totalDue,
      repaidAmount: loansTable.repaidAmount,
      status: loansTable.status,
    }).from(loansTable)
      .leftJoin(workersTable, eq(loansTable.workerId, workersTable.id))
      .where(and(inYear(loansTable.issuedDate), eid != null ? eq(loansTable.estateId, eid) : undefined))
      .orderBy(desc(loansTable.issuedDate)),
  ]);

  return res.json({
    year,
    expenses,
    expenseCategories: expenseCategories.map((c) => ({ category: c.category, total: Number(c.total), count: Number(c.count) })),
    harvests,
    workers: workers.map((w) => ({ name: w.name ?? "Unknown", days: Number(w.days), earned: Number(w.earned) })),
    workTypes: workTypes.map((g) => ({
      name: g.name ?? "No group",
      category: g.category,
      rate: g.rate != null ? Number(g.rate) : null,
      paymentType: g.paymentType,
      days: Number(g.days),
      workers: Number(g.workers),
      wages: Number(g.wages),
    })),
    payments,
    advances,
    loans,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Estate Updates
// ──────────────────────────────────────────────────────────────────────────────

router.post("/estate-updates/count-workers", async (req, res) => {
  const { imageDataUrl } = req.body as { imageDataUrl?: string };
  if (!imageDataUrl) return res.status(400).json({ error: "imageDataUrl required" });
  try {
    const { openai } = await import("../integrations-openai-ai-server");
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          {
            type: "text",
            text: 'Count every person or worker visible in this farm field photo. Reply ONLY with valid JSON (no markdown, no extra text): {"count": <number>, "description": "<brief 1-line note in English>"}. If no people are visible, use count 0.',
          },
        ],
      }],
    });
    const text = response.choices[0]?.message?.content ?? '{"count":0}';
    const m = text.match(/\{[^}]+\}/);
    const result = m ? JSON.parse(m[0]) : { count: 0, description: "Could not detect workers" };
    return res.json({ count: Number(result.count) || 0, description: String(result.description ?? "") });
  } catch (err) {
    console.error("count-workers error:", err);
    return res.status(500).json({ error: "AI counting failed", count: 0 });
  }
});

router.get("/estate-updates", async (req, res) => {
  const { date } = req.query as { date?: string };
  const eid = await activeEstateId(req);
  const conditions = [isNull(estateUpdatesTable.deletedAt)];
  if (eid != null) conditions.push(eq(estateUpdatesTable.estateId, eid));
  if (date) conditions.push(eq(estateUpdatesTable.date, date));
  const rows = await db
    .select()
    .from(estateUpdatesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(estateUpdatesTable.createdAt))
    .limit(50);
  return res.json(rows);
});

router.post("/estate-updates", async (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.date || !b.description) {
    return res.status(400).json({ error: "date and description are required" });
  }
  const eid = await activeEstateId(req);
  // Same cross-estate guard as harvests/loans: a client-supplied workGroupId
  // must belong to the active estate.
  if (
    b.workGroupId != null &&
    !isNaN(Number(b.workGroupId)) &&
    !(await groupInEstate(Number(b.workGroupId), eid))
  ) {
    return res.status(404).json({ message: "Work group not found" });
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const clientId = str(b.clientId);
  const values = {
    estateId: eid,
    date: String(b.date),
    description: String(b.description),
    workerName: str(b.workerName),
    blockName: str(b.blockName),
    workGroupId:
      b.workGroupId != null && !isNaN(Number(b.workGroupId))
        ? Number(b.workGroupId)
        : null,
    photoUrl: str(b.photoUrl),
    videoUrl: str(b.videoUrl),
    notes: str(b.notes),
    attendanceCount:
      b.attendanceCount != null && !isNaN(Number(b.attendanceCount))
        ? Number(b.attendanceCount)
        : null,
    latitude: str(b.latitude),
    longitude: str(b.longitude),
    clientId,
  };

  // Idempotent replay: a flaky network can drop the response after we already
  // committed, so the client re-sends the same queued item (same clientId). Insert
  // once; on conflict return the row we already stored instead of duplicating it.
  if (clientId) {
    const [inserted] = await db
      .insert(estateUpdatesTable)
      .values(values)
      .onConflictDoNothing({ target: estateUpdatesTable.clientId })
      .returning();
    if (inserted) return res.status(201).json(inserted);
    // Scope the replay lookup to the active estate so a colliding clientId can
    // never surface another estate's row.
    const [existing] = await db
      .select()
      .from(estateUpdatesTable)
      .where(
        eid != null
          ? and(eq(estateUpdatesTable.clientId, clientId), eq(estateUpdatesTable.estateId, eid))
          : eq(estateUpdatesTable.clientId, clientId)
      )
      .limit(1);
    if (!existing) return res.status(404).json({ message: "Not found" });
    return res.status(200).json(existing);
  }

  const [row] = await db.insert(estateUpdatesTable).values(values).returning();
  return res.status(201).json(row);
});

router.delete("/estate-updates/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  // Soft delete → recycle bin; restorable for 30 days via the bin routes.
  await db
    .update(estateUpdatesTable)
    .set({ deletedAt: new Date() })
    .where(estateScoped(estateUpdatesTable.id, estateUpdatesTable.estateId, Number(req.params.id), eid));
  return res.status(204).send();
});

// ── Recycle Bin ───────────────────────────────────────────────────────────────
// Soft-deleted work groups and work updates (photos), plus removed workers
// (isActive=false), all restorable. Groups/updates are purged automatically
// 30 days after deletion (lazily, whenever the bin is opened).

const BIN_RETENTION_DAYS = 30;

router.get("/bin", async (req, res) => {
  const eid = await activeEstateId(req);
  const cutoff = new Date(Date.now() - BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Lazy purge of expired items (scoped to the active estate).
  const expiredGroups = await db
    .select({ id: workGroupsTable.id })
    .from(workGroupsTable)
    .where(
      and(
        lt(workGroupsTable.deletedAt, cutoff),
        eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
      ),
    );
  for (const g of expiredGroups) {
    await hardDeleteWorkGroup(g.id);
  }
  await db
    .delete(estateUpdatesTable)
    .where(
      and(
        lt(estateUpdatesTable.deletedAt, cutoff),
        eid != null ? eq(estateUpdatesTable.estateId, eid) : undefined,
      ),
    );

  const [groups, workers, updates] = await Promise.all([
    db
      .select({
        id: workGroupsTable.id,
        name: workGroupsTable.name,
        category: workGroupsTable.category,
        deletedAt: workGroupsTable.deletedAt,
      })
      .from(workGroupsTable)
      .where(
        and(
          isNotNull(workGroupsTable.deletedAt),
          eid != null ? eq(workGroupsTable.estateId, eid) : undefined,
        ),
      )
      .orderBy(desc(workGroupsTable.deletedAt)),
    db
      .select({
        id: workersTable.id,
        name: workersTable.name,
        wageRate: workersTable.wageRate,
        wageUnit: workersTable.wageUnit,
      })
      .from(workersTable)
      .where(
        and(
          eq(workersTable.isActive, false),
          eid != null ? eq(workersTable.estateId, eid) : undefined,
        ),
      )
      .orderBy(desc(workersTable.id)),
    db
      .select({
        id: estateUpdatesTable.id,
        date: estateUpdatesTable.date,
        description: estateUpdatesTable.description,
        photoUrl: estateUpdatesTable.photoUrl,
        deletedAt: estateUpdatesTable.deletedAt,
      })
      .from(estateUpdatesTable)
      .where(
        and(
          isNotNull(estateUpdatesTable.deletedAt),
          eid != null ? eq(estateUpdatesTable.estateId, eid) : undefined,
        ),
      )
      .orderBy(desc(estateUpdatesTable.deletedAt)),
  ]);

  return res.json({ groups, workers, updates, retentionDays: BIN_RETENTION_DAYS });
});

router.post("/bin/restore", async (req, res) => {
  const { type, id } = req.body as { type?: string; id?: unknown };
  const itemId = Number(id);
  if (!type || isNaN(itemId)) {
    return res.status(400).json({ message: "type and id are required" });
  }
  const eid = await activeEstateId(req);

  if (type === "group") {
    if (!(await binnedGroupInEstate(itemId, eid))) {
      return res.status(404).json({ message: "Not found" });
    }
    await db
      .update(workGroupsTable)
      .set({ deletedAt: null })
      .where(eq(workGroupsTable.id, itemId));
  } else if (type === "worker") {
    if (!(await workerInEstate(itemId, eid))) {
      return res.status(404).json({ message: "Not found" });
    }
    await db
      .update(workersTable)
      .set({ isActive: true })
      .where(eq(workersTable.id, itemId));
  } else if (type === "update") {
    await db
      .update(estateUpdatesTable)
      .set({ deletedAt: null })
      .where(estateScoped(estateUpdatesTable.id, estateUpdatesTable.estateId, itemId, eid));
  } else {
    return res.status(400).json({ message: "Unknown type" });
  }
  return res.status(204).end();
});

router.delete("/bin/:type/:id", async (req, res) => {
  const { type } = req.params;
  const itemId = Number(req.params.id);
  if (isNaN(itemId)) return res.status(400).json({ message: "Invalid id" });
  const eid = await activeEstateId(req);

  if (type === "group") {
    if (!(await binnedGroupInEstate(itemId, eid))) {
      return res.status(404).json({ message: "Not found" });
    }
    await hardDeleteWorkGroup(itemId);
  } else if (type === "worker") {
    if (!(await workerInEstate(itemId, eid))) {
      return res.status(404).json({ message: "Not found" });
    }
    // Permanent worker delete: remove their attendance and loan chain first
    // (FKs have no ON DELETE CASCADE).
    await db.transaction(async (tx) => {
      const loanIds = tx
        .select({ id: loansTable.id })
        .from(loansTable)
        .where(eq(loansTable.workerId, itemId));
      await tx.delete(loanPaymentsTable).where(inArray(loanPaymentsTable.loanId, loanIds));
      await tx.delete(loansTable).where(eq(loansTable.workerId, itemId));
      await tx.delete(attendanceTable).where(eq(attendanceTable.workerId, itemId));
      await tx.delete(workersTable).where(eq(workersTable.id, itemId));
    });
  } else if (type === "update") {
    await db
      .delete(estateUpdatesTable)
      .where(estateScoped(estateUpdatesTable.id, estateUpdatesTable.estateId, itemId, eid));
  } else {
    return res.status(400).json({ message: "Unknown type" });
  }
  return res.status(204).end();
});

// ── Nursery Marketplace ───────────────────────────────────────────────────────

router.get("/nursery/vendors", async (req, res) => {
  const { all, type } = req.query as { all?: string; type?: string };
  const vendorType = type === "supplies" ? "supplies" : "nursery";
  const baseConditions = all === "true"
    ? [eq(nurseryVendorsTable.type, vendorType)]
    : [eq(nurseryVendorsTable.status, "approved"), eq(nurseryVendorsTable.type, vendorType)];
  const vendors = await db
    .select({
      id: nurseryVendorsTable.id,
      name: nurseryVendorsTable.name,
      phone: nurseryVendorsTable.phone,
      whatsapp: nurseryVendorsTable.whatsapp,
      location: nurseryVendorsTable.location,
      description: nurseryVendorsTable.description,
      speciality: nurseryVendorsTable.speciality,
      photoUrl: nurseryVendorsTable.photoUrl,
      status: nurseryVendorsTable.status,
      adminNotes: nurseryVendorsTable.adminNotes,
      isActive: nurseryVendorsTable.isActive,
      createdAt: nurseryVendorsTable.createdAt,
      listingCount: sql<number>`cast(count(distinct ${nurseryListingsTable.id}) as int)`,
      avgRating: sql<number>`coalesce(round(avg(${nurseryRatingsTable.rating}), 1), 0)`,
      ratingCount: sql<number>`cast(count(distinct ${nurseryRatingsTable.id}) as int)`,
    })
    .from(nurseryVendorsTable)
    .leftJoin(nurseryListingsTable, and(
      eq(nurseryListingsTable.vendorId, nurseryVendorsTable.id),
      eq(nurseryListingsTable.isAvailable, true),
      eq(nurseryListingsTable.type, vendorType)
    ))
    .leftJoin(nurseryRatingsTable, eq(nurseryRatingsTable.vendorId, nurseryVendorsTable.id))
    .where(baseConditions.length ? and(...baseConditions) : undefined)
    .groupBy(nurseryVendorsTable.id)
    .orderBy(
      desc(sql`coalesce(avg(${nurseryRatingsTable.rating}), 0)`),
      desc(sql`count(distinct ${nurseryRatingsTable.id})`),
      desc(nurseryVendorsTable.createdAt),
    );
  return res.json(vendors.map(v => ({ ...v, avgRating: Number(v.avgRating) })));
});

router.post("/nursery/vendors", requireOwner, requireActiveSubscription, async (req, res) => {
  const { name, phone, location, photoUrl } = req.body ?? {};
  if (!name?.trim() || !phone?.trim() || !location?.trim() || !photoUrl?.trim()) {
    return res.status(400).json({ message: "Shop name, phone, location and photo are required" });
  }
  const type = req.body?.type === "supplies" ? "supplies" : "nursery";
  // Registering device's per-device secret so only it can manage this shop's
  // listings later. Sanitized (capped) and never echoed back to any client.
  const ownerKey = bodyOwnerKey(req.body?.ownerKey);
  const [row] = await db.insert(nurseryVendorsTable).values({ ...req.body, type, ownerKey }).returning();
  const { ownerKey: _ok, ...publicVendor } = row;
  return res.status(201).json(publicVendor);
});

router.get("/nursery/vendors/:id", async (req, res) => {
  const [vendor] = await db.select().from(nurseryVendorsTable)
    .where(eq(nurseryVendorsTable.id, Number(req.params.id)));
  if (!vendor) return res.status(404).json({ message: "Vendor not found" });
  const listings = await db.select().from(nurseryListingsTable)
    .where(and(
      eq(nurseryListingsTable.vendorId, Number(req.params.id)),
      eq(nurseryListingsTable.type, vendor.type),
    ))
    .orderBy(desc(nurseryListingsTable.createdAt));
  const ratings = await db.select().from(nurseryRatingsTable)
    .where(eq(nurseryRatingsTable.vendorId, Number(req.params.id)))
    .orderBy(desc(nurseryRatingsTable.createdAt));
  const ratingCount = ratings.length;
  const avgRating = ratingCount
    ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratingCount) * 10) / 10
    : 0;
  // Never expose the vendor's owner secret to any client.
  const { ownerKey: _ok, ...publicVendor } = vendor;
  return res.json({ ...publicVendor, listings, ratings, avgRating, ratingCount });
});

router.post("/nursery/vendors/:id/ratings", async (req, res) => {
  const vendorId = Number(req.params.id);
  const rating = Number(req.body?.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5" });
  }
  const [row] = await db.insert(nurseryRatingsTable).values({
    vendorId,
    rating,
    comment: req.body?.comment || null,
    raterName: req.body?.raterName || null,
  }).returning();
  return res.status(201).json(row);
});

router.patch("/nursery/vendors/:id", async (req, res) => {
  // Never allow ownerKey to be (re)set through this route — that would let
  // anyone take over a shop and delete its listings.
  const { ownerKey: _ignored, ...patch } = (req.body ?? {}) as Record<string, unknown>;
  const [row] = await db.update(nurseryVendorsTable)
    .set(patch)
    .where(eq(nurseryVendorsTable.id, Number(req.params.id)))
    .returning();
  if (!row) return res.status(404).json({ message: "Vendor not found" });
  const { ownerKey: _ok, ...publicVendor } = row;
  return res.json(publicVendor);
});

router.delete("/nursery/vendors/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [vendor] = await db.select({ id: nurseryVendorsTable.id, ownerKey: nurseryVendorsTable.ownerKey })
    .from(nurseryVendorsTable).where(eq(nurseryVendorsTable.id, id));
  // Idempotent for offline retries.
  if (!vendor) return res.status(204).send();
  // Vendors registered with a per-device secret can only be removed by that
  // device. Legacy (null-key) vendors keep the old open behaviour so the
  // existing admin/cleanup flows continue to work.
  if (vendor.ownerKey) {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bodyKey = typeof b.ownerKey === "string" ? b.ownerKey.trim() : "";
    const callerKey = bodyKey || requestOwnerKey(req);
    if (!callerKey || callerKey !== vendor.ownerKey) {
      return res.status(403).json({ message: "You can only remove your own shop" });
    }
  }
  await db.delete(nurseryRatingsTable).where(eq(nurseryRatingsTable.vendorId, id));
  await db.delete(nurseryListingsTable).where(eq(nurseryListingsTable.vendorId, id));
  await db.delete(nurseryVendorsTable).where(eq(nurseryVendorsTable.id, id));
  return res.status(204).send();
});

router.get("/nursery/listings", async (req, res) => {
  const { category, vendorId, type } = req.query as { category?: string; vendorId?: string; type?: string };
  const listingType = type === "supplies" ? "supplies" : "nursery";
  const conditions = [
    eq(nurseryListingsTable.isAvailable, true),
    eq(nurseryListingsTable.type, listingType),
    eq(nurseryVendorsTable.status, "approved"),
    eq(nurseryVendorsTable.isActive, true),
  ];
  if (category) conditions.push(eq(nurseryListingsTable.category, category));
  if (vendorId) conditions.push(eq(nurseryListingsTable.vendorId, Number(vendorId)));
  const rows = await db
    .select({
      id: nurseryListingsTable.id,
      vendorId: nurseryListingsTable.vendorId,
      vendorName: nurseryVendorsTable.name,
      vendorPhone: nurseryVendorsTable.phone,
      vendorLocation: nurseryVendorsTable.location,
      name: nurseryListingsTable.name,
      category: nurseryListingsTable.category,
      price: nurseryListingsTable.price,
      unit: nurseryListingsTable.unit,
      qtyAvailable: nurseryListingsTable.qtyAvailable,
      description: nurseryListingsTable.description,
      photoUrl: nurseryListingsTable.photoUrl,
      isAvailable: nurseryListingsTable.isAvailable,
      createdAt: nurseryListingsTable.createdAt,
    })
    .from(nurseryListingsTable)
    .innerJoin(nurseryVendorsTable, eq(nurseryListingsTable.vendorId, nurseryVendorsTable.id))
    .where(and(...conditions))
    .orderBy(desc(nurseryListingsTable.createdAt));
  return res.json(rows);
});

router.post("/nursery/listings", requireOwner, requireActiveSubscription, async (req, res) => {
  const vendorId = Number(req.body?.vendorId);
  if (!vendorId) {
    return res.status(400).json({ message: "vendorId is required" });
  }
  const [vendor] = await db.select().from(nurseryVendorsTable)
    .where(eq(nurseryVendorsTable.id, vendorId));
  if (!vendor) {
    return res.status(404).json({ message: "Vendor not found" });
  }
  // Listing type is always derived from the vendor it belongs to, so a
  // nursery vendor can never hold supplies listings (or vice versa).
  const [row] = await db.insert(nurseryListingsTable)
    .values({ ...req.body, type: vendor.type })
    .returning();
  return res.status(201).json(row);
});

// Ownership gate for mutating a shop product: the listing's vendor must either
// have no ownerKey (legacy shop — old open behaviour preserved) or the caller
// must present the same per-device secret the shop was registered with.
async function canMutateNurseryListing(
  listingId: number,
  req: { get: (name: string) => string | undefined; body?: unknown },
): Promise<{ ok: true; missing?: boolean } | { ok: false }> {
  const [listing] = await db
    .select({ id: nurseryListingsTable.id, vendorId: nurseryListingsTable.vendorId })
    .from(nurseryListingsTable)
    .where(eq(nurseryListingsTable.id, listingId));
  if (!listing) return { ok: true, missing: true };
  const [vendor] = await db
    .select({ ownerKey: nurseryVendorsTable.ownerKey })
    .from(nurseryVendorsTable)
    .where(eq(nurseryVendorsTable.id, listing.vendorId));
  if (!vendor?.ownerKey) return { ok: true };
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bodyKey = typeof b.ownerKey === "string" ? b.ownerKey.trim() : "";
  const callerKey = bodyKey || requestOwnerKey(req);
  return callerKey === vendor.ownerKey ? { ok: true } : { ok: false };
}

router.patch("/nursery/listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const gate = await canMutateNurseryListing(id, req);
  if (!gate.ok) return res.status(403).json({ message: "You can only edit your own shop's products" });
  if (gate.missing) return res.status(404).json({ message: "Listing not found" });
  // Never allow re-parenting a listing to another vendor or changing its type
  // (and ownerKey is a proof field, not data).
  const { vendorId: _v, type: _t, ownerKey: _k, ...patch } = (req.body ?? {}) as Record<string, unknown>;
  const [row] = await db.update(nurseryListingsTable)
    .set(patch)
    .where(eq(nurseryListingsTable.id, id))
    .returning();
  return res.json(row);
});

router.delete("/nursery/listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const gate = await canMutateNurseryListing(id, req);
  if (!gate.ok) return res.status(403).json({ message: "You can only remove your own shop's products" });
  // Missing row → treat as already deleted so offline retries stay idempotent.
  await db.delete(nurseryListingsTable).where(eq(nurseryListingsTable.id, id));
  return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────────────────────
// Mandi (local market) prices — fetched AUTOMATICALLY every morning by AI web
// search. No manual entry: the server searches government/APMC mandi rates,
// curing works' published rates, vendor websites and local trade news for the
// estate's district + state, and caches the day's results. The farmer just
// opens the page (or types a crop) and sees who is buying, at what price, and
// the contact number when one is published.
// ──────────────────────────────────────────────────────────────────────────────

// Prevents two overlapping AI fetches for the same estate+day inside this
// process; the mandi_fetch_log unique row guards across restarts.
const mandiFetchesInFlight = new Set<string>();

// A "pending" log row older than this is considered dead (server restarted
// mid-fetch) and may be retried.
const MANDI_FETCH_STALE_MS = 5 * 60 * 1000;

function todayIsoIST(): string {
  // Market days follow Indian time regardless of server timezone.
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// AI/web-sourced URLs are untrusted: only keep parseable http(s) links so a
// malicious `javascript:`/`data:` URI can never reach the client as a link.
function sanitizeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

type AiMandiRow = {
  crop?: unknown;
  sellerName?: unknown;
  sellerType?: unknown;
  price?: unknown;
  priceMin?: unknown;
  priceMax?: unknown;
  unit?: unknown;
  priceDate?: unknown;
  location?: unknown;
  phone?: unknown;
  notes?: unknown;
  sourceName?: unknown;
  sourceUrl?: unknown;
};

// Runs the AI web search for one estate+day and stores whatever real quotes it
// found. Never throws — errors land in the fetch log so the client can show them.
async function runMandiFetch(eid: number | null, day: string): Promise<void> {
  const key = `${eid ?? "none"}:${day}`;
  if (mandiFetchesInFlight.has(key)) return;
  mandiFetchesInFlight.add(key);
  try {
    let village = "", district = "", state = "", crops: string[] = [];
    if (eid != null) {
      const [profile] = await db
        .select({
          village: farmProfileTable.village,
          district: farmProfileTable.district,
          state: farmProfileTable.state,
        })
        .from(farmProfileTable)
        .where(eq(farmProfileTable.id, eid));
      village = profile?.village ?? "";
      district = profile?.district ?? "";
      state = profile?.state ?? "";
      const cropRows = await db
        .select({ name: cropsTable.name })
        .from(cropsTable)
        .where(eq(cropsTable.estateId, eid));
      crops = cropRows.map((c) => c.name).filter(Boolean);
    }
    const place = [village, district, state].filter(Boolean).join(", ") || "Chikmagalur district, Karnataka";
    const cropList = crops.length
      ? crops.join(", ")
      : "Coffee (Arabica parchment, Arabica cherry, Robusta parchment, Robusta cherry), Black pepper, Arecanut, Paddy, Ragi, Ginger";

    const prompt = [
      `Today is ${day}. Find TODAY'S farm-gate / mandi buying prices near ${place}, India. Strongly prefer quotes dated ${day} or the most recent trading day; skip anything older than 30 days.`,
      `Crops to cover: ${cropList}. Also include any other crop actively traded in this district today.`,
      `Search these kinds of sources: curing works' published daily rates, APMC / Agmarknet government mandi prices, local commodity price websites and trade news, buyer/vendor websites and their public social media pages.`,
      `EVERY ENTRY MUST BE VARIETY-SPECIFIC — never report a generic crop price when the source quotes varieties or grades. Name the crop exactly like "Crop – Variety": e.g. "Coffee – Arabica Parchment", "Coffee – Arabica Cherry", "Coffee – Robusta Parchment", "Coffee – Robusta Cherry", "Black pepper – Garbled", "Black pepper – Ungarbled", "Arecanut – Rashi", "Arecanut – Bette", "Paddy – Sona Masuri". Only when a source truly gives no variety, use the plain crop name.`,
      `Coffee is normally quoted per 50 kg bag — keep the source's unit. When a curing works quotes an outturn (OT) based rate for cherry, put it in "notes" like "OT 48%".`,
      `For each real quote, report WHO is buying (mandi, curing works, trader or buyer name), the price in INR, and their phone number ONLY if it is actually published on a source page.`,
      `Return ONLY a JSON array (no prose, no markdown) where each element is:`,
      `{"crop": string, "sellerName": string, "sellerType": "Mandi"|"Curing works"|"Trader"|"Exporter"|"Local buyer"|"Government", "price": number, "priceMin": number|null, "priceMax": number|null, "unit": string (exactly one of: "per kg", "per 50 kg bag", "per quintal", "per tonne"), "priceDate": "YYYY-MM-DD" (the date the quote is for), "location": string|null, "phone": string|null, "notes": string|null, "sourceName": string|null, "sourceUrl": string|null}`,
      `Rules: price is the main/modal quote in the stated unit. Never invent a price, seller name or phone number — include only what a source actually states. If a range is given use its midpoint as price and fill priceMin/priceMax. Prefer quotes specific to ${district || place}; fall back to ${state || "state"}-level mandi prices when the district has none.`,
      `"notes" must be SHORT and simple — at most 8 words a farmer instantly understands (e.g. "OT 50%", "Garbled grade", "New crop"). Do NOT put dates, source explanations or long sentences in notes; put the quote date in "priceDate" instead. Use null when there is nothing essential.`,
    ].join("\n");

    const num = (v: unknown): number | null => {
      const n = typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : null;

    // The web search is nondeterministic — one attempt can come back empty
    // while the next finds plenty. Try up to 2 times before giving up.
    let rows: (typeof mandiDailyPricesTable.$inferInsert)[] = [];
    for (let attempt = 1; attempt <= 2 && rows.length === 0; attempt++) {
      // Hard timeout so a hung search can never leave the log stuck on
      // "pending" past the stale window.
      const response = await openai.responses.create({
        model: "gpt-5.4",
        tools: [{ type: "web_search" }],
        input: prompt,
      }, { timeout: 4 * 60 * 1000 });
      const text = response.output_text ?? "";
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start === -1 || end === -1 || end <= start) {
        console.error(`[mandi] attempt ${attempt}: no JSON array in output (${text.slice(0, 200)})`);
        continue;
      }
      let parsed: AiMandiRow[];
      try {
        parsed = JSON.parse(text.slice(start, end + 1)) as AiMandiRow[];
      } catch {
        console.error(`[mandi] attempt ${attempt}: JSON parse failed (${text.slice(start, start + 200)})`);
        continue;
      }
      rows = parsed
        .map((r) => {
          const crop = str(r.crop);
          const sellerName = str(r.sellerName);
          const price = num(r.price);
          if (!crop || !sellerName || price == null) return null;
          return {
            estateId: eid,
            date: day,
            crop,
            sellerName,
            sellerType: str(r.sellerType) ?? "Mandi",
            price: price.toFixed(2),
            priceMin: num(r.priceMin)?.toFixed(2) ?? null,
            priceMax: num(r.priceMax)?.toFixed(2) ?? null,
            unit: str(r.unit) ?? "per kg",
            priceDate: (() => {
              const d = str(r.priceDate);
              return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= day ? d : null;
            })(),
            location: str(r.location),
            phone: str(r.phone),
            notes: str(r.notes),
            sourceName: str(r.sourceName),
            sourceUrl: sanitizeUrl(r.sourceUrl),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r != null);
      if (rows.length === 0) {
        console.error(`[mandi] attempt ${attempt}: 0 usable rows from output (${text.slice(0, 300)})`);
      }
    }
    // Enforce currency strictly: a quote must carry a valid date and be at
    // most 45 days old, otherwise it is dropped — undated or ancient quotes
    // are exactly what confuses farmers.
    const cutoff = new Date(new Date(`${day}T00:00:00Z`).getTime() - 45 * 86400000)
      .toISOString()
      .slice(0, 10);
    rows = rows.filter((r) => r.priceDate != null && r.priceDate >= cutoff);
    // Dedupe within the run — same buyer quoting the same crop in the same
    // unit twice is noise, keep the first occurrence.
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = `${r.crop}|${r.sellerName}|${r.unit}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (rows.length === 0) {
      throw new Error("No prices found this attempt — tap Check again");
    }

    // Merge into the day's rows: each web-search run is nondeterministic and
    // may cover different crops, so replace only the crops this run found and
    // keep earlier runs' rows for other crops. That way coverage accumulates
    // instead of flickering between refreshes. Out-of-window or undated rows
    // from earlier runs are also swept out so staleness can never linger.
    await db.transaction(async (tx) => {
      const foundCrops = [...new Set(rows.map((r) => r.crop))];
      const dayScope = eid != null
        ? and(eq(mandiDailyPricesTable.date, day), eq(mandiDailyPricesTable.estateId, eid))
        : and(eq(mandiDailyPricesTable.date, day), isNull(mandiDailyPricesTable.estateId));
      await tx.delete(mandiDailyPricesTable)
        .where(and(dayScope, or(
          inArray(mandiDailyPricesTable.crop, foundCrops),
          isNull(mandiDailyPricesTable.priceDate),
          lt(mandiDailyPricesTable.priceDate, cutoff),
        )));
      if (rows.length > 0) await tx.insert(mandiDailyPricesTable).values(rows);
      const logScope = eid != null
        ? and(eq(mandiFetchLogTable.date, day), eq(mandiFetchLogTable.estateId, eid))
        : and(eq(mandiFetchLogTable.date, day), isNull(mandiFetchLogTable.estateId));
      await tx.update(mandiFetchLogTable)
        .set({ status: "done", error: null, fetchedAt: new Date() })
        .where(logScope);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mandi] AI price fetch failed for estate ${eid} on ${day}:`, message);
    const logScope = eid != null
      ? and(eq(mandiFetchLogTable.date, day), eq(mandiFetchLogTable.estateId, eid))
      : and(eq(mandiFetchLogTable.date, day), isNull(mandiFetchLogTable.estateId));
    await db.update(mandiFetchLogTable)
      .set({ status: "error", error: message.slice(0, 500), fetchedAt: new Date() })
      .where(logScope)
      .catch(() => {});
  } finally {
    mandiFetchesInFlight.delete(key);
  }
}

// Creates the day's fetch-log row (or revives a dead/errored one) and kicks off
// the AI search in the background. Returns the current log status.
async function ensureMandiFetch(eid: number | null, day: string, force = false): Promise<string> {
  const logScope = eid != null
    ? and(eq(mandiFetchLogTable.date, day), eq(mandiFetchLogTable.estateId, eid))
    : and(eq(mandiFetchLogTable.date, day), isNull(mandiFetchLogTable.estateId));
  const [log] = await db.select().from(mandiFetchLogTable).where(logScope);
  if (log) {
    const stale = log.status === "pending" &&
      Date.now() - new Date(log.fetchedAt).getTime() > MANDI_FETCH_STALE_MS;
    const shouldRetry = force || stale || (log.status === "error" && force);
    if (!shouldRetry && (log.status === "done" || log.status === "pending")) return log.status;
    if (log.status === "error" && !force && !stale) return log.status;
    await db.update(mandiFetchLogTable)
      .set({ status: "pending", error: null, fetchedAt: new Date() })
      .where(logScope);
  } else {
    // Unique index on (estate,day) makes concurrent first requests collapse to one row.
    const inserted = await db.insert(mandiFetchLogTable)
      .values({ estateId: eid, date: day, status: "pending" })
      .onConflictDoNothing()
      .returning({ id: mandiFetchLogTable.id });
    if (inserted.length === 0) return "pending";
  }
  void runMandiFetch(eid, day);
  return "pending";
}

// The day's prices (auto-fetching them on the first request each morning).
// ?q= filters by crop or seller name — "coffee" shows every coffee quote.
router.get("/mandi/prices", async (req, res) => {
  const { q } = req.query as Record<string, string>;
  const day = todayIsoIST();
  const eid = await activeEstateId(req);

  const status = await ensureMandiFetch(eid, day);

  const logScope = eid != null
    ? and(eq(mandiFetchLogTable.date, day), eq(mandiFetchLogTable.estateId, eid))
    : and(eq(mandiFetchLogTable.date, day), isNull(mandiFetchLogTable.estateId));
  const [log] = await db.select().from(mandiFetchLogTable).where(logScope);

  const conditions = [eq(mandiDailyPricesTable.date, day)];
  conditions.push(eid != null ? eq(mandiDailyPricesTable.estateId, eid) : isNull(mandiDailyPricesTable.estateId));
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    const match = or(
      sql`${mandiDailyPricesTable.crop} ILIKE ${like}`,
      sql`${mandiDailyPricesTable.sellerName} ILIKE ${like}`,
      sql`${mandiDailyPricesTable.sellerType} ILIKE ${like}`,
    );
    if (match) conditions.push(match);
  }
  const rows = await db
    .select()
    .from(mandiDailyPricesTable)
    .where(and(...conditions))
    .orderBy(mandiDailyPricesTable.crop, desc(mandiDailyPricesTable.price))
    .limit(500);

  return res.json({
    date: day,
    status: log?.status ?? status,
    error: log?.status === "error" ? log.error : null,
    fetchedAt: log?.fetchedAt ?? null,
    prices: rows,
  });
});

// Manual "check again" — re-runs the AI search for today (e.g. after an error,
// or later in the day when curing works update their boards).
router.post("/mandi/refresh", async (req, res) => {
  const day = todayIsoIST();
  const eid = await activeEstateId(req);
  const status = await ensureMandiFetch(eid, day, true);
  return res.status(202).json({ date: day, status });
});

// ── Morning scheduler ────────────────────────────────────────────────────────
// Runs the day's fetch for every estate automatically once markets open
// (6 AM IST), without waiting for someone to open the Mandi page. The page
// request path stays as a fallback for estates created later in the day.
const MANDI_MARKET_OPEN_HOUR_IST = 6;

function istHour(): number {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

async function morningMandiSweep(): Promise<void> {
  if (istHour() < MANDI_MARKET_OPEN_HOUR_IST) return;
  const day = todayIsoIST();
  try {
    const estates = await db.select({ id: farmProfileTable.id }).from(farmProfileTable);
    for (const e of estates) {
      // ensureMandiFetch is idempotent per estate+day — done/pending days are skipped.
      await ensureMandiFetch(e.id, day);
    }
  } catch (err) {
    console.error("[mandi] morning sweep failed:", err instanceof Error ? err.message : err);
  }
}

// Check every 15 minutes; the fetch-log unique row means at most one real AI
// search per estate per day. unref() keeps the timer from blocking shutdown.
setInterval(() => void morningMandiSweep(), 15 * 60 * 1000).unref();
setTimeout(() => void morningMandiSweep(), 20 * 1000).unref();

export default router;
