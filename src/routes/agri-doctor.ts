import { Router } from "express";
import { db } from "../db";
import {
  agronomistsTable,
  agronomistPayoutsTable,
  consultationsTable,
  consultationMessagesTable,
  appSettingsTable,
  farmProfileTable,
} from "../db/schema";
import { openai } from "../integrations-openai-ai-server";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import {
  PLANS,
  TRIAL_DAYS,
  SELLER_TRIAL_DAYS,
  ADDON_DEVICE_PRICE,
  MAX_ADDON_DEVICES,
  MANAGER_DEVICE_ADDON_MONTHS,
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
import { requireOwner } from "../middlewares/firebaseAuth";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";

const router = Router();

// Revenue split for every paid consultation: the doctor keeps 80% of the charge
// and the platform (website owner / developer) keeps the remaining 20%.
const DOCTOR_SHARE_RATE = 0.8;

// Split `cost` into the doctor's 80% share and the platform's 20% fee, rounded
// to paise. The fee is derived by subtraction so the two parts always sum back
// to `cost` exactly (no rounding drift).
function splitRevenue(cost: number) {
  const doctorEarning = Math.round(cost * DOCTOR_SHARE_RATE * 100) / 100;
  const platformFee = Math.round((cost - doctorEarning) * 100) / 100;
  return { doctorEarning, platformFee };
}

// ──────────────────────────────────────────────────────────────────────────────
// Doctor payout / bank details
// ──────────────────────────────────────────────────────────────────────────────

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

type AgronomistRow = typeof agronomistsTable.$inferSelect;

// A doctor can only consult (and receive their 80% share) once they have a valid
// payout channel: either full bank details or a UPI ID.
function hasBankDetails(d: Pick<AgronomistRow, "accountHolderName" | "bankAccountNumber" | "ifscCode">) {
  return Boolean(d.accountHolderName?.trim() && d.bankAccountNumber?.trim() && d.ifscCode?.trim());
}
function hasPayoutDetails(d: Pick<AgronomistRow, "accountHolderName" | "bankAccountNumber" | "ifscCode" | "upiId">) {
  return hasBankDetails(d) || Boolean(d.upiId?.trim());
}

function maskAccount(acct: string | null): string | null {
  if (!acct) return null;
  const s = acct.trim();
  if (s.length <= 4) return s;
  return `••••${s.slice(-4)}`;
}

// Shape returned to farmers — strips all sensitive payout/bank info and only
// signals whether the doctor is ready to be paid (and thus consultable).
function publicDoctor(d: AgronomistRow) {
  const {
    accountHolderName: _h,
    bankAccountNumber: _a,
    ifscCode: _i,
    upiId: _u,
    panNumber: _p,
    paidOut: _po,
    ...safe
  } = d;
  return { ...safe, payoutReady: hasPayoutDetails(d) };
}

// Normalizes and validates payout fields from a request body. Returns either the
// cleaned values or an error message.
function parsePayoutFields(b: Record<string, unknown>):
  | { ok: true; values: { accountHolderName: string | null; bankAccountNumber: string | null; ifscCode: string | null; upiId: string | null; panNumber: string | null } }
  | { ok: false; error: string } {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const accountHolderName = clean(b.accountHolderName);
  const bankAccountNumber = clean(b.bankAccountNumber);
  const ifscCode = clean(b.ifscCode)?.toUpperCase() ?? null;
  const upiId = clean(b.upiId);
  const panNumber = clean(b.panNumber)?.toUpperCase() ?? null;

  const values = { accountHolderName, bankAccountNumber, ifscCode, upiId, panNumber };

  if (!hasPayoutDetails(values)) {
    return { ok: false, error: "Add bank details (account holder, account number & IFSC) or a UPI ID so you can receive your consultation earnings" };
  }
  // If any bank field is provided, require the full valid set.
  if (accountHolderName || bankAccountNumber || ifscCode) {
    if (!hasBankDetails(values)) {
      return { ok: false, error: "Bank details are incomplete — account holder name, account number and IFSC are all required" };
    }
    if (!/^\d{5,18}$/.test(bankAccountNumber!)) {
      return { ok: false, error: "Enter a valid bank account number" };
    }
    if (!IFSC_RE.test(ifscCode!)) {
      return { ok: false, error: "Enter a valid IFSC code (e.g. SBIN0001234)" };
    }
  }
  if (upiId && !UPI_RE.test(upiId)) {
    return { ok: false, error: "Enter a valid UPI ID (e.g. name@bank)" };
  }
  if (panNumber && !PAN_RE.test(panNumber)) {
    return { ok: false, error: "Enter a valid PAN (e.g. ABCDE1234F)" };
  }
  return { ok: true, values };
}

const SEED_AGRONOMISTS = [
  {
    name: "Dr. Ramesh Patel",
    emoji: "👨‍🌾",
    speciality: "Crop Disease & Pest Management",
    qualification: "Ph.D. Plant Pathology",
    workplace: "Anand Agricultural University",
    location: "Anand, Gujarat",
    languages: "Hindi, Gujarati, English",
    experience: "18 years",
    contactPhone: "+91 98250 11111",
    rating: "4.8",
    ratePer15Min: "120",
    consultationPlan: "₹120 per 15 min · diagnosis + treatment plan",
    bio: "Specialist in identifying fungal, bacterial and viral crop diseases. Helps farmers raise yields with safe, low-cost spray schedules.",
    isOnline: true,
    isActive: true,
  },
  {
    name: "Dr. Lakshmi Iyer",
    emoji: "👩‍🌾",
    speciality: "Soil Health & Nutrition",
    qualification: "M.Sc. Soil Science",
    workplace: "ICAR Regional Station",
    location: "Coimbatore, Tamil Nadu",
    languages: "Tamil, English, Hindi",
    experience: "12 years",
    contactPhone: "+91 99400 22222",
    rating: "4.7",
    ratePer15Min: "100",
    consultationPlan: "₹100 per 15 min · soil & fertiliser advice",
    bio: "Guides farmers on soil testing, balanced fertiliser use and organic matter to improve long-term productivity.",
    isOnline: true,
    isActive: true,
  },
  {
    name: "Prof. Harbhajan Singh",
    emoji: "🧑‍🏫",
    speciality: "Horticulture & High-Value Crops",
    qualification: "Professor of Horticulture",
    workplace: "Punjab Agricultural University",
    location: "Ludhiana, Punjab",
    languages: "Punjabi, Hindi, English",
    experience: "25 years",
    contactPhone: "+91 98140 33333",
    rating: "4.9",
    ratePer15Min: "150",
    consultationPlan: "₹150 per 15 min · orchard & vegetable planning",
    bio: "Helps planters select profitable fruit and vegetable varieties and plan irrigation and canopy management.",
    isOnline: false,
    isActive: true,
  },
  {
    name: "Dr. Anjali Verma",
    emoji: "👩‍⚕️",
    speciality: "Irrigation & Water Management",
    qualification: "Ph.D. Agricultural Engineering",
    workplace: "Jawaharlal Nehru Krishi Vishwavidyalaya",
    location: "Jabalpur, Madhya Pradesh",
    languages: "Hindi, English",
    experience: "10 years",
    contactPhone: "+91 94250 44444",
    rating: "4.6",
    ratePer15Min: "100",
    consultationPlan: "₹100 per 15 min · drip & water-saving advice",
    bio: "Designs cost-effective drip and sprinkler systems and water schedules suited to local rainfall.",
    isOnline: true,
    isActive: true,
  },
];

async function ensureSeed() {
  const rows = await db.select().from(agronomistsTable).limit(1);
  if (rows.length === 0) {
    // Seed sample doctors with placeholder payout details so they stay
    // consultable; real doctors provide their own at registration.
    await db.insert(agronomistsTable).values(
      SEED_AGRONOMISTS.map((d, i) => ({
        ...d,
        accountHolderName: d.name.replace(/^(Dr\.|Prof\.)\s*/, ""),
        upiId: `agridoctor${i + 1}@upi`,
      })),
    );
  }
}

async function getSettings() {
  const rows = await db.select().from(appSettingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [row] = await db.insert(appSettingsTable).values({}).returning();
  return row;
}

// ──────────────────────────────────────────────────────────────────────────────
// Agronomist directory
// ──────────────────────────────────────────────────────────────────────────────

router.get("/agronomists", async (_req, res) => {
  await ensureSeed();
  const rows = await db
    .select()
    .from(agronomistsTable)
    .where(eq(agronomistsTable.isActive, true))
    .orderBy(desc(agronomistsTable.isOnline), desc(agronomistsTable.rating));
  return res.json(rows.map(publicDoctor));
});

router.get("/agronomists/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, id)).limit(1);
  if (rows.length === 0) return res.status(404).json({ message: "Not found" });
  return res.json(publicDoctor(rows[0]));
});

router.post("/agronomists", requireOwner, requireActiveSubscription, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const speciality = typeof b.speciality === "string" ? b.speciality.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!speciality) return res.status(400).json({ error: "speciality is required" });

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  // Credentials are mandatory — a doctor must prove their agricultural education
  // and experience before farmers can consult them.
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

  const rate = Math.min(100000, Math.max(0, Number(b.ratePer15Min) || 100));

  // Payout details are mandatory — a doctor must be able to receive their 80%
  // share before they can consult online.
  const payout = parsePayoutFields(b);
  if (!payout.ok) return res.status(400).json({ error: payout.error });

  const [row] = await db
    .insert(agronomistsTable)
    .values({
      name,
      speciality,
      emoji: str(b.emoji) ?? "👨‍🌾",
      qualification,
      certificateUrl,
      workplace: str(b.workplace),
      location: str(b.location),
      languages: str(b.languages),
      experience,
      contactPhone: str(b.contactPhone),
      ratePer15Min: String(rate),
      consultationPlan: str(b.consultationPlan),
      bio: str(b.bio),
      ...payout.values,
    })
    .returning();
  // Return the redacted shape — never echo bank details back over the wire.
  return res.json(publicDoctor(row));
});

