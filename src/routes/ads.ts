import { Router } from "express";
import { db } from "../db";
import {
  hireListingsTable,
  equipmentListingsTable,
  produceListingsTable,
} from "../db";
import { eq, desc } from "drizzle-orm";

const router = Router();

// A small unified feed of the newest ads people have posted across the open
// community boards (hire, equipment, produce). Read-only and ungated, exactly
// like the individual board reads. Contact details are deliberately left out —
// tapping an ad opens its board where the full details live.
router.get("/ads/recent", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

  const [hire, equipment, produce] = await Promise.all([
    db
      .select({
        id: hireListingsTable.id,
        title: hireListingsTable.title,
        listingType: hireListingsTable.listingType,
        place: hireListingsTable.district,
        createdAt: hireListingsTable.createdAt,
      })
      .from(hireListingsTable)
      .where(eq(hireListingsTable.isActive, true))
      .orderBy(desc(hireListingsTable.createdAt))
      .limit(limit),
    db
      .select({
        id: equipmentListingsTable.id,
        title: equipmentListingsTable.title,
        place: equipmentListingsTable.location,
        createdAt: equipmentListingsTable.createdAt,
      })
      .from(equipmentListingsTable)
      .where(eq(equipmentListingsTable.isAvailable, true))
      .orderBy(desc(equipmentListingsTable.createdAt))
      .limit(limit),
    db
      .select({
        id: produceListingsTable.id,
        title: produceListingsTable.productName,
        place: produceListingsTable.location,
        createdAt: produceListingsTable.createdAt,
      })
      .from(produceListingsTable)
      .where(eq(produceListingsTable.isAvailable, true))
      .orderBy(desc(produceListingsTable.createdAt))
      .limit(limit),
  ]);

  const feed = [
    ...hire.map((r) => ({
      id: `hire-${r.id}`,
      board: r.listingType === "job" ? "hire_job" : "hire_rental",
      title: r.title,
      place: r.place,
      createdAt: r.createdAt,
      href: `/workers?tab=${r.listingType === "job" ? "job" : "rental"}&ad=${r.id}`,
    })),
    ...equipment.map((r) => ({
      id: `equipment-${r.id}`,
      board: "equipment",
      title: r.title,
      place: r.place,
      createdAt: r.createdAt,
      href: `/equipment?ad=${r.id}`,
    })),
    ...produce.map((r) => ({
      id: `produce-${r.id}`,
      board: "produce",
      title: r.title,
      place: r.place,
      createdAt: r.createdAt,
      href: `/marketplace?ad=${r.id}`,
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit);

  return res.json(feed);
});

export default router;
