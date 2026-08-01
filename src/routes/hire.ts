import { Router } from "express";
import { db } from "../db";
import { hireListingsTable } from "../db";
import { eq, and, desc } from "drizzle-orm";

const router = Router();

// Two sides of the Hire board. Kept in sync with the frontend lists; anything
// unknown falls back to "other".
const LISTING_TYPES = ["rental", "job"];

const RENTAL_CATEGORIES = [
  "tractor", "jcb_hitachi", "harvester", "weight_machine",
  "auto_tempo", "pickup", "sprayer", "power_tiller", "other",
];

const JOB_CATEGORIES = [
  // "farm_labourers" replaced the old mp/assam/local split; legacy keys stay
  // accepted so offline-queued posts from older clients still land.
  "farm_labourers", "mp_workers", "assam_workers", "local_workers", "women_workers",
  "mestri", "manager_writer", "other",
];

// The poster's per-device secret. Sent as a header on reads (to flag "mine") and
// in the body on delete (to prove ownership). Never echoed back in responses.
function requestOwnerKey(req: { get: (name: string) => string | undefined }): string {
  const raw = req.get("X-Owner-Key");
  return typeof raw === "string" && raw.length <= 80 ? raw.trim() : "";
}

// Strip the secret before sending a row to any client; add a `mine` flag the
// caller's device can trust to show its own delete button.
function publicRow(row: typeof hireListingsTable.$inferSelect, callerKey: string) {
  const { ownerKey, ...rest } = row;
  return { ...rest, mine: Boolean(callerKey && ownerKey && ownerKey === callerKey) };
}

// List active hire ads (newest first). Open board — no auth / subscription gate.
// Optional filters: type (rental|job), category, district (case-insensitive contains
// handled client-side; here we filter exact type/category only and return by district
// text match when provided).
router.get("/hire-listings", async (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const callerKey = requestOwnerKey(req);

  const filters = [eq(hireListingsTable.isActive, true)];
  // mine=1 → only this device's ads (both rental + job), for the "My Ads" page.
  // Requires the owner-key header; without it there is nothing to match.
  if (req.query.mine === "1") {
    if (!callerKey) return res.json([]);
    filters.push(eq(hireListingsTable.ownerKey, callerKey));
  }
  if (type && LISTING_TYPES.includes(type)) {
    filters.push(eq(hireListingsTable.listingType, type));
  }
  if (category && category !== "all") {
    filters.push(eq(hireListingsTable.category, category));
  }

  const rows = await db
    .select()
    .from(hireListingsTable)
    .where(and(...filters))
    .orderBy(desc(hireListingsTable.createdAt))
    .limit(300);
  return res.json(rows.map((r) => publicRow(r, callerKey)));
});

router.get("/hire-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(hireListingsTable)
    .where(eq(hireListingsTable.id, id))
    .limit(1);
  if (rows.length === 0) return res.status(404).json({ error: "Listing not found" });
  return res.json(publicRow(rows[0], requestOwnerKey(req)));
});

// Post a hire ad. Open to everyone (no plan gate) — but whitelist + validate every
// field; never insert raw body. No auth means mutating routes are a griefing surface,
// so deletes are gated by the per-ad ownerKey secret and no edit route exists.
router.post("/hire-listings", async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const optStr = (v: unknown) => (trim(v) ? trim(v) : null);

  const listingType = LISTING_TYPES.includes(trim(b.listingType)) ? trim(b.listingType) : "rental";
  const validCats = listingType === "job" ? JOB_CATEGORIES : RENTAL_CATEGORIES;
  const category = validCats.includes(trim(b.category)) ? trim(b.category) : "other";

  const title = trim(b.title);
  const posterName = trim(b.posterName);
  const phone = trim(b.phone);
  const district = trim(b.district);

  if (!title) return res.status(400).json({ error: "title is required" });
  if (!posterName) return res.status(400).json({ error: "posterName is required" });
  if (!district) return res.status(400).json({ error: "district is required" });

  // Cap every text field. This is an unauthenticated, global write route, so
  // length limits are the primary defence against spam/storage-bloat attacks.
  const taluk = optStr(b.taluk);
  const village = optStr(b.village);
  const rate = optStr(b.rate);
  const description = optStr(b.description);
  if (
    title.length > 200 ||
    posterName.length > 120 ||
    district.length > 120 ||
    (taluk && taluk.length > 120) ||
    (village && village.length > 120) ||
    (rate && rate.length > 120) ||
    (description && description.length > 2000)
  ) {
    return res.status(400).json({ error: "One or more fields are too long" });
  }

  // Phone must be dialable: 10–15 digits so tel:/wa.me links work for callers.
  // Also cap the raw string length: digit-count alone lets an attacker embed a
  // valid number inside a huge string on this unauthenticated write route.
  const whatsapp = optStr(b.whatsapp);
  if (phone.length > 40 || (whatsapp && whatsapp.length > 40)) {
    return res.status(400).json({ error: "Phone number is too long" });
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({ error: "Enter a valid phone number" });
  }
  const waDigits = whatsapp ? whatsapp.replace(/\D/g, "") : "";
  if (whatsapp && (waDigits.length < 10 || waDigits.length > 15)) {
    return res.status(400).json({ error: "Enter a valid WhatsApp number" });
  }

  // Optional geo coordinates for the nearby-radius filter. Validate ranges; drop
  // anything out of bounds rather than storing garbage.
  const latNum = Number(b.latitude);
  const lngNum = Number(b.longitude);
  const latitude = Number.isFinite(latNum) && latNum >= -90 && latNum <= 90 ? String(latNum) : null;
  const longitude = Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180 ? String(lngNum) : null;

  // Workers needed only meaningful for job posts.
  const wnNum = Number(b.workersNeeded);
  const workersNeeded =
    listingType === "job" && Number.isFinite(wnNum) && wnNum > 0
      ? Math.min(9999, Math.floor(wnNum))
      : null;

  // Cap photo payload (~3MB base64) to protect the DB from oversized images.
  const photoUrl = optStr(b.photoUrl);
  if (photoUrl && photoUrl.length > 3_000_000) {
    return res.status(413).json({ error: "Photo is too large" });
  }

  // Poster's per-device secret so they can delete their own ad later. Optional
  // (older clients don't send it); capped like every other free-text input.
  const ownerKeyRaw = trim(b.ownerKey);
  const ownerKey = ownerKeyRaw && ownerKeyRaw.length <= 80 ? ownerKeyRaw : null;

  const [row] = await db
    .insert(hireListingsTable)
    .values({
      listingType,
      category,
      title,
      posterName,
      phone,
      whatsapp,
      district,
      taluk,
      village,
      latitude,
      longitude,
      rate,
      workersNeeded,
      description,
      photoUrl,
      ownerKey,
    })
    .returning();
  return res.json(publicRow(row, ownerKey ?? ""));
});