// ──────────────────────────────────────────────────────────────────────────────
// Doctor earnings & payouts
// ──────────────────────────────────────────────────────────────────────────────

// A doctor's own earnings view: how much they've earned (80% share), how much
// has been paid out, how much is pending, and what's still available to
// withdraw — plus their (masked) payout channel and payout history.
router.get("/agronomists/:id/earnings", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, id)).limit(1);
  if (rows.length === 0) return res.status(404).json({ error: "Agronomist not found" });
  const doc = rows[0];

  const payouts = await db
    .select()
    .from(agronomistPayoutsTable)
    .where(eq(agronomistPayoutsTable.agronomistId, id))
    .orderBy(desc(agronomistPayoutsTable.createdAt));

  const totalEarnings = Number(doc.totalEarnings) || 0;
  const paidOut = Number(doc.paidOut) || 0;
  const pending = payouts
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const available = Math.max(0, Math.round((totalEarnings - paidOut - pending) * 100) / 100);

  return res.json({
    id: doc.id,
    name: doc.name,
    totalEarnings,
    paidOut,
    pending,
    available,
    payoutReady: hasPayoutDetails(doc),
    payoutMethod: {
      accountHolderName: doc.accountHolderName,
      bankAccountNumber: maskAccount(doc.bankAccountNumber),
      ifscCode: doc.ifscCode,
      upiId: doc.upiId,
      panNumber: doc.panNumber ? `••••${doc.panNumber.slice(-4)}` : null,
    },
    payouts,
  });
});

