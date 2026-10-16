import { Router } from "express";
import { and, eq, countDistinct } from "drizzle-orm";
import {
  db,
  contentReportsTable,
  contentBlocksTable,
  produceListingsTable,
  equipmentListingsTable,
  hireListingsTable,
} from "../db";
import { requestOwnerKey } from "../lib/owner-key";
import { logger } from "../lib/logger";

const router = Router();

const REASONS = new Set(["spam", "misleading", "offensive", "illegal", "other"]);
const HIDE_AFTER_REPORTS = 3;

async function listingOwnerKey(board: string, id: number): Promise<{ found: boolean; ownerKey: string | null }> {
  const table =
    board === "produce" ? produceListingsTable : board === "equipment" ? equipmentListingsTable : hireListingsTable;
  const [row] = await db.select({ ownerKey: table.ownerKey }).from(table).where(eq(table.id, id)).limit(1);
  return { found: !!row, ownerKey: row?.ownerKey ?? null };
}

async function hideForEveryone(board: string, id: number) {
  if (board === "produce") await db.update(produceListingsTable).set({ isAvailable: false }).where(eq(produceListingsTable.id, id));
  else if (board === "equipment") await db.update(equipmentListingsTable).set({ isAvailable: false }).where(eq(equipmentListingsTable.id, id));
  else await db.update(hireListingsTable).set({ isActive: false }).where(eq(hireListingsTable.id, id));
}

// Report a listing, and optionally block everything its poster lists. The
// listing is hidden for the reporter straight away.
router.post("/content/report", async (req, res) => {
  const callerKey = requestOwnerKey(req);
  const b = req.body ?? {};
  const board = String(b.board ?? "");
  const listingId = Number(b.listingId);
  const reason = String(b.reason ?? "");
  const details = typeof b.details === "string" ? b.details.trim().slice(0, 1000) : "";
  const block = b.block === true;

  if (!callerKey) return res.status(400).json({ message: "Missing device key" });
  if (!["produce", "equipment", "hire"].includes(board) || !Number.isInteger(listingId) || listingId <= 0) {
    return res.status(400).json({ message: "Unknown listing" });
  }
  if (!REASONS.has(reason)) return res.status(400).json({ message: "Choose a reason" });

  const listing = await listingOwnerKey(board, listingId);
  if (!listing.found) return res.status(404).json({ message: "Not found" });
  if (listing.ownerKey && listing.ownerKey === callerKey) {
    return res.status(400).json({ message: "This is your own ad" });
  }

  await db.insert(contentReportsTable).values({ board, listingId, reason, details: details || null, reporterKey: callerKey });
  await db
    .insert(contentBlocksTable)
    .values({ blockerKey: callerKey, board, listingId, blockedOwnerKey: block ? listing.ownerKey : null })
    .onConflictDoUpdate({
      target: [contentBlocksTable.blockerKey, contentBlocksTable.board, contentBlocksTable.listingId],
      set: block ? { blockedOwnerKey: listing.ownerKey } : {},
    });

  const [{ n }] = await db
    .select({ n: countDistinct(contentReportsTable.reporterKey) })
    .from(contentReportsTable)
    .where(and(eq(contentReportsTable.board, board), eq(contentReportsTable.listingId, listingId)));
  if (Number(n) >= HIDE_AFTER_REPORTS) await hideForEveryone(board, listingId);

  logger.warn({ board, listingId, reason, block, reports: Number(n) }, "content reported");
  return res.status(201).json({ ok: true, blocked: block && !!listing.ownerKey });
});

export default router;
