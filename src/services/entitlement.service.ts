import { eq, and, desc, sql } from "drizzle-orm";
import { db, subscriptionsTable, subscriptionPlansTable, managersTable, ownersTable, type Subscription, type SubscriptionPlan } from "../db";

const ACTIVE_LIKE_STATUSES = ["ACTIVE", "GRACE_PERIOD"];

/**
 * Centralized entitlement checks derived from an Owner's subscription. This
 * is the ONLY place that decides what an Owner's plan entitles them to —
 * routes/controllers call these functions rather than re-deriving the logic
 * themselves, and the React frontend never gets to decide this on its own.
 */
export async function getCurrentSubscription(ownerId: number): Promise<Subscription | null> {
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.ownerId, ownerId))
    .orderBy(desc(subscriptionsTable.id))
    .limit(1);
  return sub ?? null;
}

export async function getPlan(ownerId: number): Promise<SubscriptionPlan | null> {
  const sub = await getCurrentSubscription(ownerId);
  if (!sub) return null;
  const [plan] = await db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, sub.planId));
  return plan ?? null;
}

/** True for ACTIVE or within a payment-lapse GRACE_PERIOD — false for every other status. */
export function isSubStatusActiveLike(status: string): boolean {
  return ACTIVE_LIKE_STATUSES.includes(status);
}

export async function isSubscriptionActive(ownerId: number): Promise<boolean> {
  const sub = await getCurrentSubscription(ownerId);
  return !!sub && isSubStatusActiveLike(sub.status);
}

export async function getManagerLimit(ownerId: number): Promise<number> {
  if (!(await isSubscriptionActive(ownerId))) return 0;
  const plan = await getPlan(ownerId);
  const [owner] = await db.select({ extraManagerSeats: ownersTable.extraManagerSeats }).from(ownersTable).where(eq(ownersTable.id, ownerId));
  return (plan?.managerLimit ?? 0) + (owner?.extraManagerSeats ?? 0);
}

export async function getManagersUsed(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(managersTable)
    .where(and(eq(managersTable.ownerId, ownerId), eq(managersTable.status, "active")));
  return row?.count ?? 0;
}

export async function getRemainingManagerSeats(ownerId: number): Promise<number> {
  const [limit, used] = await Promise.all([getManagerLimit(ownerId), getManagersUsed(ownerId)]);
  return Math.max(0, limit - used);
}

export async function canCreateManager(ownerId: number): Promise<boolean> {
  const [limit, used] = await Promise.all([getManagerLimit(ownerId), getManagersUsed(ownerId)]);
  return used < limit;
}

// ── Estates ───────────────────────────────────────────────────────────────
// Not part of the manager-seat spec, but the same category of check and it
// already existed inline in routes/farm.ts against the old plan model — kept
// here instead of duplicated in the controller. No plan differentiates by
// estate count in this phase: one free estate, unlimited once any plan is active.
const FREE_ESTATES = 1;

export async function getMaxEstates(ownerId: number): Promise<number> {
  return (await isSubscriptionActive(ownerId)) ? Infinity : FREE_ESTATES;
}