// Request a payout of the doctor's available balance (or a chosen amount).
// Creates a `pending` ledger entry; it is disbursed later via the mark-paid
// endpoint.
router.post("/agronomists/:id/payouts", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  const reference = typeof b.reference === "string" && b.reference.trim() ? b.reference.trim() : null;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;

  // The availability check and the pending-payout insert must be one atomic unit,
  // otherwise two concurrent requests can both pass `requested <= available` and
  // over-allocate beyond the true balance. We lock the agronomist row (FOR UPDATE)
  // so concurrent requests serialize and each recomputes `available` fresh.
  const result = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(agronomistsTable)
      .where(eq(agronomistsTable.id, id))
      .limit(1)
      .for("update");
    if (!doc) return { status: 404 as const, error: "Agronomist not found" };

    if (!hasPayoutDetails(doc)) {
      return { status: 400 as const, error: "Add payout details before requesting a payout" };
    }

    const existing = await tx
      .select()
      .from(agronomistPayoutsTable)
      .where(eq(agronomistPayoutsTable.agronomistId, id));
    const paidOut = Number(doc.paidOut) || 0;
    const pending = existing
      .filter((p) => p.status === "pending")
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const available = Math.round(((Number(doc.totalEarnings) || 0) - paidOut - pending) * 100) / 100;

    const requested = b.amount === undefined ? available : Math.round((Number(b.amount) || 0) * 100) / 100;
    if (!(requested > 0)) return { status: 400 as const, error: "Enter a valid payout amount" };
    if (requested > available) {
      return { status: 400 as const, error: `Amount exceeds your available balance (₹${available})` };
    }

    const method = hasBankDetails(doc) ? "bank" : "upi";
    const [row] = await tx
      .insert(agronomistPayoutsTable)
      .values({ agronomistId: id, amount: String(requested), method, reference, notes })
      .returning();
    return { status: 200 as const, row };
  });

  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  return res.json(result.row);
});

