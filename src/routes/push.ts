import { Router } from "express";
import { db } from "../db";
import { pushDevicesTable, planTasksTable, farmProfileTable } from "../db/schema";
import { eq, and, ne, isNull, or } from "drizzle-orm";

const router = Router();

// Same estate-scoping convention as farm.ts / year-plan.ts.
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

// Register (or refresh) a device's Expo push token. Idempotent on the token,
// so re-registering on every app start never duplicates rows.
router.post("/push/register", async (req, res) => {
  const eid = await activeEstateId(req);
  const { deviceId, expoPushToken, midmonth } = (req.body ?? {}) as {
    deviceId?: string;
    expoPushToken?: string;
    midmonth?: boolean;
  };
  if (!deviceId || !expoPushToken) {
    res.status(400).json({ message: "deviceId and expoPushToken are required" });
    return;
  }
  await db
    .insert(pushDevicesTable)
    .values({
      estateId: eid,
      deviceId,
      expoPushToken,
      ...(typeof midmonth === "boolean" ? { midmonthEnabled: midmonth } : {}),
    })
    .onConflictDoUpdate({
      target: pushDevicesTable.expoPushToken,
      set: {
        estateId: eid,
        deviceId,
        // Only touch the mid-month preference when the client sent it, so a
        // plain re-register on app start never resets an opt-out.
        ...(typeof midmonth === "boolean" ? { midmonthEnabled: midmonth } : {}),
      },
    });
  res.status(201).json({ ok: true });
});

// Toggle the mid-month nudge for an already-registered device.
router.patch("/push/settings", async (req, res) => {
  const { expoPushToken, midmonth } = (req.body ?? {}) as { expoPushToken?: string; midmonth?: boolean };
  if (!expoPushToken || typeof midmonth !== "boolean") {
    res.status(400).json({ message: "expoPushToken and midmonth are required" });
    return;
  }
  await db.update(pushDevicesTable).set({ midmonthEnabled: midmonth }).where(eq(pushDevicesTable.expoPushToken, expoPushToken));
  res.status(204).end();
});

// Delivery status for this device: when the last plan reminder was actually
// sent to it. Lets Settings show "Last reminder sent: <date>".
router.get("/push/status", async (req, res) => {
  const deviceId = req.query.deviceId;
  if (typeof deviceId !== "string" || !deviceId) {
    res.status(400).json({ message: "deviceId is required" });
    return;
  }
  const [row] = await db
    .select({ lastSentAt: pushDevicesTable.lastSentAt, midmonthEnabled: pushDevicesTable.midmonthEnabled })
    .from(pushDevicesTable)
    .where(eq(pushDevicesTable.deviceId, deviceId))
    .limit(1);
  if (!row) {
    res.status(404).json({ message: "not registered" });
    return;
  }
  res.json({ lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null, midmonthEnabled: row.midmonthEnabled });
});

// Turn notifications off. Idempotent: deleting an already-removed token still answers 204.
router.delete("/push/register", async (req, res) => {
  const { expoPushToken } = (req.body ?? {}) as { expoPushToken?: string };
  if (!expoPushToken) {
    res.status(400).json({ message: "expoPushToken is required" });
    return;
  }
  await db.delete(pushDevicesTable).where(eq(pushDevicesTable.expoPushToken, expoPushToken));
  res.status(204).end();
});

// ── Monthly plan-task reminder sweep ─────────────────────────────────────────

const MORNING_START_HOUR = 7;
const MORNING_END_HOUR = 11; // exclusive, IST

function istHour(): number {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const PUSH_TEXT = { title: "Farm tasks for this month", body: "{n} task(s) in your Year Plan are waiting this month. Tap to see them." };
const MIDMONTH_PUSH_TEXT = { title: "Farm tasks still pending", body: "{n} task(s) in your Year Plan are still undone this month. Tap to see them." };

async function sendExpoPush(tokens: string[], title: string, body: string): Promise<Set<string>> {
  if (tokens.length === 0) return new Set();
  const invalid = new Set<string>();
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body, data: { type: "plan-reminder" } }))),
    });
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    (json.data ?? []).forEach((r, i) => {
      if (r.status === "error" && r.details?.error === "DeviceNotRegistered") invalid.add(tokens[i]);
    });
  } catch (err) {
    console.error("[push] Expo send failed:", err instanceof Error ? err.message : err);
  }
  return invalid;
}

/**
 * Twice a month - month-start (days 1-5) and mid-month (days 15-19) - notify
 * every registered device whose estate still has undone plan tasks this
 * month, but only during India's local morning (7-10:59 AM IST). Marker
 * columns make each trigger once-per-month idempotent no matter how often
 * the sweep runs.
 */
export async function planPushSweep(): Promise<void> {
  try {
    const now = new Date();
    const day = now.getUTCDate();
    const trigger: "start" | "mid" | null = day <= 5 ? "start" : day >= 15 && day <= 19 ? "mid" : null;
    if (!trigger) return;
    const hour = istHour();
    if (hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return;

    const month = currentMonthStr();
    const markerCol = trigger === "start" ? pushDevicesTable.lastNotifiedMonth : pushDevicesTable.lastMidmonthNotifiedMonth;

    const devices = await db
      .select()
      .from(pushDevicesTable)
      .where(
        trigger === "mid"
          ? and(or(isNull(markerCol), ne(markerCol, month)), eq(pushDevicesTable.midmonthEnabled, true))
          : or(isNull(markerCol), ne(markerCol, month)),
      );
    if (devices.length === 0) return;

    const dueByEstate = new Map<number, number>();
    async function dueCount(estateId: number): Promise<number> {
      if (dueByEstate.has(estateId)) return dueByEstate.get(estateId)!;
      const rows = await db
        .select({ id: planTasksTable.id })
        .from(planTasksTable)
        .where(and(eq(planTasksTable.estateId, estateId), eq(planTasksTable.month, month), eq(planTasksTable.done, false)));
      dueByEstate.set(estateId, rows.length);
      return rows.length;
    }

    const text = trigger === "start" ? PUSH_TEXT : MIDMONTH_PUSH_TEXT;
    for (const device of devices) {
      if (device.estateId == null) continue;
      const n = await dueCount(device.estateId);
      if (n === 0) continue;

      const invalid = await sendExpoPush([device.expoPushToken], text.title, text.body.replace("{n}", String(n)));
      if (invalid.has(device.expoPushToken)) {
        await db.delete(pushDevicesTable).where(eq(pushDevicesTable.id, device.id));
        continue;
      }
      await db
        .update(pushDevicesTable)
        .set(
          trigger === "start"
            ? { lastNotifiedMonth: month, lastSentAt: new Date() }
            : { lastMidmonthNotifiedMonth: month, lastSentAt: new Date() },
        )
        .where(eq(pushDevicesTable.id, device.id));
    }
  } catch (err) {
    console.error("[push] planPushSweep failed:", err);
  }
}

// Hourly sweep (guarded to the trigger windows + once-per-month per device),
// plus one shortly after boot so a redeploy inside a window still fires.
setInterval(() => void planPushSweep(), 60 * 60 * 1000).unref();
setTimeout(() => void planPushSweep(), 30 * 1000).unref();

export default router;
