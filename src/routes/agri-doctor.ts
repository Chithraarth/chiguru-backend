import { Router, type Request } from "express";
import { db } from "../db";
import { agronomistsTable, appSettingsTable, farmProfileTable } from "../db/schema";
import { eq, desc, sql } from "drizzle-orm";
import {
  PLANS,
  TRIAL_DAYS,
  SELLER_TRIAL_DAYS,
  ADDON_DEVICE_PRICE,
  MAX_ADDON_DEVICES,
  CAMERA_ACCESSORY_PRICE,
  ESTATE_ADDON_PRICE,
  BASE_ESTATE_ALLOWANCE,
  planById,
  getTrial,
  isSubscriptionActive,
  isManagerDeviceAddonActive,
  canSell,
  canUseAgriDoctor,
  canUseManagerDevices,
} from "../lib/subscription";
import { requireOwner, effectiveOwnerId, resolveActiveEstateId } from "../middlewares/firebaseAuth";
import { getWalletState, chargeWalletInTx, WalletError } from "../lib/wallet";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// Agri Doctor: a directory of agriculture doctors, nearest to the farm first.
// Farmers contact a doctor directly on their number - there are no in-app
// consultations, billing, earnings or payouts. Doctors' numbers unlock once
// per account for a small wallet fee, and stay unlocked for every doctor,
// including ones who join later.
// ──────────────────────────────────────────────────────────────────────────────

export const DOCTOR_CONTACTS_FEE = 10;

type AgronomistRow = typeof agronomistsTable.$inferSelect;

/** What anyone may see of a doctor; the number only once contacts are unlocked. */
function publicDoctor(d: AgronomistRow, contactsUnlocked: boolean) {
  return {
    id: d.id,
    name: d.name,
    emoji: d.emoji,
    speciality: d.speciality,
    qualification: d.qualification,
    workplace: d.workplace,
    location: d.location,
    languages: d.languages,
    experience: d.experience,
    bio: d.bio,
    rating: d.rating,
    isOnline: d.isOnline,
    createdAt: d.createdAt,
    contactPhone: contactsUnlocked ? d.contactPhone : null,
    contactLocked: !contactsUnlocked && !!d.contactPhone,
  };
}

async function contactsUnlocked(req: Request): Promise<boolean> {
  const ownerId = effectiveOwnerId(req);
  if (!ownerId) return false;
  const [s] = await db
    .select({ at: appSettingsTable.doctorContactsUnlockedAt })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.ownerId, ownerId))
    .limit(1);
  return !!s?.at;
}

/**
 * How close a doctor is to the caller's active farm, from the doctor's free-text
 * location: same taluk > same district > same state > elsewhere.
 */
async function nearnessScorer(req: Request): Promise<(d: AgronomistRow) => number> {
  const eid = await resolveActiveEstateId(req).catch(() => null);
  if (eid == null) return () => 0;
  const [farm] = await db
    .select({ taluk: farmProfileTable.taluk, district: farmProfileTable.district, state: farmProfileTable.state })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.id, eid))
    .limit(1);
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const taluk = norm(farm?.taluk);
  const district = norm(farm?.district);
  const state = norm(farm?.state);
  return (d) => {
    const loc = norm(d.location);
    if (!loc) return 0;
    if (taluk && loc.includes(taluk)) return 3;
    if (district && loc.includes(district)) return 2;
    if (state && loc.includes(state)) return 1;
    return 0;
  };
}

async function getSettings(ownerId: number) {
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.ownerId, ownerId)).limit(1);
  if (rows.length > 0) return rows[0];
  const [row] = await db.insert(appSettingsTable).values({ ownerId }).returning();
  return row;
}

router.get("/agronomists", async (req, res) => {
  const [rows, unlocked, score] = await Promise.all([
    db.select().from(agronomistsTable).where(eq(agronomistsTable.isActive, true)).orderBy(desc(agronomistsTable.rating)),
    contactsUnlocked(req),
    nearnessScorer(req),
  ]);
  const sorted = rows
    .map((d) => ({ d, s: score(d) }))
    .sort((a, b) => b.s - a.s)
    .map(({ d, s }) => ({ ...publicDoctor(d, unlocked), nearby: s >= 2 }));
  return res.json(sorted);
});