// Mark a pending payout as paid — records the disbursement and adds the amount
// to the doctor's running `paidOut` total (atomically).
router.post("/agronomists/:id/payouts/:payoutId/paid", async (req, res) => {
  const id = Number(req.params.id);
  const payoutId = Number(req.params.payoutId);
  const b = req.body as Record<string, unknown>;
  const reference = typeof b.reference === "string" && b.reference.trim() ? b.reference.trim() : undefined;

  const result = await db.transaction(async (tx) => {
    const [payout] = await tx
      .update(agronomistPayoutsTable)
      .set({ status: "paid", paidAt: new Date(), ...(reference ? { reference } : {}) })
      .where(
        and(
          eq(agronomistPayoutsTable.id, payoutId),
          eq(agronomistPayoutsTable.agronomistId, id),
          eq(agronomistPayoutsTable.status, "pending"),
        ),
      )
      .returning();
    if (!payout) return null;

    await tx
      .update(agronomistsTable)
      .set({ paidOut: sql`${agronomistsTable.paidOut} + ${Number(payout.amount)}` })
      .where(eq(agronomistsTable.id, id));
    return payout;
  });

  if (!result) return res.status(404).json({ error: "Pending payout not found" });
  return res.json(result);
});

// ──────────────────────────────────────────────────────────────────────────────
// App settings, wallet & subscription
// ──────────────────────────────────────────────────────────────────────────────

router.get("/app-settings", async (_req, res) => {
  const settings = await getSettings();
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
    .from(farmProfileTable);
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
    canSell: await canSell(),
    canUseAgriDoctor: await canUseAgriDoctor(),
    canUseManagerDevices: await canUseManagerDevices(),
    managerDeviceAddonActive: isManagerDeviceAddonActive(settings, now),
    extraEstates,
    estateCount,
    maxEstates,
    canAddEstate: estateCount < maxEstates,
  });
});

router.post("/app-settings/wallet/topup", async (req, res) => {
  const { amount } = req.body as { amount?: number };
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "amount must be greater than 0" });
  const settings = await getSettings();
  const newBalance = (Number(settings.walletBalance) || 0) + amt;
  const [row] = await db
    .update(appSettingsTable)
    .set({ walletBalance: String(newBalance) })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json(row);
});

