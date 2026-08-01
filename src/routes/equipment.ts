import { Router } from "express";
import { db } from "../db";
import { equipmentListingsTable } from "../db";
import { eq, and, desc } from "drizzle-orm";
import { requestOwnerKey, publicRow, bodyOwnerKey } from "../lib/owner-key";
import { requireOwner } from "../middlewares/firebaseAuth";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";

const router = Router();

// Equipment types farmers buy/sell secondhand or new. Kept in sync with the
// frontend CATEGORIES list; anything unknown falls back to "other".
const CATEGORIES = [
  "tractor", "weeding_machine", "spray_pump", "sprinkler", "tiller",
  "harvester", "plough", "trailer", "power_tools", "irrigation", "other",
];

const CONDITIONS = ["new", "used"];

// List active equipment ads (newest first), optionally filtered by category
// and/or condition. This is an OPEN board — no subscription gate on reading.
router.get("/equipment-listings", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const condition = typeof req.query.condition === "string" ? req.query.condition : "";
  const callerKey = requestOwnerKey(req);

  const filters = [eq(equipmentListingsTable.isAvailable, true)];
  // mine=1 → only this device's ads, for the "My Ads" page. Requires the
  // owner-key header; without it there is nothing to match.
  if (req.query.mine === "1") {
    if (!callerKey) return res.json([]);
    filters.push(eq(equipmentListingsTable.ownerKey, callerKey));
  }
  if (category && category !== "all") {
    filters.push(eq(equipmentListingsTable.category, category));
  }
  if (condition && condition !== "all" && CONDITIONS.includes(condition)) {
    filters.push(eq(equipmentListingsTable.condition, condition));
  }

  const rows = await db
    .select()
    .from(equipmentListingsTable)
    .where(and(...filters))
    .orderBy(desc(equipmentListingsTable.createdAt))
    .limit(200);
  return res.json(rows.map((r) => publicRow(r, callerKey)));
});

router.get("/equipment-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(equipmentListingsTable)
    .where(eq(equipmentListingsTable.id, id))
    .limit(1);
  if (rows.length === 0) return res.status(404).json({ error: "Listing not found" });
  return res.json(publicRow(rows[0], requestOwnerKey(req)));
});

// Post an equipment ad — requires an active subscription. Still whitelist +
// validate every field; never insert raw body.
router.post("/equipment-listings", requireOwner, requireActiveSubscription, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const optStr = (v: unknown) => (trim(v) ? trim(v) : null);

  const sellerName = trim(b.sellerName);
  const phone = trim(b.phone);
  const title = trim(b.title);
  const location = trim(b.location);
  const price = Number(b.price);
  const category = CATEGORIES.includes(trim(b.category)) ? trim(b.category) : "other";
  const condition = CONDITIONS.includes(trim(b.condition)) ? trim(b.condition) : "used";

  if (!sellerName) return res.status(400).json({ error: "sellerName is required" });
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!location) return res.status(400).json({ error: "location is required" });
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "price must be a non-negative number" });
  }

  // Cap every text field. This is an unauthenticated, global write route, so
  // length limits are the primary defence against spam/storage-bloat attacks.
  const description = optStr(b.description);
  if (
    sellerName.length > 120 ||
    title.length > 200 ||
    location.length > 200 ||
    (description && description.length > 2000)
  ) {
    return res.status(400).json({ error: "One or more fields are too long" });
  }

  // Phone must be dialable: 10–15 digits so tel:/wa.me links work for buyers.
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({ error: "Enter a valid phone number" });
  }
  const whatsapp = optStr(b.whatsapp);
  const waDigits = whatsapp ? whatsapp.replace(/\D/g, "") : "";
  if (whatsapp && (waDigits.length < 10 || waDigits.length > 15)) {
    return res.status(400).json({ error: "Enter a valid WhatsApp number" });
  }

  // Cap photo payload (~3MB base64) to protect the DB from oversized images.
  const photoUrl = optStr(b.photoUrl);
  if (photoUrl && photoUrl.length > 3_000_000) {
    return res.status(413).json({ error: "Photo is too large" });
  }

  // Poster's per-device secret so they can delete their own ad later. Optional
  // (older clients don't send it).
  const ownerKey = bodyOwnerKey(b.ownerKey);

  const [row] = await db
    .insert(equipmentListingsTable)
    .values({
      sellerName,
      phone,
      whatsapp,
      title,
      category,
      condition,
      // Equipment can be pricey (tractors, harvesters) — cap at ₹10 crore.
      price: String(Math.min(100000000, price)),
      location,
      description,
      photoUrl,
      ownerKey,
    })
    .returning();
  return res.json(publicRow(row, ownerKey ?? ""));
});

// Delete own ad. No auth in this app, so ownership is proven by presenting the
// same secret ownerKey the ad was created with. Rows without an ownerKey (posted
// by older clients) cannot be deleted this way.
router.delete("/equipment-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bodyKey = typeof b.ownerKey === "string" ? b.ownerKey.trim() : "";
  const callerKey = bodyKey || requestOwnerKey(req);
  if (!callerKey) return res.status(400).json({ error: "Missing owner key" });

  const rows = await db
    .select({ id: equipmentListingsTable.id, ownerKey: equipmentListingsTable.ownerKey })
    .from(equipmentListingsTable)
    .where(eq(equipmentListingsTable.id, id))
    .limit(1);
  // Treat already-deleted as success so offline retries stay idempotent.
  if (rows.length === 0) return res.status(204).end();
  if (!rows[0].ownerKey || rows[0].ownerKey !== callerKey) {
    return res.status(403).json({ error: "You can only delete your own ad" });
  }

  await db.delete(equipmentListingsTable).where(eq(equipmentListingsTable.id, id));
  return res.status(204).end();
});

export default router;