router.get("/agronomists/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, id)).limit(1);
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json(publicDoctor(rows[0], await contactsUnlocked(req)));
});

/**
 * One-time unlock of every doctor's contact number for this account, paid
 * from the Chiguru wallet. Idempotent: an already-unlocked account is never
 * charged again. Nothing is charged while no doctor with a number is listed.
 */
router.post("/agronomists/contacts/unlock", requireOwner, async (req, res) => {
  const ownerId = effectiveOwnerId(req)!;
  const settings = await getSettings(ownerId);
  if (settings.doctorContactsUnlockedAt) return res.json({ unlocked: true, charged: 0 });
  const [anyDoctor] = await db
    .select({ id: agronomistsTable.id })
    .from(agronomistsTable)
    .where(eq(agronomistsTable.isActive, true))
    .limit(1);
  if (!anyDoctor) {
    return res.status(409).json({ error: "No doctors are listed yet - nothing to unlock.", code: "NO_DOCTORS" });
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [s] = await tx.select().from(appSettingsTable).where(eq(appSettingsTable.id, settings.id)).for("update");
      if (s?.doctorContactsUnlockedAt) return { charged: 0, balance: (await getWalletState(ownerId)).balance };
      const charge = await chargeWalletInTx(tx, ownerId, DOCTOR_CONTACTS_FEE, "doctor_contacts", "agri_doctor");
      await tx.update(appSettingsTable).set({ doctorContactsUnlockedAt: new Date() }).where(eq(appSettingsTable.id, settings.id));
      return { charged: DOCTOR_CONTACTS_FEE, balance: charge.balance };
    });
    return res.json({ unlocked: true, ...result });
  } catch (err) {
    if (err instanceof WalletError) {
      return res.status(err.status).json({ error: err.message, code: err.code, balance: err.balance, price: err.price });
    }
    throw err;
  }
});

/** A doctor lists themselves so nearby farmers can call them. */
router.post("/agronomists", requireOwner, requireActiveSubscription, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(b.name);
  const speciality = str(b.speciality);
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!speciality) return res.status(400).json({ error: "speciality is required" });
  // Credentials are mandatory - a doctor must prove their agricultural
  // education and experience before being listed.
  const qualification = str(b.qualification);
  const experience = str(b.experience);
  const certificateUrl = str(b.certificateUrl);
  if (!qualification) return res.status(400).json({ error: "Please add your agricultural qualification" });
  if (!experience) return res.status(400).json({ error: "Please add your years of experience" });
  if (!certificateUrl || !certificateUrl.startsWith("data:image/")) {
    return res.status(400).json({ error: "Please upload a photo of your agriculture education certificate" });
  }
  if (certificateUrl.length > 3_500_000) {
    return res.status(400).json({ error: "Certificate image is too large — please use a smaller photo" });
  }
  // Farmers reach doctors by phone, so a number and a location are required.
  const contactPhone = str(b.contactPhone);
  if (!contactPhone || contactPhone.replace(/\D/g, "").length < 10) {
    return res.status(400).json({ error: "Please add a phone number farmers can call" });
  }
  const location = str(b.location);
  if (!location) return res.status(400).json({ error: "Please add your town and district so nearby farmers find you" });
  const [row] = await db
    .insert(agronomistsTable)
    .values({
      name,
      speciality,
      emoji: str(b.emoji) ?? "👨‍🌾",
      qualification,
      certificateUrl,
      workplace: str(b.workplace),
      location,
      languages: str(b.languages),
      experience,
      contactPhone,
      bio: str(b.bio),
    })
    .returning();
  return res.json(publicDoctor(row, true));
});

// ──────────────────────────────────────────────────────────────────────────────
// App settings, wallet & subscription
// ──────────────────────────────────────────────────────────────────────────────