// Premium planters (Gold/Platinum, or in-trial) can register interest in the
// Bluetooth mini camera accessory. Persisted on the single app_settings row so
// the owner's request is captured for fulfilment.
router.post("/app-settings/camera-accessory/request", async (_req, res) => {
  if (!(await canUseManagerDevices())) {
    return res.status(403).json({ error: "The Bluetooth mini camera pairs with a manager device — add the manager-device add-on (₹199/month) first." });
  }
  const settings = await getSettings();
  const [row] = await db
    .update(appSettingsTable)
    .set({ cameraAccessoryRequested: true, cameraAccessoryRequestedAt: new Date() })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json(row);
});

router.post("/subscription/subscribe", async (req, res) => {
  const settings = await getSettings();
  const now = new Date();

  // The farmer picks a plan. There is a single Farmer plan (₹399/month),
  // with an optional auto-pay that renews it automatically every month.
  const { plan, autoPay } = req.body as { plan?: string; autoPay?: boolean };
  const chosen = planById(plan);
  if (!chosen) {
    return res.status(400).json({ error: "Choose a valid plan" });
  }

  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + chosen.durationMonths);

  const [row] = await db
    .update(appSettingsTable)
    .set({
      subscriptionPlan: chosen.id,
      subscribedAt: now,
      subscriptionExpiresAt: expiresAt,
      subscriptionAutoPay: autoPay === true,
    })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json({ ...row, plan: chosen });
});

// The manager device is a STANDALONE add-on — not bundled in any plan. Anyone can
// buy it (₹ADDON_DEVICE_PRICE per month); if an add-on is already active the
// month is extended from the current expiry rather than from today. Auto-pay
// (set from the owner's app) keeps renewing it every month.
router.post("/subscription/manager-device-addon", async (req, res) => {
  const settings = await getSettings();
  const now = new Date();
  const { autoPay } = (req.body ?? {}) as { autoPay?: boolean };
  const current = settings.managerDeviceAddonExpiresAt
    ? new Date(settings.managerDeviceAddonExpiresAt as unknown as string)
    : null;
  const base = current && current > now ? current : now;
  const expiresAt = new Date(base);
  expiresAt.setMonth(expiresAt.getMonth() + MANAGER_DEVICE_ADDON_MONTHS);

  const [row] = await db
    .update(appSettingsTable)
    .set({
      managerDeviceAddonAt: now,
      managerDeviceAddonExpiresAt: expiresAt,
      managerDeviceAutoPay: autoPay === true,
    })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json({ ...row, managerDeviceAddonActive: isManagerDeviceAddonActive(row, now) });
});

// The "Zamindar" estate add-on — a STANDALONE monthly add-on (₹ESTATE_ADDON_PRICE
// per extra estate per month). Each purchase raises the estate allowance by one,
// so the owner can create one more estate in the switcher. Auto-pay keeps the
// monthly charge renewing so the unlocked estates stay available.
router.post("/subscription/estate-addon", async (req, res) => {
  const settings = await getSettings();
  const { autoPay } = (req.body ?? {}) as { autoPay?: boolean };
  const extraEstates = (settings.extraEstates ?? 0) + 1;
  const [row] = await db
    .update(appSettingsTable)
    .set({ extraEstates, estateAddonAutoPay: autoPay === true })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  return res.json({ ...row, maxEstates: BASE_ESTATE_ALLOWANCE + extraEstates });
});

// ──────────────────────────────────────────────────────────────────────────────
// Consultations (chat / call) with per-15-min billing
// ──────────────────────────────────────────────────────────────────────────────

