import {
  pgTable,
  serial,
  text,
  numeric,
  boolean,
  timestamp,
  date,
  integer,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

export const farmProfileTable = pgTable("farm_profile", {
  id: serial("id").primaryKey(),
  farmName: text("farm_name").notNull(),
  // Human-friendly backup key for this farm. There are no user accounts, so this
  // code IS the identity: whoever enters it on a new/lost phone reclaims all of
  // this farm's synced records. Generated once and shown in Backup & Restore.
  recoveryCode: text("recovery_code").unique(),
  // Legacy link from the pre-Firebase (Clerk) auth era. Superseded by ownerId
  // below — kept only so old rows aren't silently orphaned; not written to anymore.
  clerkUserId: text("clerk_user_id"),
  // Owner of this estate under the multi-tenant Firebase-auth model. Nullable
  // during the migration window — existing farms are backfilled to their real
  // owner once that owner first signs in.
  ownerId: integer("owner_id").references(() => ownersTable.id),
  // Farmer's contact phone, shown/edited in My Profile (used for callbacks/support).
  contactPhone: text("contact_phone"),
  // Location/size are optional: a planter can add a secondary estate with just a
  // name and fill in GPS/village/acres later. Only the name is required.
  latitude: numeric("latitude", { precision: 10, scale: 6 }),
  longitude: numeric("longitude", { precision: 10, scale: 6 }),
  village: text("village"),
  taluk: text("taluk"),
  district: text("district"),
  state: text("state"),
  country: text("country").notNull().default("India"),
  totalAcres: numeric("total_acres", { precision: 8, scale: 2 }),
  avgRainfallMm: numeric("avg_rainfall_mm", { precision: 8, scale: 2 }),
  climateZone: text("climate_zone"),
  // ISO 4217 currency code for all money shown for this farm (INR, USD, BRL…).
  // Set automatically when the owner picks their country in the app menu; the
  // manager device reads it from here so both apps always match.
  currency: text("currency").notNull().default("INR"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const cropsTable = pgTable("crops", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  name: text("name").notNull(),
  variety: text("variety"),
  acres: numeric("acres", { precision: 8, scale: 2 }).notNull(),
  season: text("season").notNull(),
  blockName: text("block_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const errorLogsTable = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  message: text("message").notNull(),
  stack: text("stack"),
  source: text("source"),
  url: text("url"),
  userAgent: text("user_agent"),
  appVersion: text("app_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const blocksTable = pgTable("blocks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  acres: numeric("acres", { precision: 8, scale: 2 }).notNull(),
  cropId: integer("crop_id").references(() => cropsTable.id),
  description: text("description"),
  latitude: numeric("latitude", { precision: 10, scale: 6 }),
  longitude: numeric("longitude", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBlockSchema = createInsertSchema(blocksTable).omit({ id: true, createdAt: true });

export const workersTable = pgTable("workers", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  name: text("name").notNull(),
  phone: text("phone"),
  type: text("type").notNull(),
  wageRate: numeric("wage_rate", { precision: 10, scale: 2 }).notNull(),
  wageUnit: text("wage_unit").notNull().default("day"),
  aadhaarNumber: text("aadhaar_number"),
  photoUrl: text("photo_url"),
  // 128-number face embedding (JSON array) captured at face registration;
  // matched on-device for face-recognition attendance.
  faceDescriptor: text("face_descriptor"),
  isActive: boolean("is_active").notNull().default(true),
  // Profile fields
  role: text("role"),
  skills: text("skills"),
  experience: text("experience"),
  village: text("village"),
  taluk: text("taluk"),
  district: text("district"),
  state: text("state"),
  availability: text("availability").notNull().default("available"),
  bio: text("bio"),
  // Payee handle for direct payments (e.g. UPI ID in India, wallet/phone elsewhere).
  upiId: text("upi_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const workGroupsTable = pgTable("work_groups", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  name: text("name").notNull(),
  cropId: integer("crop_id").references(() => cropsTable.id),
  blockName: text("block_name"),
  category: text("category").notNull(),
  labourType: text("labour_type").notNull(),
  paymentType: text("payment_type").notNull(),
  rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
  advancePerUnit: numeric("advance_per_unit", { precision: 10, scale: 2 }),
  payFrequency: text("pay_frequency").notNull().default("daily"),
  expectedWorkers: integer("expected_workers"),
  loanTaken: numeric("loan_taken", { precision: 10, scale: 2 }),
  loanNotes: text("loan_notes"),
  targetQuantity: numeric("target_quantity", { precision: 10, scale: 2 }),
  targetUnit: text("target_unit"),
  notes: text("notes"),
  seasonClosed: boolean("season_closed").notNull().default(false),
  seasonSummary: text("season_summary"),
  // Payee handle of the group contractor/maistry for direct payments.
  upiId: text("upi_id"),
  isActive: boolean("is_active").notNull().default(true),
  // Soft delete → recycle bin. Non-null means "in the bin"; restorable for 30
  // days, then purged (with children) lazily by the bin endpoints.
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One work session per group per day: check-in time+photo when the gang
// arrives, up to 2 in-between work-update photos, check-out time+photo when
// they leave. Photos are compressed data URLs (same convention as loan proofs).
export const groupWorkSessionsTable = pgTable("group_work_sessions", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  workGroupId: integer("work_group_id").notNull().references(() => workGroupsTable.id),
  date: date("date").notNull(),
  checkInAt: timestamp("check_in_at").notNull().defaultNow(),
  checkInPhoto: text("check_in_photo"),
  headcountIn: integer("headcount_in"),
  // [{ takenAt: ISO string, photo: data URL }] — max 2, enforced by the API.
  updatePhotos: jsonb("update_photos").notNull().default([]),
  checkOutAt: timestamp("check_out_at"),
  checkOutPhoto: text("check_out_photo"),
  headcountOut: integer("headcount_out"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // Only one *open* (not checked-out) session per group per day — guards
  // against duplicate check-ins from concurrent requests.
  openSessionUnique: uniqueIndex("group_work_sessions_open_unique")
    .on(t.workGroupId, t.date)
    .where(sql`${t.checkOutAt} is null`),
}));

export const groupAdvancePaymentsTable = pgTable("group_advance_payments", {
  id: serial("id").primaryKey(),
  workGroupId: integer("work_group_id").notNull().references(() => workGroupsTable.id),
  paymentDate: date("payment_date").notNull(),
  periodLabel: text("period_label").notNull(),
  daysCount: integer("days_count").notNull(),
  workerCount: integer("worker_count").notNull(),
  advancePerWorkerPerDay: numeric("advance_per_worker_per_day", { precision: 10, scale: 2 }).notNull(),
  totalAdvancePaid: numeric("total_advance_paid", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const attendanceTable = pgTable("attendance", {
  id: serial("id").primaryKey(),
  workGroupId: integer("work_group_id")
    .notNull()
    .references(() => workGroupsTable.id),
  workerId: integer("worker_id")
    .notNull()
    .references(() => workersTable.id),
  date: date("date").notNull(),
  hoursWorked: numeric("hours_worked", { precision: 5, scale: 2 }).notNull(),
  wageAmount: numeric("wage_amount", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  // Label of the device/person who last wrote this row (e.g. "Owner" or a
  // manager's name). Used for last-write-wins conflict logging across devices.
  lastEditedBy: text("last_edited_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // One attendance row per worker per group per day. Enforced in the DB so that
  // concurrent at-least-once replays from multiple devices can never create
  // duplicate rows (which would double-charge wages) — the write path upserts
  // onto this natural key, with last-write-wins resolution.
  naturalKeyUnique: uniqueIndex("attendance_group_worker_date_unique").on(
    t.workGroupId,
    t.workerId,
    t.date,
  ),
}));

export const dailyWorkTable = pgTable("daily_work", {
  id: serial("id").primaryKey(),
  workGroupId: integer("work_group_id")
    .notNull()
    .references(() => workGroupsTable.id),
  date: date("date").notNull(),
  quantityDone: numeric("quantity_done", { precision: 10, scale: 2 }),
  quantityUnit: text("quantity_unit"),
  materialUsed: text("material_used"),
  materialQty: numeric("material_qty", { precision: 10, scale: 2 }),
  materialUnit: text("material_unit"),
  photoUrl: text("photo_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const estateUpdatesTable = pgTable(
  "estate_updates",
  {
    id: serial("id").primaryKey(),
    estateId: integer("estate_id").references(() => farmProfileTable.id),
    date: date("date").notNull(),
    workerName: text("worker_name"),
    blockName: text("block_name"),
    workGroupId: integer("work_group_id"),
    description: text("description").notNull(),
    photoUrl: text("photo_url"),
    videoUrl: text("video_url"),
    notes: text("notes"),
    attendanceCount: integer("attendance_count"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    // Idempotency key supplied by the client (the offline queue's localId). Lets a
    // queued or retried POST be re-sent safely: if the server already committed the
    // row but the response was lost on a flaky network, the re-POST returns the
    // existing row instead of inserting a duplicate. Nullable: legacy/direct callers
    // omit it (Postgres treats NULLs as distinct, so they never collide).
    clientId: text("client_id"),
    // Soft delete → recycle bin (photos/work updates); purged after 30 days.
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    clientIdUnique: uniqueIndex("estate_updates_client_id_unique").on(t.clientId),
  }),
);

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  date: date("date").notNull(),
  cropId: integer("crop_id").references(() => cropsTable.id),
  category: text("category").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  description: text("description"),
  vendor: text("vendor"),
  receiptUrl: text("receipt_url"),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const spraysTable = pgTable("sprays", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  date: date("date").notNull(),
  cropId: integer("crop_id").references(() => cropsTable.id),
  blockName: text("block_name"),
  productName: text("product_name").notNull(),
  productType: text("product_type"),
  concentrationPct: numeric("concentration_pct", { precision: 5, scale: 2 }),
  barrelsUsed: numeric("barrels_used", { precision: 8, scale: 2 }),
  litresUsed: numeric("litres_used", { precision: 8, scale: 2 }).notNull(),
  areaAcres: numeric("area_acres", { precision: 8, scale: 2 }).notNull(),
  cost: numeric("cost", { precision: 10, scale: 2 }).notNull(),
  weatherCondition: text("weather_condition"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const harvestsTable = pgTable("harvests", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  date: date("date").notNull(),
  cropId: integer("crop_id")
    .notNull()
    .references(() => cropsTable.id),
  workGroupId: integer("work_group_id").references(() => workGroupsTable.id),
  blockName: text("block_name"),
  weightKg: numeric("weight_kg", { precision: 10, scale: 2 }).notNull(),
  grade: text("grade"),
  pricePerKg: numeric("price_per_kg", { precision: 8, scale: 2 }).notNull(),
  totalIncome: numeric("total_income", { precision: 12, scale: 2 }).notNull(),
  buyer: text("buyer"),
  paymentStatus: text("payment_status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const loansTable = pgTable("loans", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  workerId: integer("worker_id")
    .notNull()
    .references(() => workersTable.id),
  workGroupId: integer("work_group_id").references(() => workGroupsTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  interestPct: numeric("interest_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  totalDue: numeric("total_due", { precision: 12, scale: 2 }).notNull(),
  issuedDate: date("issued_date").notNull(),
  dueDate: date("due_date"),
  repaidAmount: numeric("repaid_amount", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  repaymentMethod: text("repayment_method").notNull().default("salary"),
  status: text("status").notNull().default("active"),
  aadhaarPhotoUrl: text("aadhaar_photo_url"),
  // Proof of loan: a photo taken at handover (worker receiving the cash) stored
  // as a compressed base64 data URL, so a worker cannot later deny taking it.
  proofPhotoUrl: text("proof_photo_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const loanPaymentsTable = pgTable("loan_payments", {
  id: serial("id").primaryKey(),
  loanId: integer("loan_id")
    .notNull()
    .references(() => loansTable.id),
  date: date("date").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Agriculture Doctor (Agronomist Consultations) ─────────────────────────────

export const agronomistsTable = pgTable("agronomists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull().default("👨‍🌾"),
  speciality: text("speciality").notNull(),
  qualification: text("qualification"),
  // Proof of agricultural education — a photo of the doctor's degree/certificate,
  // required at registration so farmers can trust their credentials.
  certificateUrl: text("certificate_url"),
  workplace: text("workplace"),
  location: text("location"),
  languages: text("languages"),
  experience: text("experience"),
  contactPhone: text("contact_phone"),
  rating: numeric("rating", { precision: 3, scale: 1 }).notNull().default("4.5"),
  ratePer15Min: numeric("rate_per_15_min", { precision: 10, scale: 2 }).notNull().default("100"),
  consultationPlan: text("consultation_plan"),
  bio: text("bio"),
  isOnline: boolean("is_online").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  // Payout / bank details — required before a doctor can consult online so the
  // platform can deposit their 80% share. Never exposed to farmers.
  accountHolderName: text("account_holder_name"),
  bankAccountNumber: text("bank_account_number"),
  ifscCode: text("ifsc_code"),
  upiId: text("upi_id"),
  panNumber: text("pan_number"),
  // Running total of the doctor's 80% share across all ended consultations.
  totalEarnings: numeric("total_earnings", { precision: 12, scale: 2 }).notNull().default("0"),
  // Running total already disbursed to the doctor via payouts.
  paidOut: numeric("paid_out", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Ledger of payouts (withdrawals) of a doctor's earned 80% share. A payout is
// requested (`pending`) then marked `paid` once the platform disburses it, at
// which point the amount is added to the doctor's `paidOut` total.
export const agronomistPayoutsTable = pgTable("agronomist_payouts", {
  id: serial("id").primaryKey(),
  agronomistId: integer("agronomist_id").notNull().references(() => agronomistsTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull().default("bank"),
  reference: text("reference"),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  paidAt: timestamp("paid_at"),
});

export const consultationsTable = pgTable("consultations", {
  id: serial("id").primaryKey(),
  agronomistId: integer("agronomist_id").notNull().references(() => agronomistsTable.id),
  mode: text("mode").notNull().default("chat"),
  status: text("status").notNull().default("active"),
  topic: text("topic"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  cost: numeric("cost", { precision: 10, scale: 2 }).notNull().default("0"),
  // Revenue split of `cost`: 80% to the doctor, 20% platform fee.
  doctorEarning: numeric("doctor_earning", { precision: 10, scale: 2 }).notNull().default("0"),
  platformFee: numeric("platform_fee", { precision: 10, scale: 2 }).notNull().default("0"),
});

export const consultationMessagesTable = pgTable("consultation_messages", {
  id: serial("id").primaryKey(),
  consultationId: integer("consultation_id").notNull().references(() => consultationsTable.id),
  sender: text("sender").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  trialStartDate: timestamp("trial_start_date").notNull().defaultNow(),
  walletBalance: numeric("wallet_balance", { precision: 10, scale: 2 }).notNull().default("0"),
  // Running total of the 20% platform fee kept by the website owner/developer.
  platformRevenue: numeric("platform_revenue", { precision: 12, scale: 2 }).notNull().default("0"),
  subscriptionPlan: text("subscription_plan"),
  subscriptionAcres: numeric("subscription_acres", { precision: 8, scale: 2 }),
  subscribedAt: timestamp("subscribed_at"),
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  // Auto-pay: when on, the monthly charge renews automatically at expiry.
  subscriptionAutoPay: boolean("subscription_auto_pay").notNull().default(false),
  managerDeviceAutoPay: boolean("manager_device_auto_pay").notNull().default(false),
  estateAddonAutoPay: boolean("estate_addon_auto_pay").notNull().default(false),
  managerPairCode: text("manager_pair_code"),
  // Manager device is a standalone paid add-on (not bundled in any plan).
  managerDeviceAddonAt: timestamp("manager_device_addon_at"),
  managerDeviceAddonExpiresAt: timestamp("manager_device_addon_expires_at"),
  // "Zamindar" estate add-on: each purchase (₹799) permanently unlocks one more
  // estate in the switcher. Base allowance is 1 free estate; max = 1 + this count.
  extraEstates: integer("extra_estates").notNull().default(0),
  cameraAccessoryRequested: boolean("camera_accessory_requested").notNull().default(false),
  cameraAccessoryRequestedAt: timestamp("camera_accessory_requested_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Nursery Marketplace ───────────────────────────────────────────────────────

export const nurseryVendorsTable = pgTable("nursery_vendors", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("nursery"),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  whatsapp: text("whatsapp"),
  location: text("location").notNull(),
  description: text("description"),
  speciality: text("speciality"),
  photoUrl: text("photo_url"),
  status: text("status").notNull().default("pending"),
  adminNotes: text("admin_notes"),
  isActive: boolean("is_active").notNull().default(true),
  // Registering device's per-device secret so only that device can manage the
  // shop's listings (no auth). Never sent to clients. Null for legacy vendors.
  ownerKey: text("owner_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const nurseryRatingsTable = pgTable("nursery_ratings", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => nurseryVendorsTable.id),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  raterName: text("rater_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const nurseryListingsTable = pgTable("nursery_listings", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("nursery"),
  vendorId: integer("vendor_id").notNull().references(() => nurseryVendorsTable.id),
  name: text("name").notNull(),
  category: text("category").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  unit: text("unit").notNull().default("plant"),
  qtyAvailable: integer("qty_available").notNull().default(0),
  description: text("description"),
  photoUrl: text("photo_url"),
  isAvailable: boolean("is_available").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const produceListingsTable = pgTable("produce_listings", {
  id: serial("id").primaryKey(),
  sellerName: text("seller_name").notNull(),
  phone: text("phone").notNull(),
  whatsapp: text("whatsapp"),
  productName: text("product_name").notNull(),
  category: text("category").notNull().default("other"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  unit: text("unit").notNull().default("kg"),
  quantity: text("quantity"),
  location: text("location").notNull(),
  description: text("description"),
  photoUrl: text("photo_url"),
  isAvailable: boolean("is_available").notNull().default(true),
  // Poster's per-device secret so they can delete their own ad later (no auth).
  // Never sent to clients; deletes must present the same key.
  ownerKey: text("owner_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProduceListingSchema = createInsertSchema(produceListingsTable).omit({ id: true, createdAt: true });
export type ProduceListing = typeof produceListingsTable.$inferSelect;
export type InsertProduceListing = z.infer<typeof insertProduceListingSchema>;

// Open, OLX-style classifieds for farm equipment (tractors, spray pumps, etc.).
// Anyone can post a listing (new or used) and buyers contact them directly — no
// in-app payment, no auth, and (unlike produce) no subscription gate: it is a
// community board. Global (not estate-scoped) so every farmer sees every ad.
export const equipmentListingsTable = pgTable("equipment_listings", {
  id: serial("id").primaryKey(),
  sellerName: text("seller_name").notNull(),
  phone: text("phone").notNull(),
  whatsapp: text("whatsapp"),
  title: text("title").notNull(),
  category: text("category").notNull().default("other"),
  condition: text("condition").notNull().default("used"),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  location: text("location").notNull(),
  description: text("description"),
  photoUrl: text("photo_url"),
  isAvailable: boolean("is_available").notNull().default(true),
  // Poster's per-device secret so they can delete their own ad later (no auth).
  // Never sent to clients; deletes must present the same key.
  ownerKey: text("owner_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEquipmentListingSchema = createInsertSchema(equipmentListingsTable).omit({ id: true, createdAt: true });
export type EquipmentListing = typeof equipmentListingsTable.$inferSelect;
export type InsertEquipmentListing = z.infer<typeof insertEquipmentListingSchema>;

// Open, OLX-style "Hire" board with two sides discriminated by listingType:
//  - "rental": machines/vehicles for rent (tractor, JCB/Hitachi, auto/tempo, pickup,
//     harvester/cutting, weight machine, sprayer…) posted by owners/drivers.
//  - "job": farm owners posting the workers they need (MP/Assam/local workers, mestri,
//     manager/writer…). People browse and contact the poster directly.
// Global (not estate-scoped) so every user sees every ad; no auth, no subscription gate.
// Optional latitude/longitude let the client compute distance for a nearby-radius filter.
export const hireListingsTable = pgTable("hire_listings", {
  id: serial("id").primaryKey(),
  listingType: text("listing_type").notNull().default("rental"),
  category: text("category").notNull().default("other"),
  title: text("title").notNull(),
  posterName: text("poster_name").notNull(),
  phone: text("phone").notNull(),
  whatsapp: text("whatsapp"),
  district: text("district").notNull(),
  taluk: text("taluk"),
  village: text("village"),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  rate: text("rate"),
  workersNeeded: integer("workers_needed"),
  description: text("description"),
  photoUrl: text("photo_url"),
  // Random per-device secret set at creation. Lets the poster delete their own ad
  // without any login: the client keeps the key in localStorage and must present
  // it to delete. Never returned in API responses.
  ownerKey: text("owner_key"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertHireListingSchema = createInsertSchema(hireListingsTable).omit({ id: true, createdAt: true });
export type HireListing = typeof hireListingsTable.$inferSelect;
export type InsertHireListing = z.infer<typeof insertHireListingSchema>;

// Logs every AI disease diagnosis (photo + result + the farmer's later feedback)
// so the diagnosis quality can be reviewed and improved over time.
export const diseaseDiagnosesTable = pgTable("disease_diagnoses", {
  id: serial("id").primaryKey(),
  cropType: text("crop_type"),
  // The analyzed photo (base64 data URL). Nullable: very large photos are skipped
  // server-side to avoid bloating the DB, but the diagnosis row is still kept.
  photoUrl: text("photo_url"),
  diseaseName: text("disease_name").notNull(),
  confidence: text("confidence").notNull(),
  isDisease: boolean("is_disease").notNull().default(false),
  urgency: text("urgency"),
  // Full structured AI result, kept for later model/quality review.
  result: jsonb("result"),
  // Farmer feedback on the diagnosis: "helpful" | "not-helpful" | "agronomist-confirmed".
  outcome: text("outcome"),
  outcomeNote: text("outcome_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DiseaseDiagnosis = typeof diseaseDiagnosesTable.$inferSelect;

// Records every time two devices updated the same record (e.g. attendance for the
// same worker/group/day) and last-write-wins replaced an earlier value. The data
// is never lost silently — the owner can review what changed and who changed it.
export const syncConflictsTable = pgTable("sync_conflicts", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(), // e.g. "attendance"
  entityId: integer("entity_id"),
  workGroupId: integer("work_group_id"),
  summary: text("summary").notNull(),
  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),
  previousDevice: text("previous_device"),
  newDevice: text("new_device"),
  resolution: text("resolution").notNull().default("last-write-wins"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SyncConflict = typeof syncConflictsTable.$inferSelect;

// ── Helpline: questions & suggestions farmers send to the Chiguru team ─────────
export const helpMessagesTable = pgTable("help_messages", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").notNull(),
  type: text("type").notNull().default("question"), // "question" | "suggestion"
  message: text("message").notNull(),
  phone: text("phone"), // optional callback number
  status: text("status").notNull().default("open"), // "open" | "replied"
  reply: text("reply"),
  repliedAt: timestamp("replied_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type HelpMessage = typeof helpMessagesTable.$inferSelect;

export const insertNurseryVendorSchema = createInsertSchema(nurseryVendorsTable).omit({ id: true, createdAt: true });
export const insertNurseryListingSchema = createInsertSchema(nurseryListingsTable).omit({ id: true, createdAt: true });
export const insertNurseryRatingSchema = createInsertSchema(nurseryRatingsTable).omit({ id: true, createdAt: true });
export type NurseryVendor = typeof nurseryVendorsTable.$inferSelect;
export type NurseryListing = typeof nurseryListingsTable.$inferSelect;
export type NurseryRating = typeof nurseryRatingsTable.$inferSelect;
export type InsertNurseryVendor = z.infer<typeof insertNurseryVendorSchema>;
export type InsertNurseryListing = z.infer<typeof insertNurseryListingSchema>;
export type InsertNurseryRating = z.infer<typeof insertNurseryRatingSchema>;

// ── Mandi (local market) prices — AI-fetched ─────────────────────────────────
// Prices are NOT entered by hand. Every morning (first open of the day) the
// server searches the internet with AI — government/APMC mandi rates, curing
// works' published rates, vendor websites and social pages — scoped to the
// estate's district and state, and caches what it found here.
export const mandiDailyPricesTable = pgTable("mandi_daily_prices", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  date: date("date").notNull(),
  crop: text("crop").notNull(),
  sellerName: text("seller_name").notNull(),
  // Mandi / Curing works / Local buyer / Exporter / Trader / Government
  sellerType: text("seller_type").notNull().default("Mandi"),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  priceMin: numeric("price_min", { precision: 12, scale: 2 }),
  priceMax: numeric("price_max", { precision: 12, scale: 2 }),
  unit: text("unit").notNull().default("per kg"),
  location: text("location"),
  phone: text("phone"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  // Extra buying terms a source states — e.g. coffee outturn rate ("OT 48%"),
  // moisture limits, grade conditions.
  notes: text("notes"),
  // The actual date the quote is for (YYYY-MM-DD) so the UI can show a plain
  // "Today" / "N days old" freshness tag instead of a confusing paragraph.
  priceDate: date("price_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One fetch attempt per estate per day (status: pending / done / error), so the
// AI search runs once each morning instead of on every page load.
export const mandiFetchLogTable = pgTable("mandi_fetch_log", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  date: date("date").notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mandi_fetch_log_estate_day_unique").on(t.estateId, t.date),
]);

// ── Account device limit ─────────────────────────────────────────────────────
// Each signed-in Owner account may be active on at most 2 devices at a time.
// Every device registers itself here; a 3rd device is blocked until one of the
// existing ones is logged out.
export const userDevicesTable = pgTable("user_devices", {
  id: serial("id").primaryKey(),
  // Holds the Owner's numeric id (as a string) — column kept as "clerk_user_id"
  // to avoid an extra migration, but it's an Owner id now, not a Clerk one.
  clerkUserId: text("clerk_user_id").notNull(),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name"),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("user_devices_user_device_unique").on(t.clerkUserId, t.deviceId),
]);

export const insertUserDeviceSchema = createInsertSchema(userDevicesTable).omit({ id: true, createdAt: true, lastSeenAt: true });
export type UserDevice = typeof userDevicesTable.$inferSelect;
export type InsertUserDevice = z.infer<typeof insertUserDeviceSchema>;

export const insertMandiDailyPriceSchema = createInsertSchema(mandiDailyPricesTable).omit({ id: true, createdAt: true });
export type MandiDailyPrice = typeof mandiDailyPricesTable.$inferSelect;
export type InsertMandiDailyPrice = z.infer<typeof insertMandiDailyPriceSchema>;
export type MandiFetchLog = typeof mandiFetchLogTable.$inferSelect;

// Direct payments from the owner to a worker or a work group (weekly wages,
// final settlement, advances paid digitally, etc.). The app never moves money
// itself — for UPI it opens the owner's own payment app (PhonePe/GPay/any)
// via a upi:// deep link and the owner completes the payment there; this
// table is the farm's own ledger of what was paid, how, and to whom.
export const workerPaymentsTable = pgTable("worker_payments", {
  id: serial("id").primaryKey(),
  estateId: integer("estate_id").references(() => farmProfileTable.id),
  workerId: integer("worker_id").references(() => workersTable.id),
  workGroupId: integer("work_group_id").references(() => workGroupsTable.id),
  payeeName: text("payee_name").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  // cash | upi | bank | wallet | other (label shown in `methodLabel`)
  method: text("method").notNull(),
  methodLabel: text("method_label"),
  // Payee handle used for this payment (UPI ID / wallet number), for the record.
  payeeHandle: text("payee_handle"),
  paymentDate: date("payment_date").notNull(),
  note: text("note"),
  // Idempotency key from the offline queue (localId): a replayed/retried POST
  // returns the already-committed row instead of duplicating a money record.
  clientId: text("client_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  clientIdUnique: uniqueIndex("worker_payments_client_id_unique").on(t.clientId),
}));

export const insertFarmProfileSchema = createInsertSchema(farmProfileTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCropSchema = createInsertSchema(cropsTable).omit({ id: true, createdAt: true });
export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertWorkGroupSchema = createInsertSchema(workGroupsTable).omit({ id: true, createdAt: true });
export const insertAttendanceSchema = createInsertSchema(attendanceTable).omit({ id: true, createdAt: true });
export const insertDailyWorkSchema = createInsertSchema(dailyWorkTable).omit({ id: true, createdAt: true });
export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true });
export const insertSpraySchema = createInsertSchema(spraysTable).omit({ id: true, createdAt: true });
export const insertHarvestSchema = createInsertSchema(harvestsTable).omit({ id: true, createdAt: true });
export const insertLoanSchema = createInsertSchema(loansTable).omit({ id: true, createdAt: true });
export const insertLoanPaymentSchema = createInsertSchema(loanPaymentsTable).omit({ id: true, createdAt: true });
export const insertWorkerPaymentSchema = createInsertSchema(workerPaymentsTable).omit({ id: true, createdAt: true });

export type FarmProfile = typeof farmProfileTable.$inferSelect;
export type Crop = typeof cropsTable.$inferSelect;
export type Worker = typeof workersTable.$inferSelect;
export type WorkGroup = typeof workGroupsTable.$inferSelect;
export type Attendance = typeof attendanceTable.$inferSelect;
export type DailyWork = typeof dailyWorkTable.$inferSelect;
export type Expense = typeof expensesTable.$inferSelect;
export type Spray = typeof spraysTable.$inferSelect;
export type Harvest = typeof harvestsTable.$inferSelect;
export type Loan = typeof loansTable.$inferSelect;
export type LoanPayment = typeof loanPaymentsTable.$inferSelect;
export type WorkerPayment = typeof workerPaymentsTable.$inferSelect;
export type Block = typeof blocksTable.$inferSelect;
export type EstateUpdate = typeof estateUpdatesTable.$inferSelect;
export const insertEstateUpdateSchema = createInsertSchema(estateUpdatesTable).omit({ id: true, createdAt: true });
export type InsertEstateUpdate = z.infer<typeof insertEstateUpdateSchema>;

export const insertAgronomistSchema = createInsertSchema(agronomistsTable).omit({ id: true, createdAt: true });
export const insertConsultationSchema = createInsertSchema(consultationsTable).omit({ id: true, startedAt: true });
export const insertConsultationMessageSchema = createInsertSchema(consultationMessagesTable).omit({ id: true, createdAt: true });
export const insertAppSettingsSchema = createInsertSchema(appSettingsTable).omit({ id: true, createdAt: true });
export type Agronomist = typeof agronomistsTable.$inferSelect;
export type Consultation = typeof consultationsTable.$inferSelect;
export type ConsultationMessage = typeof consultationMessagesTable.$inferSelect;
export type AppSettings = typeof appSettingsTable.$inferSelect;
export type InsertAgronomist = z.infer<typeof insertAgronomistSchema>;
export type InsertConsultation = z.infer<typeof insertConsultationSchema>;
export type InsertConsultationMessage = z.infer<typeof insertConsultationMessageSchema>;
export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;

export type InsertFarmProfile = z.infer<typeof insertFarmProfileSchema>;
export type InsertCrop = z.infer<typeof insertCropSchema>;
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
export type InsertWorkGroup = z.infer<typeof insertWorkGroupSchema>;
export type InsertAttendance = z.infer<typeof insertAttendanceSchema>;
export type InsertDailyWork = z.infer<typeof insertDailyWorkSchema>;
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type InsertSpray = z.infer<typeof insertSpraySchema>;
export type InsertHarvest = z.infer<typeof insertHarvestSchema>;
export type InsertLoan = z.infer<typeof insertLoanSchema>;
export type InsertLoanPayment = z.infer<typeof insertLoanPaymentSchema>;
export type InsertBlock = z.infer<typeof insertBlockSchema>;
