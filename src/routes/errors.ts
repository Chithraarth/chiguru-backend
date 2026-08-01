import { Router, type IRouter } from "express";
import { db, errorLogsTable } from "../db";

const router: IRouter = Router();

const cap = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

// --- Abuse protection (in-memory) -----------------------------------------
// The endpoint is unauthenticated (the app has no auth), so guard against a
// buggy client or malicious caller flooding the error_logs table.

// Coarse global rate limit: at most MAX_PER_WINDOW inserts per window.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
let windowStart = Date.now();
let windowCount = 0;

// Server-side dedupe: collapse identical errors seen within DEDUPE_MS.
const DEDUPE_MS = 30_000;
const recent = new Map<string, number>();

function allow(key: string): boolean {
  const now = Date.now();

  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_WINDOW) return false;

  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return false;

  // Opportunistically prune the dedupe map so it can't grow unbounded.
  if (recent.size > 500) {
    for (const [k, t] of recent) {
      if (now - t > DEDUPE_MS) recent.delete(k);
    }
  }

  recent.set(key, now);
  windowCount += 1;
  return true;
}

// Receives client-side error reports so glitches surface to the owner
// automatically, without a farmer having to call for support.
router.post("/errors", async (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;
    const message = cap(b.message, 2000);
    if (!message) return res.status(400).json({ error: "message is required" });

    const source = cap(b.source, 50);
    if (!allow(`${source ?? ""}|${message}`)) {
      // Silently accept-and-drop so the client never retries or errors.
      return res.status(204).end();
    }

    await db.insert(errorLogsTable).values({
      message,
      stack: cap(b.stack, 8000),
      source,
      url: cap(b.url, 1000),
      userAgent: cap(b.userAgent, 500),
      appVersion: cap(b.appVersion, 100),
    });
    return res.status(204).end();
  } catch {
    // The error reporter must never fail loudly and create more errors.
    return res.status(204).end();
  }
});

export default router;
