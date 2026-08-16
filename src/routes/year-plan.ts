import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { db } from "../db";
import { planTasksTable, farmProfileTable, cropsTable } from "../db/schema";
import { eq, and, asc } from "drizzle-orm";
import { openai } from "../integrations-openai-ai-server";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";
import { effectiveOwnerId } from "../middlewares/firebaseAuth";
import { ensureAICredit, chargeAISafe } from "../lib/wallet";

const router = Router();

/** Wallet pre-check for a given AI feature — blocks with 402 if the wallet can't cover it. */
function requireWalletCredit(feature: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ownerId = effectiveOwnerId(req)!; // requireActiveSubscription already ran and guarantees this
    if (await ensureAICredit(ownerId, res, feature)) next();
  };
}

// Same estate-scoping convention as farm.ts: an authenticated request's estate
// header must belong to that Owner; unauthenticated/legacy calls fall back to
// the oldest estate when the header is missing.
async function activeEstateId(
  req: { header(name: string): string | undefined; owner?: { id: number }; manager?: { ownerId: number } },
): Promise<number | null> {
  const ownerId = req.owner?.id ?? req.manager?.ownerId;
  const h = req.header("X-Estate-Id");
  const headerEid = h && !isNaN(Number(h)) ? Number(h) : null;

  if (headerEid != null) {
    if (!ownerId) return headerEid;
    const [row] = await db
      .select({ id: farmProfileTable.id })
      .from(farmProfileTable)
      .where(and(eq(farmProfileTable.id, headerEid), eq(farmProfileTable.ownerId, ownerId)))
      .limit(1);
    if (row) return row.id;
  }

  const rows = await db
    .select({ id: farmProfileTable.id })
    .from(farmProfileTable)
    .orderBy(farmProfileTable.id)
    .limit(1);
  return rows[0]?.id ?? null;
}

const CATEGORIES = ["fertilizer", "spray", "irrigation", "pruning", "harvest", "other"];

function isValidMonth(m: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(m)) return false;
  const mo = Number(m.slice(5));
  return mo >= 1 && mo <= 12;
}

function isValidDay(day: number, month: string): boolean {
  if (!Number.isInteger(day)) return false;
  const [y, mo] = month.split("-").map(Number);
  return day >= 1 && day <= new Date(y, mo, 0).getDate();
}

router.get("/plan-tasks", async (req, res) => {
  const eid = await activeEstateId(req);
  const rows = await db
    .select()
    .from(planTasksTable)
    .where(eid != null ? eq(planTasksTable.estateId, eid) : undefined)
    .orderBy(asc(planTasksTable.month), asc(planTasksTable.id));
  res.json(rows);
});

router.post("/plan-tasks", async (req, res) => {
  const eid = await activeEstateId(req);
  const { month, title, details, category, cropId, clientId, day } = (req.body ?? {}) as {
    month?: string; title?: string; details?: string; category?: string; cropId?: number | null; clientId?: string; day?: number | null;
  };
  if (!month || !isValidMonth(month) || !title?.trim()) {
    res.status(400).json({ message: "month (YYYY-MM) and title are required" });
    return;
  }
  if (day != null && !isValidDay(day, month)) {
    res.status(400).json({ message: "Invalid day for this month" });
    return;
  }
  if (clientId) {
    const [existing] = await db.select().from(planTasksTable)
      .where(eq(planTasksTable.clientId, clientId)).limit(1);
    if (existing) { res.status(200).json(existing); return; }
  }
  if (cropId != null) {
    const [c] = await db.select({ id: cropsTable.id }).from(cropsTable)
      .where(eid != null ? and(eq(cropsTable.id, cropId), eq(cropsTable.estateId, eid)) : eq(cropsTable.id, cropId))
      .limit(1);
    if (!c) { res.status(400).json({ message: "Invalid crop" }); return; }
  }
  const [row] = await db.insert(planTasksTable).values({
    estateId: eid,
    cropId: cropId ?? null,
    month,
    title: title.trim(),
    details: details?.trim() || null,
    category: CATEGORIES.includes(category ?? "") ? category! : "other",
    source: "manual",
    clientId: clientId || null,
    day: day ?? null,
  }).returning();
  res.status(201).json(row);
});

router.patch("/plan-tasks/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  const { title, details, category, month, done, cropId, day } = (req.body ?? {}) as {
    title?: string; details?: string | null; category?: string; month?: string; done?: boolean; cropId?: number | null; day?: number | null;
  };
  const patch: Record<string, unknown> = {};
  if (title !== undefined) {
    if (!title.trim()) { res.status(400).json({ message: "title cannot be empty" }); return; }
    patch.title = title.trim();
  }
  if (details !== undefined) patch.details = details?.trim() || null;
  if (category !== undefined && CATEGORIES.includes(category)) patch.category = category;
  if (month !== undefined) {
    if (!isValidMonth(month)) { res.status(400).json({ message: "month must be YYYY-MM" }); return; }
    patch.month = month;
  }
  if (cropId !== undefined) {
    if (cropId != null) {
      const [c] = await db.select({ id: cropsTable.id }).from(cropsTable)
        .where(eid != null ? and(eq(cropsTable.id, cropId), eq(cropsTable.estateId, eid)) : eq(cropsTable.id, cropId))
        .limit(1);
      if (!c) { res.status(400).json({ message: "Invalid crop" }); return; }
    }
    patch.cropId = cropId;
  }
  if (done !== undefined) patch.done = !!done;
  if (day !== undefined) patch.day = day;
  if (Object.keys(patch).length === 0) { res.status(400).json({ message: "Nothing to update" }); return; }
  if (day != null || (month !== undefined && day === undefined)) {
    const [cur] = await db.select({ month: planTasksTable.month, day: planTasksTable.day }).from(planTasksTable)
      .where(eid != null ? and(eq(planTasksTable.id, id), eq(planTasksTable.estateId, eid)) : eq(planTasksTable.id, id))
      .limit(1);
    if (!cur) { res.status(404).json({ message: "Not found" }); return; }
    const targetMonth = month ?? cur.month;
    const targetDay = day !== undefined ? day : cur.day;
    if (targetDay != null && !isValidDay(targetDay, targetMonth)) {
      res.status(400).json({ message: "Invalid day for this month" });
      return;
    }
  }
  const [row] = await db.update(planTasksTable)
    .set(patch)
    .where(eid != null ? and(eq(planTasksTable.id, id), eq(planTasksTable.estateId, eid)) : eq(planTasksTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ message: "Not found" }); return; }
  res.json(row);
});

