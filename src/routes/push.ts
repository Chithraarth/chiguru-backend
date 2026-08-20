import { Router } from "express";
import { db } from "../db";
import { pushDevicesTable, planTasksTable, farmProfileTable } from "../db/schema";
import { eq, and, ne, isNull, or } from "drizzle-orm";
import { effectiveOwnerId } from "../middlewares/firebaseAuth";

const router = Router();

// Same estate-scoping convention as farm.ts / year-plan.ts.
async function activeEstateId(
  req: Parameters<typeof effectiveOwnerId>[0],
): Promise<number | null> {
  const ownerId = effectiveOwnerId(req) ?? undefined;
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

// Validate an IANA timezone name; Intl throws on unknown zones.
function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Supported notification languages; anything else falls back to English.
const SUPPORTED_LANGS = new Set(["en", "hi", "kn", "ta", "te", "ml", "mr"]);
function isValidLang(lang: unknown): lang is string {
  return typeof lang === "string" && SUPPORTED_LANGS.has(lang);
}

// Register (or refresh) a device's Expo push token. Idempotent on the token,
// so re-registering on every app start never duplicates rows.
router.post("/push/register", async (req, res) => {
  const eid = await activeEstateId(req);
  const { deviceId, expoPushToken, midmonth, lang, timezone } = (req.body ?? {}) as {
    deviceId?: string;
    expoPushToken?: string;
    midmonth?: boolean;
    lang?: string;
    timezone?: string;
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
      ...(isValidLang(lang) ? { lang } : {}),
      ...(isValidTimezone(timezone) ? { timezone } : {}),
    })
    .onConflictDoUpdate({
      target: pushDevicesTable.expoPushToken,
      set: {
        estateId: eid,
        deviceId,
        // Only touch the mid-month preference when the client sent it, so a
        // plain re-register on app start never resets an opt-out.
        ...(typeof midmonth === "boolean" ? { midmonthEnabled: midmonth } : {}),
        // Only touch lang/timezone when the client sent a valid value, so a
        // plain re-register never resets a previously stored preference.
        ...(isValidLang(lang) ? { lang } : {}),
        ...(isValidTimezone(timezone) ? { timezone } : {}),
      },
    });
  res.status(201).json({ ok: true });
});

// Toggle the mid-month nudge (and optionally language) for an already-registered device.
router.patch("/push/settings", async (req, res) => {
  const { expoPushToken, midmonth, lang } = (req.body ?? {}) as {
    expoPushToken?: string;
    midmonth?: boolean;
    lang?: string;
  };
  if (!expoPushToken || (typeof midmonth !== "boolean" && !isValidLang(lang))) {
    res.status(400).json({ message: "expoPushToken and (midmonth or lang) are required" });
    return;
  }
  await db
    .update(pushDevicesTable)
    .set({
      ...(typeof midmonth === "boolean" ? { midmonthEnabled: midmonth } : {}),
      ...(isValidLang(lang) ? { lang } : {}),
    })
    .where(eq(pushDevicesTable.expoPushToken, expoPushToken));
  res.status(204).end();
});

// Delivery status for this device: when the last plan reminder was actually
// sent to it. Lets Settings show "Last reminder sent: <date>". Scoped by
// estateId (consistent with the rest of this file) so a caller cannot probe
// the status of a device belonging to a different estate.
router.get("/push/status", async (req, res) => {
  const eid = await activeEstateId(req);
  const deviceId = req.query.deviceId;
  if (typeof deviceId !== "string" || !deviceId) {
    res.status(400).json({ message: "deviceId is required" });
    return;
  }
  const whereClause =
    eid != null
      ? and(eq(pushDevicesTable.deviceId, deviceId), eq(pushDevicesTable.estateId, eid))
      : eq(pushDevicesTable.deviceId, deviceId);
  const [row] = await db
    .select({ lastSentAt: pushDevicesTable.lastSentAt, midmonthEnabled: pushDevicesTable.midmonthEnabled })
    .from(pushDevicesTable)
    .where(whereClause)
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

// ── Test notification endpoint ────────────────────────────────────────────────
// Fires an immediate notification to the calling device, bypassing the
// day-of-month and morning-hour guards. Requires the caller's own deviceId
// and verifies it belongs to the active estate, so only an opted-in device
// can trigger a test for itself.
router.post("/push/test", async (req, res) => {
  const eid = await activeEstateId(req);
  const { deviceId } = (req.body ?? {}) as { deviceId?: string };

  if (!deviceId) {
    res.status(400).json({ message: "deviceId is required" });
    return;
  }

  // Scope the lookup to both deviceId AND estate so a caller cannot trigger
  // notifications for a device belonging to a different estate.
  const whereClause =
    eid != null
      ? and(eq(pushDevicesTable.deviceId, deviceId), eq(pushDevicesTable.estateId, eid))
      : eq(pushDevicesTable.deviceId, deviceId);

  const [device] = await db.select().from(pushDevicesTable).where(whereClause).limit(1);
  if (!device) {
    res.status(404).json({ message: "not registered" });
    return;
  }

  const text = pushText(PUSH_TEXT, device.lang);
  const invalid = await sendExpoPush([device.expoPushToken], text.title, text.body.replace("{n}", "3"));
  if (invalid.has(device.expoPushToken)) {
    await db.delete(pushDevicesTable).where(eq(pushDevicesTable.id, device.id));
    res.status(410).json({ message: "subscription expired, please re-enable notifications" });
    return;
  }
  res.json({ ok: true });
});

// ── Monthly plan-task reminder sweep ─────────────────────────────────────────

const MORNING_START_HOUR = 7;
const MORNING_END_HOUR = 11; // exclusive, local device time

// Local hour (0-23) in the given timezone. Falls back to Asia/Kolkata if the
// stored zone somehow can't be resolved.
function localHour(now: Date, tz: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        hour12: false,
        hourCycle: "h23",
      }).format(now),
    );
  } catch {
    return localHour(now, "Asia/Kolkata");
  }
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Localized notification text ──────────────────────────────────────────────
// {n} is replaced with the number of undone plan tasks this month.
const PUSH_TEXT: Record<string, { title: string; body: string }> = {
  en: { title: "Farm tasks for this month", body: "{n} task(s) in your Year Plan are waiting this month. Tap to see them." },
  hi: { title: "इस महीने के खेत के काम", body: "आपकी वार्षिक योजना में इस महीने {n} काम बाकी हैं। देखने के लिए टैप करें।" },
  kn: { title: "ಈ ತಿಂಗಳ ಕೃಷಿ ಕೆಲಸಗಳು", body: "ನಿಮ್ಮ ವಾರ್ಷಿಕ ಯೋಜನೆಯಲ್ಲಿ ಈ ತಿಂಗಳು {n} ಕೆಲಸ ಬಾಕಿ ಇದೆ. ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ." },
  ta: { title: "இந்த மாத பண்ணை வேலைகள்", body: "உங்கள் ஆண்டு திட்டத்தில் இந்த மாதம் {n} வேலை(கள்) உள்ளன. பார்க்க தட்டவும்." },
  te: { title: "ఈ నెల వ్యవసాయ పనులు", body: "మీ వార్షిక ప్రణాళికలో ఈ నెల {n} పని(లు) మిగిలి ఉన్నాయి. చూడటానికి నొక్కండి." },
  ml: { title: "ഈ മാസത്തെ കൃഷിപ്പണികൾ", body: "നിങ്ങളുടെ വാർഷിക പദ്ധതിയിൽ ഈ മാസം {n} ജോലി(കൾ) ബാക്കിയുണ്ട്. കാണാൻ ടാപ്പ് ചെയ്യുക." },
  mr: { title: "या महिन्याची शेतीची कामे", body: "तुमच्या वार्षिक नियोजनात या महिन्यात {n} काम(े) बाकी आहेत. पाहण्यासाठी टॅप करा." },
};