router.post("/consultations", requireOwner, requireActiveSubscription, async (req, res) => {
  const { agronomistId, mode, topic } = req.body as { agronomistId?: number; mode?: string; topic?: string };
  if (!agronomistId) return res.status(400).json({ error: "agronomistId is required" });
  const docRows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, Number(agronomistId))).limit(1);
  if (docRows.length === 0) return res.status(404).json({ error: "Agronomist not found" });
  const doc = docRows[0];

  // A doctor cannot consult online until they have added payout details, so
  // their 80% share can actually be deposited.
  if (!hasPayoutDetails(doc)) {
    return res.status(403).json({ error: "This doctor has not completed their payout setup yet and cannot consult online" });
  }

  const [consultation] = await db
    .insert(consultationsTable)
    .values({ agronomistId: Number(agronomistId), mode: mode === "call" ? "call" : "chat", topic: topic ?? null })
    .returning();

  const greeting = `Namaste! I'm ${doc.name}, specialist in ${doc.speciality}. ${
    topic ? `You mentioned: "${topic}". ` : ""
  }Please describe your crop, the problem you're seeing, and a photo if you have one. I'll help you protect your yield.`;
  await db.insert(consultationMessagesTable).values({
    consultationId: consultation.id,
    sender: "doctor",
    text: greeting,
  });

  return res.json(consultation);
});

router.get("/consultations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(consultationMessagesTable)
    .where(eq(consultationMessagesTable.consultationId, id))
    .orderBy(asc(consultationMessagesTable.createdAt));
  return res.json(rows);
});

router.post("/consultations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { text } = req.body as { text?: string };
  if (!text || !text.trim()) return res.status(400).json({ error: "text is required" });

  const consultRows = await db.select().from(consultationsTable).where(eq(consultationsTable.id, id)).limit(1);
  if (consultRows.length === 0) return res.status(404).json({ error: "Consultation not found" });
  const consultation = consultRows[0];
  if (consultation.status !== "active") return res.status(400).json({ error: "Consultation has ended" });

  const docRows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, consultation.agronomistId)).limit(1);
  const doc = docRows[0];

  await db.insert(consultationMessagesTable).values({ consultationId: id, sender: "farmer", text: text.trim() });

  const history = await db
    .select()
    .from(consultationMessagesTable)
    .where(eq(consultationMessagesTable.consultationId, id))
    .orderBy(asc(consultationMessagesTable.createdAt));

  const profile = await db.select().from(farmProfileTable).limit(1);
  const farmContext = profile.length
    ? `The farmer's farm: ${profile[0].farmName ?? "farm"} in ${profile[0].village ?? ""}, ${profile[0].district ?? ""}, about ${profile[0].totalAcres ?? "?"} acres.`
    : "";

  let reply = "I'm having trouble responding right now. Please try again, or call me using the number on my profile.";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 600,
      messages: [
        {
          role: "system",
          content:
            `You are ${doc?.name ?? "an agriculture doctor"}, an Indian agronomist specialising in ${doc?.speciality ?? "agriculture"} ` +
            `(${doc?.qualification ?? ""}, ${doc?.experience ?? ""} experience). ${farmContext} ` +
            `You are consulting a smallholder Indian farmer. Give practical, affordable, locally-relevant advice to diagnose problems and improve yield. ` +
            `Use simple language. Be concise (4-8 short lines). Recommend safe, low-cost steps first. If a disease or pest is suspected, name it and the remedy with approximate dosage. ` +
            `If you need more detail, ask one or two specific questions. Do not mention being an AI.`,
        },
        ...history.map((m) => ({
          role: (m.sender === "farmer" ? "user" : "assistant") as "user" | "assistant",
          content: m.text,
        })),
      ],
    });
    reply = completion.choices[0]?.message?.content?.trim() || reply;
  } catch (err) {
    console.error("agri-doctor reply error:", err);
  }

  const [doctorMsg] = await db
    .insert(consultationMessagesTable)
    .values({ consultationId: id, sender: "doctor", text: reply })
    .returning();

  return res.json(doctorMsg);
});