// Edit own ad. Ownership proven by the same secret ownerKey used to create it
// (from body or header). listingType is immutable — a rental stays a rental.
router.patch("/hire-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const optStr = (v: unknown) => (trim(v) ? trim(v) : null);

  const bodyKey = trim(b.ownerKey);
  const callerKey = bodyKey || requestOwnerKey(req);
  if (!callerKey) return res.status(400).json({ error: "Missing owner key" });

  const existing = await db
    .select()
    .from(hireListingsTable)
    .where(eq(hireListingsTable.id, id))
    .limit(1);
  if (existing.length === 0) return res.status(404).json({ error: "Ad not found" });
  const current = existing[0];
  if (!current.ownerKey || current.ownerKey !== callerKey) {
    return res.status(403).json({ error: "You can only edit your own ad" });
  }

  // listingType is fixed to the existing row so categories validate correctly.
  const listingType = current.listingType;
  const validCats = listingType === "job" ? JOB_CATEGORIES : RENTAL_CATEGORIES;
  const category = validCats.includes(trim(b.category)) ? trim(b.category) : "other";

  const title = trim(b.title);
  const posterName = trim(b.posterName);
  const phone = trim(b.phone);
  const district = trim(b.district);
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!posterName) return res.status(400).json({ error: "posterName is required" });
  if (!district) return res.status(400).json({ error: "district is required" });

  const taluk = optStr(b.taluk);
  const village = optStr(b.village);
  const rate = optStr(b.rate);
  const description = optStr(b.description);
  if (
    title.length > 200 ||
    posterName.length > 120 ||
    district.length > 120 ||
    (taluk && taluk.length > 120) ||
    (village && village.length > 120) ||
    (rate && rate.length > 120) ||
    (description && description.length > 2000)
  ) {
    return res.status(400).json({ error: "One or more fields are too long" });
  }

  const whatsapp = optStr(b.whatsapp);
  if (phone.length > 40 || (whatsapp && whatsapp.length > 40)) {
    return res.status(400).json({ error: "Phone number is too long" });
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({ error: "Enter a valid phone number" });
  }
  const waDigits = whatsapp ? whatsapp.replace(/\D/g, "") : "";
  if (whatsapp && (waDigits.length < 10 || waDigits.length > 15)) {
    return res.status(400).json({ error: "Enter a valid WhatsApp number" });
  }

  const latNum = Number(b.latitude);
  const lngNum = Number(b.longitude);
  const latitude = Number.isFinite(latNum) && latNum >= -90 && latNum <= 90 ? String(latNum) : null;
  const longitude = Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180 ? String(lngNum) : null;

  const wnNum = Number(b.workersNeeded);
  const workersNeeded =
    listingType === "job" && Number.isFinite(wnNum) && wnNum > 0
      ? Math.min(9999, Math.floor(wnNum))
      : null;

  const photoUrl = optStr(b.photoUrl);
  if (photoUrl && photoUrl.length > 3_000_000) {
    return res.status(413).json({ error: "Photo is too large" });
  }

  const [row] = await db
    .update(hireListingsTable)
    .set({
      category,
      title,
      posterName,
      phone,
      whatsapp,
      district,
      taluk,
      village,
      latitude,
      longitude,
      rate,
      workersNeeded,
      description,
      photoUrl,
    })
    .where(eq(hireListingsTable.id, id))
    .returning();
  // Rare: row vanished between the ownership check and the update.
  if (!row) return res.status(404).json({ error: "Ad not found" });
  return res.json(publicRow(row, callerKey));
});

// Delete own ad. No auth in this app, so ownership is proven by presenting the
// same secret ownerKey the ad was created with. Rows without an ownerKey (posted
// by older clients) cannot be deleted this way.
router.delete("/hire-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bodyKey = typeof b.ownerKey === "string" ? b.ownerKey.trim() : "";
  const callerKey = bodyKey || requestOwnerKey(req);
  if (!callerKey) return res.status(400).json({ error: "Missing owner key" });

  const rows = await db
    .select({ id: hireListingsTable.id, ownerKey: hireListingsTable.ownerKey })
    .from(hireListingsTable)
    .where(eq(hireListingsTable.id, id))
    .limit(1);
  // Treat already-deleted as success so offline retries stay idempotent.
  if (rows.length === 0) return res.status(204).end();
  if (!rows[0].ownerKey || rows[0].ownerKey !== callerKey) {
    return res.status(403).json({ error: "You can only delete your own ad" });
  }

  await db.delete(hireListingsTable).where(eq(hireListingsTable.id, id));
  return res.status(204).end();
});

export default router;