// Mid-month nudge text: phrased as "still waiting" since the farmer already
// got the month-start reminder.
const MIDMONTH_PUSH_TEXT: Record<string, { title: string; body: string }> = {
  en: { title: "Farm tasks still pending", body: "{n} task(s) in your Year Plan are still undone this month. Tap to see them." },
  hi: { title: "खेत के काम अभी बाकी हैं", body: "आपकी वार्षिक योजना में इस महीने अभी भी {n} काम बाकी हैं। देखने के लिए टैप करें।" },
  kn: { title: "ಕೃಷಿ ಕೆಲಸಗಳು ಇನ್ನೂ ಬಾಕಿ ಇವೆ", body: "ನಿಮ್ಮ ವಾರ್ಷಿಕ ಯೋಜನೆಯಲ್ಲಿ ಈ ತಿಂಗಳು ಇನ್ನೂ {n} ಕೆಲಸ ಬಾಕಿ ಇದೆ. ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ." },
  ta: { title: "பண்ணை வேலைகள் இன்னும் நிலுவையில்", body: "உங்கள் ஆண்டு திட்டத்தில் இந்த மாதம் இன்னும் {n} வேலை(கள்) முடிக்கப்படவில்லை. பார்க்க தட்டவும்." },
  te: { title: "వ్యవసాయ పనులు ఇంకా పెండింగ్‌లో ఉన్నాయి", body: "మీ వార్షిక ప్రణాళికలో ఈ నెల ఇంకా {n} పని(లు) పూర్తికాలేదు. చూడటానికి నొక్కండి." },
  ml: { title: "കൃഷിപ്പണികൾ ഇപ്പോഴും ബാക്കി", body: "നിങ്ങളുടെ വാർഷിക പദ്ധതിയിൽ ഈ മാസം ഇപ്പോഴും {n} ജോലി(കൾ) ബാക്കിയുണ്ട്. കാണാൻ ടാപ്പ് ചെയ്യുക." },
  mr: { title: "शेतीची कामे अजून बाकी आहेत", body: "तुमच्या वार्षिक नियोजनात या महिन्यात अजूनही {n} काम(े) बाकी आहेत. पाहण्यासाठी टॅप करा." },
};

// Picks the text for a device's stored language, falling back to English
// when unset (null = "use English", per the schema column comment) or unknown.
function pushText(
  dict: Record<string, { title: string; body: string }>,
  lang: string | null,
): { title: string; body: string } {
  return (lang && dict[lang]) || dict.en;
}

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
 * month, but only during that device's own local morning (7-10:59 AM in its
 * stored timezone, defaulting to Asia/Kolkata). Marker columns make each
 * trigger once-per-month idempotent no matter how often the sweep runs.
 */
export async function planPushSweep(): Promise<void> {
  try {
    const now = new Date();
    const day = now.getUTCDate();
    const trigger: "start" | "mid" | null = day <= 5 ? "start" : day >= 15 && day <= 19 ? "mid" : null;
    if (!trigger) return;

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

    const dict = trigger === "start" ? PUSH_TEXT : MIDMONTH_PUSH_TEXT;
    for (const device of devices) {
      if (device.estateId == null) continue;

      // Only send during this device's own local morning; the next hourly
      // sweep picks it up again (the marker is set only after sending).
      const hour = localHour(now, device.timezone || "Asia/Kolkata");
      if (hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) continue;

      const n = await dueCount(device.estateId);
      if (n === 0) continue;

      const text = pushText(dict, device.lang);
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