router.post("/consultations/:id/end", async (req, res) => {
  const id = Number(req.params.id);
  const consultRows = await db.select().from(consultationsTable).where(eq(consultationsTable.id, id)).limit(1);
  if (consultRows.length === 0) return res.status(404).json({ error: "Consultation not found" });
  const consultation = consultRows[0];

  // Idempotent: if already ended, return stored result without re-charging.
  if (consultation.status === "ended") {
    const s = await getSettings();
    return res.json({
      ...consultation,
      cost: Number(consultation.cost),
      doctorEarning: Number(consultation.doctorEarning),
      platformFee: Number(consultation.platformFee),
      minutes: consultation.durationMinutes,
      walletBalance: Number(s.walletBalance) || 0,
      alreadyEnded: true,
    });
  }

  const docRows = await db.select().from(agronomistsTable).where(eq(agronomistsTable.id, consultation.agronomistId)).limit(1);
  const ratePer15 = docRows.length ? Number(docRows[0].ratePer15Min) || 0 : 0;

  // Server-authoritative elapsed time (client value is not trusted for billing).
  const startedAt = new Date(consultation.startedAt as unknown as string);
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  const minutes = Math.ceil(elapsedSec / 60);
  const blocks = Math.max(1, Math.ceil(elapsedSec / (15 * 60)));
  // Normalize the charge to paise before splitting so the returned cost always
  // equals doctorEarning + platformFee exactly (no float artifacts).
  const cost = Math.round(blocks * ratePer15 * 100) / 100;
  const { doctorEarning, platformFee } = splitRevenue(cost);

  const settings = await getSettings();

  // Finalize the consultation and apply the revenue split atomically so a
  // partial failure can never leave the wallet, platform revenue, and doctor
  // earnings out of sync. Running totals use in-SQL increments (`col = col + x`)
  // to avoid lost updates when consultations end concurrently.
  let updated: typeof consultationsTable.$inferSelect | undefined;
  let newBalance = Number(settings.walletBalance) || 0;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(consultationsTable)
      .set({
        status: "ended",
        endedAt: new Date(),
        durationMinutes: minutes,
        cost: String(cost),
        doctorEarning: String(doctorEarning),
        platformFee: String(platformFee),
      })
      .where(and(eq(consultationsTable.id, id), eq(consultationsTable.status, "active")))
      .returning();
    updated = row;
    // Lost the race (another request ended it first) — do not charge or credit.
    if (!row) return;

    const [s] = await tx
      .update(appSettingsTable)
      .set({
        walletBalance: sql`GREATEST(0, ${appSettingsTable.walletBalance} - ${cost})`,
        platformRevenue: sql`${appSettingsTable.platformRevenue} + ${platformFee}`,
      })
      .where(eq(appSettingsTable.id, settings.id))
      .returning();
    newBalance = Number(s?.walletBalance) || 0;

    if (docRows.length) {
      await tx
        .update(agronomistsTable)
        .set({ totalEarnings: sql`${agronomistsTable.totalEarnings} + ${doctorEarning}` })
        .where(eq(agronomistsTable.id, docRows[0].id));
    }
  });

  if (!updated) {
    const fresh = await db.select().from(consultationsTable).where(eq(consultationsTable.id, id)).limit(1);
    const s = await getSettings();
    return res.json({
      ...fresh[0],
      cost: Number(fresh[0]?.cost) || 0,
      doctorEarning: Number(fresh[0]?.doctorEarning) || 0,
      platformFee: Number(fresh[0]?.platformFee) || 0,
      minutes: fresh[0]?.durationMinutes ?? 0,
      walletBalance: Number(s.walletBalance) || 0,
      alreadyEnded: true,
    });
  }

  return res.json({ ...updated, cost, doctorEarning, platformFee, minutes, blocks, ratePer15, walletBalance: newBalance });
});

router.get("/consultations", async (_req, res) => {
  const rows = await db.select().from(consultationsTable).orderBy(desc(consultationsTable.startedAt)).limit(50);
  return res.json(rows);
});

export default router;
