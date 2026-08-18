import { eq } from "drizzle-orm";
import { db } from "../db";
import { appSettingsTable } from "../db/schema";
import { isSubscriptionActive as isRealSubscriptionActive } from "../services/entitlement.service";

export interface Plan {
  id: string;
  name: string;
  price: number;
  /** Billing cadence for this option. */
  billing: "yearly" | "monthly";
  tagline: string;
  /** Whether this plan unlocks selling (Farmers Market + Nursery/Supplies shops + listings + Agri Doctor provider). Every paid plan now includes this. */
  sells: boolean;
  /** Whether this plan includes the paired manager-device feature. */
  managerDevices: boolean;
  /** How many months the plan lasts once subscribed. */
  durationMonths: number;
}

// One simple, honest plan (plus a 30-day free trial of full features):
//   • Farmer — runs the WHOLE farm and unlocks EVERYTHING: attendance, work
//     updates, expenses, harvest, profit & loss, Agri Doctor consults AND selling
//     (Farmers Market produce, nursery/supplies shops, equipment listings).
//     ₹399/month per farm, with an optional auto-pay that renews monthly.
// Standalone monthly add-ons (not bundled in the plan) are sold separately:
// the manager device (₹199/month) and the "Zamindar" estate add-on (₹299/month
// per extra estate).
export const PLANS: Plan[] = [
  { id: "farmer_monthly", name: "Farmer", price: 399, billing: "monthly", tagline: "Everything to run and grow your farm — attendance, work updates, expenses, harvest, profit & loss, Agri Doctor consults, and selling on Chiguru.", sells: true, managerDevices: false, durationMonths: 1 },
];

// Manager device is a STANDALONE add-on — it is not bundled in any plan. Anyone
// (subscribed or in-trial) can add it for ADDON_DEVICE_PRICE per month.
export const MANAGER_DEVICE_ADDON_MONTHS = 1;

// "Zamindar" estate add-on — a STANDALONE monthly add-on. Each purchase raises
// the estate allowance by one (base allowance is 1 free estate). Priced at
// ESTATE_ADDON_PRICE per extra estate per month; with auto-pay on it simply
// keeps renewing, so the unlocked estate stays available.
export const ESTATE_ADDON_PRICE = 299;
export const BASE_ESTATE_ALLOWANCE = 1;

// ── Free trial, keyed to each farm's trialStartDate (≈ join date) ─────────────
// Every new user gets a 30-day free trial of ALL features (core farm management,
// Agri Doctor consults, and selling). Afterwards an active plan is required.
export const TRIAL_DAYS = 30;
export const SELLER_TRIAL_DAYS = TRIAL_DAYS;

// "Manager device" add-on. The manager device is NOT bundled in any plan — it is a
// standalone monthly add-on at this per-month price. It lets a manager/writer
// mark attendance and upload daily work from their own phone.
export const ADDON_DEVICE_PRICE = 199;
export const MAX_ADDON_DEVICES = 45;
// Bluetooth mini camera — a premium hands-free field-recording accessory that
// clips on and pairs with a manager device. One-time hardware price (INR).
export const CAMERA_ACCESSORY_PRICE = 1499;

export interface TrialInfo {
  trialEnd: Date;
  sellerTrialEnd: Date;
  trialActive: boolean;
  sellerTrialActive: boolean;
  trialDaysLeft: number;
  sellerTrialDaysLeft: number;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function daysLeft(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

export function getTrial(trialStartDate: Date, now: Date = new Date()): TrialInfo {
  const trialEnd = addDays(trialStartDate, TRIAL_DAYS);
  const sellerTrialEnd = addDays(trialStartDate, SELLER_TRIAL_DAYS);
  return {
    trialEnd,
    sellerTrialEnd,
    trialActive: now < trialEnd,
    sellerTrialActive: now < sellerTrialEnd,
    trialDaysLeft: daysLeft(trialEnd, now),
    sellerTrialDaysLeft: daysLeft(sellerTrialEnd, now),
  };
}

export function planById(id: string | null | undefined): Plan | undefined {
  if (!id) return undefined;
  let key = String(id).trim().toLowerCase();
  // Legacy id from the old yearly pricing — existing subscribers keep resolving
  // to the (now monthly) Farmer plan.
  if (key === "farmer_yearly") key = "farmer_monthly";
  return PLANS.find((p) => p.id === key || p.name.toLowerCase() === key);
}

// Roll an expiry forward month-by-month until it is in the future (capped so a
// bad date can't spin). Returns null when no renewal is needed.
function rollForwardMonthly(expiry: Date, now: Date, stepMonths: number): Date | null {
  if (expiry > now) return null;
  const next = new Date(expiry);
  for (let i = 0; i < 240 && next <= now; i++) {
    next.setMonth(next.getMonth() + stepMonths);
  }
  return next > now ? next : null;
}

export async function getAppSettingsRow(ownerId: number) {
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.ownerId, ownerId)).limit(1);
  const row = rows.length > 0 ? rows[0] : (await db.insert(appSettingsTable).values({ ownerId }).returning())[0];