router.get("/app-settings", requireOwner, async (req, res) => {
  const ownerId = effectiveOwnerId(req)!;
  const settings = await getSettings(ownerId);
  const now = new Date();
  const trialStart = new Date(settings.trialStartDate as unknown as string);
  const { trialEnd, sellerTrialEnd, trialActive, sellerTrialActive, trialDaysLeft, sellerTrialDaysLeft } =
    getTrial(trialStart, now);

  // Every new user gets a 30-day free trial of all features. After that, an
  // active Farmer plan is required.
  const subscriptionActive = isSubscriptionActive(settings, now);
  const activePlan = subscriptionActive ? planById(settings.subscriptionPlan) ?? null : null;
  const isSubscribed = subscriptionActive;

  // Estate allowance: base 1 free estate + one per purchased "Zamindar" add-on.
  const [estateCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, ownerId));
  const estateCount = estateCountRow?.count ?? 0;
  const extraEstates = settings.extraEstates ?? 0;
  const maxEstates = BASE_ESTATE_ALLOWANCE + extraEstates;

  return res.json({
    ...settings,
    trialDays: TRIAL_DAYS,
    sellerTrialDays: SELLER_TRIAL_DAYS,
    addOnDevicePrice: ADDON_DEVICE_PRICE,
    maxAddOnDevices: MAX_ADDON_DEVICES,
    cameraAccessoryPrice: CAMERA_ACCESSORY_PRICE,
    estateAddonPrice: ESTATE_ADDON_PRICE,
    trialEnd: trialEnd.toISOString(),
    sellerTrialEnd: sellerTrialEnd.toISOString(),
    trialActive,
    sellerTrialActive,
    trialDaysLeft,
    sellerTrialDaysLeft,
    plans: PLANS,
    activePlan,
    subscriptionActive,
    isSubscribed,
    canSell: await canSell(ownerId),
    canUseAgriDoctor: await canUseAgriDoctor(ownerId),
    // The one Chiguru wallet (not the retired app_settings balance).
    walletBalance: (await getWalletState(ownerId)).balance,
    doctorContactsUnlocked: !!settings.doctorContactsUnlockedAt,
    doctorContactsFee: DOCTOR_CONTACTS_FEE,
    canUseManagerDevices: await canUseManagerDevices(ownerId),
    managerDeviceAddonActive: isManagerDeviceAddonActive(settings, now),
    extraEstates,
    estateCount,
    maxEstates,
    canAddEstate: estateCount < maxEstates,
  });
});

// Retired: this used to add any amount to a separate Agri Doctor balance
// without taking a payment. Consultations now use the Chiguru wallet, which is
// only recharged through verified Razorpay / Apple / Google payments.
router.post("/app-settings/wallet/topup", requireOwner, (_req, res) => {
  res.status(410).json({
    error: "Recharge your Chiguru wallet from the Wallet screen to pay for consultations.",
    code: "USE_WALLET_RECHARGE",
  });
});

// Premium planters (Gold/Platinum, or in-trial) can register interest in the
// Bluetooth mini camera accessory. Persisted on the Owner's own app_settings
// row so the owner's request is captured for fulfilment.
router.post("/app-settings/camera-accessory/request", requireOwner, async (req, res) => {
  const ownerId = effectiveOwnerId(req)!;
  if (!(await canUseManagerDevices(ownerId))) {
    return res.status(403).json({ error: "The Bluetooth mini camera pairs with a manager device — add the manager-device add-on (₹199/month) first." });
  }
  const settings = await getSettings(ownerId);
  const [row] = await db
    .update(appSettingsTable)
    .set({ cameraAccessoryRequested: true, cameraAccessoryRequestedAt: new Date() })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json(row);
});


// Retired: these set a plan, the manager-device add-on or an extra estate on
// the legacy app_settings row without taking any payment. Plans and add-ons
// are bought through Razorpay / Google Play / Apple (routes/subscription.ts).
for (const path of ["/subscription/subscribe", "/subscription/manager-device-addon", "/subscription/estate-addon"]) {
  router.post(path, requireOwner, (_req, res) => {
    res.status(410).json({ error: "Buy plans and add-ons from the Subscription screen.", code: "RETIRED" });
  });
}

export default router;
