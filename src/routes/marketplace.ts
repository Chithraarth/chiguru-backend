import { Router } from "express";
import { db } from "../db";
import { produceListingsTable } from "../db";
import { eq, and, desc } from "drizzle-orm";
import { requestOwnerKey, publicRow, bodyOwnerKey } from "../lib/owner-key";
import { requireOwner } from "../middlewares/firebaseAuth";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";

const router = Router();

const CATEGORIES = [
  "coffee", "pepper", "honey", "spices", "fruits",
  "tea", "vegetables", "grains", "dairy", "other",
];

// List active produce listings (newest first), optionally filtered by category.
router.get("/produce-listings", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const callerKey = requestOwnerKey(req);

  const filters = [eq(produceListingsTable.isAvailable, true)];
  // mine=1 → only this device's ads, for the "My Ads" page. Requires the
  // owner-key header; without it there is nothing to match.
  if (req.query.mine === "1") {
    if (!callerKey) return res.json([]);
    filters.push(eq(produceListingsTable.ownerKey, callerKey));
  }
  if (category && category !== "all") {
    filters.push(eq(produceListingsTable.category, category));
  }
  const rows = await db
    .select()
    .from(produceListingsTable)
    .where(and(...filters))
    .orderBy(desc(produceListingsTable.createdAt))
    .limit(200);
  return res.json(rows.map((r) => publicRow(r, callerKey)));
});

router.get("/produce-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.select().from(produceListingsTable).where(eq(produceListingsTable.id, id)).limit(1);
  if (rows.length === 0) return res.status(404).json({ error: "Listing not found" });
  return res.json(publicRow(rows[0], requestOwnerKey(req)));
});

// Create a listing. Whitelist + validate input; never insert raw body.
router.post("/produce-listings", requireOwner, requireActiveSubscription, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const optStr = (v: unknown) => (trim(v) ? trim(v) : null);

  const sellerName = trim(b.sellerName);
  const phone = trim(b.phone);
  const productName = trim(b.productName);
  const location = trim(b.location);
  const price = Number(b.price);
  const category = CATEGORIES.includes(trim(b.category)) ? trim(b.category) : "other";

  if (!sellerName) return res.status(400).json({ error: "sellerName is required" });
  if (!productName) return res.status(400).json({ error: "productName is required" });
  if (!location) return res.status(400).json({ error: "location is required" });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "price must be a non-negative number" });

  // Phone must be dialable: 10–15 digits (so tel:/wa.me links work for buyers).
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
    .insert(produceListingsTable)
    .values({
      sellerName,
      phone,
      whatsapp,
      productName,
      category,
      price: String(Math.min(10000000, price)),
      unit: optStr(b.unit) ?? "kg",
      quantity: optStr(b.quantity),
      location,
      description: optStr(b.description),
      photoUrl,
      ownerKey,
    })
    .returning();
  return res.json(publicRow(row, ownerKey ?? ""));
});

// Delete own ad. No auth in this app, so ownership is proven by presenting the
// same secret ownerKey the ad was created with. Rows without an ownerKey (posted
// by older clients) cannot be deleted this way.
router.delete("/produce-listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bodyKey = typeof b.ownerKey === "string" ? b.ownerKey.trim() : "";
  const callerKey = bodyKey || requestOwnerKey(req);
  if (!callerKey) return res.status(400).json({ error: "Missing owner key" });

  const rows = await db
    .select({ id: produceListingsTable.id, ownerKey: produceListingsTable.ownerKey })
    .from(produceListingsTable)
    .where(eq(produceListingsTable.id, id))
    .limit(1);
  // Treat already-deleted as success so offline retries stay idempotent.
  if (rows.length === 0) return res.status(204).end();
  if (!rows[0].ownerKey || rows[0].ownerKey !== callerKey) {
    return res.status(403).json({ error: "You can only delete your own ad" });
  }

  await db.delete(produceListingsTable).where(eq(produceListingsTable.id, id));
  return res.status(204).end();
});

export default router;