  // Auto-pay: when the owner turned auto-pay on, an expired monthly charge
  // renews automatically — we roll the expiry forward instead of lapsing.
  // (No real payment gateway yet; this mirrors what a mandate would do.)
  const now = new Date();
  const updates: Partial<typeof row> = {};
  if (row.subscriptionAutoPay && row.subscriptionPlan && row.subscriptionExpiresAt) {
    const plan = planById(row.subscriptionPlan);
    const renewed = rollForwardMonthly(
      new Date(row.subscriptionExpiresAt as unknown as string),
      now,
      plan?.durationMonths ?? 1,
    );
    if (renewed) updates.subscriptionExpiresAt = renewed;
  }
  if (row.managerDeviceAutoPay && row.managerDeviceAddonExpiresAt) {
    const renewed = rollForwardMonthly(
      new Date(row.managerDeviceAddonExpiresAt as unknown as string),
      now,
      MANAGER_DEVICE_ADDON_MONTHS,
    );
    if (renewed) updates.managerDeviceAddonExpiresAt = renewed;
  }
  if (Object.keys(updates).length > 0) {
    const [updated] = await db
      .update(appSettingsTable)
      .set(updates)
      .where(eq(appSettingsTable.id, row.id))
      .returning();
    return updated;
  }
  return row;
}

type SettingsRow = Awaited<ReturnType<typeof getAppSettingsRow>>;

// A paid subscription counts only while it has not expired.
export function isSubscriptionActive(s: SettingsRow, now: Date = new Date()): boolean {
  if (!s.subscriptionPlan) return false;
  if (!s.subscriptionExpiresAt) return false;
  return now < new Date(s.subscriptionExpiresAt as unknown as string);
}

// Using Agri Doctor (consulting) is a regular feature — available during the
// 30-day trial, and afterwards with any active Basic/Premium/Pro plan. Checks
// the real subscriptionsTable (via entitlement.service.ts) rather than only
// this file's own legacy app_settings.subscriptionPlan, which nothing writes
// to anymore since the app moved off the old single-tier Farmer plan.
export async function canUseAgriDoctor(ownerId: number): Promise<boolean> {
  const s = await getAppSettingsRow(ownerId);
  const { trialActive } = getTrial(new Date(s.trialStartDate as unknown as string));
  return trialActive || isSubscriptionActive(s) || (await isRealSubscriptionActive(ownerId));
}

// Selling (Farmers Market produce, opening a Nursery/Supplies shop and listing
// equipment) is now part of every paid plan. Available during the 30-day
// trial, and afterwards with any active Basic/Premium/Pro plan — see the
// canUseAgriDoctor comment above for why both subscription sources are checked.
export async function canSell(ownerId: number): Promise<boolean> {
  const s = await getAppSettingsRow(ownerId);
  const { trialActive } = getTrial(new Date(s.trialStartDate as unknown as string));
  return trialActive || isSubscriptionActive(s) || (await isRealSubscriptionActive(ownerId));
}

// The "Zamindar" estate add-on permanently raises the estate allowance by one
// per purchase. The base allowance is one free estate, so the maximum number of
// estates a user may create is BASE_ESTATE_ALLOWANCE + extraEstates.
export async function getMaxEstates(ownerId: number): Promise<number> {
  const s = await getAppSettingsRow(ownerId);
  return BASE_ESTATE_ALLOWANCE + (s.extraEstates ?? 0);
}

// The manager-device add-on counts only while it has not expired.
export function isManagerDeviceAddonActive(s: SettingsRow, now: Date = new Date()): boolean {
  if (!s.managerDeviceAddonExpiresAt) return false;
  return now < new Date(s.managerDeviceAddonExpiresAt as unknown as string);
}

// Paired manager devices (a manager marks attendance / uploads daily work from
// their own phone) are a STANDALONE add-on — not bundled in any plan. Available
// during the regular 30-day trial, and afterwards only with an active
// manager-device add-on.
export async function canUseManagerDevices(ownerId: number): Promise<boolean> {
  const s = await getAppSettingsRow(ownerId);
  const { trialActive } = getTrial(new Date(s.trialStartDate as unknown as string));
  if (trialActive) return true;
  return isManagerDeviceAddonActive(s);
}