router.delete("/plan-tasks/:id", async (req, res) => {
  const eid = await activeEstateId(req);
  const id = Number(req.params.id);
  await db.delete(planTasksTable)
    .where(eid != null ? and(eq(planTasksTable.id, id), eq(planTasksTable.estateId, eid)) : eq(planTasksTable.id, id));
  res.status(204).end();
});

// AI generation: build the next 12 months of tasks from the farm profile + crops.
router.post("/plan-tasks/generate", requireActiveSubscription, requireWalletCredit("year_plan"), async (req, res) => {
  const eid = await activeEstateId(req);
  if (eid == null) { res.status(400).json({ message: "Set up your farm first" }); return; }

  const [profile] = await db.select().from(farmProfileTable).where(eq(farmProfileTable.id, eid));
  const crops = await db.select().from(cropsTable).where(eq(cropsTable.estateId, eid));
  if (!profile) { res.status(400).json({ message: "Set up your farm first" }); return; }
  if (crops.length === 0) { res.status(400).json({ message: "no_crops" }); return; }

  const now = new Date();
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const prompt = `You are an expert Indian agronomist. Create a practical 12-month farm work calendar.

FARM:
Location: ${profile.village ?? ""}, ${profile.district ?? ""}, ${profile.state ?? ""}, ${profile.country}
Total area: ${profile.totalAcres ?? "unknown"} acres | Annual rainfall: ${profile.avgRainfallMm ?? "unknown"}mm | Climate: ${profile.climateZone ?? "unknown"}
Crops: ${crops.map((c) => `id=${c.id} ${c.name}${c.variety ? ` (${c.variety})` : ""} ${c.acres} acres, season: ${c.season}`).join("; ")}

MONTHS (use exactly these YYYY-MM values): ${months.join(", ")}

Rules:
- 2 to 4 tasks per month covering all listed crops across the year (fertilizer schedules with product + dose per acre, sprays, irrigation, pruning/weeding, harvest windows).
- Base fertilizer doses on standard KVK/ICAR package-of-practice recommendations for the crop and region; if unsure of an exact dose, give the safe common range and say "confirm with your local KVK". Never invent a precise dose.
- Consider the local monsoon and season timing for the given state.
- Use simple language a smallholder farmer understands.
- Each task: "cropId" (one of the listed ids, or null for whole-farm tasks), "month" (YYYY-MM from the list), "day" (suggested day of month 1-28 when timing matters, e.g. fertilizer split doses or spray rounds; null when any day works), "title" (max 8 words), "details" (1-3 short sentences with dose/timing), "category" (one of fertilizer, spray, irrigation, pruning, harvest, other).

Respond ONLY with JSON: {"tasks":[{"cropId":1,"month":"2026-08","day":10,"title":"...","details":"...","category":"fertilizer"}, ...]}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      max_completion_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: { tasks?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }
    const cropIds = new Set(crops.map((c) => c.id));
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .filter((t: any) =>
        t && typeof t.title === "string" && t.title.trim() &&
        typeof t.month === "string" && months.includes(t.month))
      .map((t: any) => ({
        estateId: eid,
        cropId: typeof t.cropId === "number" && cropIds.has(t.cropId) ? t.cropId : null,
        month: t.month as string,
        title: String(t.title).slice(0, 120),
        details: t.details ? String(t.details).slice(0, 600) : null,
        category: CATEGORIES.includes(t.category) ? (t.category as string) : "other",
        source: "ai" as const,
        day: typeof t.day === "number" && isValidDay(t.day, t.month) ? t.day : null,
      }));

    if (tasks.length === 0) {
      res.status(502).json({ message: "AI returned no usable plan. Please try again." });
      return;
    }

    const inserted = await db.transaction(async (tx) => {
      await tx.delete(planTasksTable).where(and(
        eq(planTasksTable.estateId, eid),
        eq(planTasksTable.source, "ai"),
        eq(planTasksTable.done, false),
      ));
      return tx.insert(planTasksTable).values(tasks).returning();
    });
    await chargeAISafe(effectiveOwnerId(req)!, "year_plan");
    res.status(201).json(inserted);
  } catch (err) {
    console.error("year plan generation failed:", err);
    res.status(502).json({ message: "AI service error. Please try again." });
  }
});

export default router;
