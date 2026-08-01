import type { NextFunction, Request, Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db, subscriptionsTable } from "../db";
import { effectiveOwnerId } from "./firebaseAuth";

/** True only for a real, currently-active paid subscription — no free trial. */
export async function hasActiveSubscription(ownerId: number): Promise<boolean> {
  const [sub] = await db
    .select({ status: subscriptionsTable.status })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.ownerId, ownerId))
    .orderBy(desc(subscriptionsTable.id))
    .limit(1);
  return sub?.status === "active";
}

/**
 * Route guard for anything that requires a paid plan: farm data entry
 * (attendance, Farm Accounts), the AI features, Agri Doctor consults, and
 * posting a marketplace/nursery/equipment listing. Works for both a
 * signed-in Owner and a Manager acting on that Owner's behalf — the
 * Owner's own subscription is what's checked either way.
 */
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  const ownerId = effectiveOwnerId(req);
  if (!ownerId) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  if (!(await hasActiveSubscription(ownerId))) {
    res.status(403).json({
      message: "An active subscription is required for this feature.",
      code: "SUBSCRIPTION_REQUIRED",
    });
    return;
  }
  next();
}
