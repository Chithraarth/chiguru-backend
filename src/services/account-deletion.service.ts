import { eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import {
  appSettingsTable,
  attendanceTable,
  blocksTable,
  consultationMessagesTable,
  consultationsTable,
  cropsTable,
  dailyWorkTable,
  equipmentListingsTable,
  estateUpdatesTable,
  expensesTable,
  farmProfileTable,
  groupAdvancePaymentsTable,
  groupWorkSessionsTable,
  harvestsTable,
  helpMessagesTable,
  hireListingsTable,
  loanPaymentsTable,
  loansTable,
  managersTable,
  mandiDailyPricesTable,
  mandiFetchLogTable,
  nurseryListingsTable,
  nurseryRatingsTable,
  nurseryVendorsTable,
  ownersTable,
  paymentsTable,
  planTasksTable,
  produceListingsTable,
  pushDevicesTable,
  spraysTable,
  subscriptionsTable,
  syncConflictsTable,
  userDevicesTable,
  walletBalancesTable,
  walletTransactionsTable,
  workerPaymentsTable,
  workersTable,
  workGroupsTable,
} from "../db/schema";
import { firebaseAuth } from "../lib/firebase-admin";
import { logger } from "../lib/logger";
import { getCurrentSubscription, isSubActive } from "./entitlement.service";
import { cancel as cancelSubscription } from "./subscription.service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Removes one estate and everything recorded under it. None of the foreign
 * keys cascade, so children go first, in dependency order. Photos and receipts
 * are stored inline in these rows, so they go with them.
 */
export async function deleteEstateData(tx: Tx, estateId: number) {
  const groupIds = tx.select({ id: workGroupsTable.id }).from(workGroupsTable).where(eq(workGroupsTable.estateId, estateId));
  const cropIds = tx.select({ id: cropsTable.id }).from(cropsTable).where(eq(cropsTable.estateId, estateId));
  const workerIds = tx.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.estateId, estateId));
  const loanIds = tx.select({ id: loansTable.id }).from(loansTable).where(eq(loansTable.estateId, estateId));

  // Attendance and labour payments reference both the estate's groups and its workers.
  await tx.delete(attendanceTable).where(inArray(attendanceTable.workGroupId, groupIds));
  await tx.delete(attendanceTable).where(inArray(attendanceTable.workerId, workerIds));
  await tx
    .delete(workerPaymentsTable)
    .where(
      or(
        eq(workerPaymentsTable.estateId, estateId),
        inArray(workerPaymentsTable.workGroupId, groupIds),
        inArray(workerPaymentsTable.workerId, workerIds),
      ),
    );
  await tx.delete(dailyWorkTable).where(inArray(dailyWorkTable.workGroupId, groupIds));
  await tx.delete(groupAdvancePaymentsTable).where(inArray(groupAdvancePaymentsTable.workGroupId, groupIds));
  await tx
    .delete(groupWorkSessionsTable)
    .where(or(eq(groupWorkSessionsTable.estateId, estateId), inArray(groupWorkSessionsTable.workGroupId, groupIds)));
  await tx.delete(syncConflictsTable).where(inArray(syncConflictsTable.workGroupId, groupIds));
  // Loans chain: payments -> loans -> workers. Detach any stray loans that
  // point at this estate's groups first, then delete the estate's own loans.
  await tx.delete(loanPaymentsTable).where(inArray(loanPaymentsTable.loanId, loanIds));
  await tx.update(loansTable).set({ workGroupId: null }).where(inArray(loansTable.workGroupId, groupIds));
  await tx.delete(loansTable).where(eq(loansTable.estateId, estateId));
  // Harvests reference work groups, so they must go before the groups do.
  await tx.delete(harvestsTable).where(eq(harvestsTable.estateId, estateId));
  await tx.delete(workGroupsTable).where(eq(workGroupsTable.estateId, estateId));
  await tx.delete(workersTable).where(eq(workersTable.estateId, estateId));

  await tx.delete(planTasksTable).where(or(eq(planTasksTable.estateId, estateId), inArray(planTasksTable.cropId, cropIds)));
  await tx.delete(blocksTable).where(inArray(blocksTable.cropId, cropIds));
  await tx.delete(spraysTable).where(eq(spraysTable.estateId, estateId));
  await tx.delete(expensesTable).where(eq(expensesTable.estateId, estateId));
  await tx.delete(estateUpdatesTable).where(eq(estateUpdatesTable.estateId, estateId));
  await tx.delete(cropsTable).where(eq(cropsTable.estateId, estateId));

  await tx.delete(mandiDailyPricesTable).where(eq(mandiDailyPricesTable.estateId, estateId));
  await tx.delete(mandiFetchLogTable).where(eq(mandiFetchLogTable.estateId, estateId));
  await tx.delete(pushDevicesTable).where(eq(pushDevicesTable.estateId, estateId));
  await tx.delete(helpMessagesTable).where(eq(helpMessagesTable.estateId, estateId));
  // Everyone invited onto this estate loses access with it.
  await tx.delete(managersTable).where(eq(managersTable.estateId, estateId));

  await tx.delete(farmProfileTable).where(eq(farmProfileTable.id, estateId));
}

/**
 * Permanently deletes an Owner's account and everything in it (App Store
 * guideline 5.1.1(v); same behaviour on Android and the web): every estate
 * they own with all its records, their invitee memberships on other farms,
 * subscriptions, payments, wallet, Agri Doctor consultations, devices, their
 * classified listings (matched by the device's owner key), and finally the
 * Firebase sign-in itself.
 *
 * A Razorpay auto-renewal is cancelled first so a deleted account is never
 * charged again. Apple and Google subscriptions can only be cancelled by the
 * subscriber in their store account — the apps warn about that before
 * calling this.
 */
export async function deleteOwnerAccount(ownerId: number, opts: { ownerKey?: string | null } = {}) {
  const [owner] = await db.select().from(ownersTable).where(eq(ownersTable.id, ownerId));
  if (!owner) return;

  const sub = await getCurrentSubscription(ownerId);
  if (sub && sub.provider === "RAZORPAY" && isSubActive(sub) && sub.autoRenew) {
    await cancelSubscription(ownerId).catch((err) =>
      logger.warn({ err, ownerId }, "Account deletion: Razorpay cancel failed, continuing"),
    );
  }

  await db.transaction(async (tx) => {
    const estates = await tx.select({ id: farmProfileTable.id }).from(farmProfileTable).where(eq(farmProfileTable.ownerId, ownerId));
    for (const { id } of estates) await deleteEstateData(tx, id);

    // Their invitee memberships on other people's farms, and invitees on theirs.
    await tx.delete(managersTable).where(or(eq(managersTable.ownerId, ownerId), eq(managersTable.firebaseUid, owner.firebaseUid)));

    const consultationIds = tx.select({ id: consultationsTable.id }).from(consultationsTable).where(eq(consultationsTable.ownerId, ownerId));
    await tx.delete(consultationMessagesTable).where(inArray(consultationMessagesTable.consultationId, consultationIds));
    await tx.delete(consultationsTable).where(eq(consultationsTable.ownerId, ownerId));

    await tx.delete(paymentsTable).where(eq(paymentsTable.ownerId, ownerId));
    await tx.delete(subscriptionsTable).where(eq(subscriptionsTable.ownerId, ownerId));
    await tx.delete(walletTransactionsTable).where(eq(walletTransactionsTable.ownerId, ownerId));
    await tx.delete(walletBalancesTable).where(eq(walletBalancesTable.ownerId, ownerId));
    await tx.delete(appSettingsTable).where(eq(appSettingsTable.ownerId, ownerId));
    await tx.delete(userDevicesTable).where(eq(userDevicesTable.clerkUserId, String(ownerId)));

    if (opts.ownerKey) {
      const vendorIds = tx.select({ id: nurseryVendorsTable.id }).from(nurseryVendorsTable).where(eq(nurseryVendorsTable.ownerKey, opts.ownerKey));
      await tx.delete(nurseryListingsTable).where(inArray(nurseryListingsTable.vendorId, vendorIds));
      await tx.delete(nurseryRatingsTable).where(inArray(nurseryRatingsTable.vendorId, vendorIds));
      await tx.delete(nurseryVendorsTable).where(eq(nurseryVendorsTable.ownerKey, opts.ownerKey));
      await tx.delete(produceListingsTable).where(eq(produceListingsTable.ownerKey, opts.ownerKey));
      await tx.delete(equipmentListingsTable).where(eq(equipmentListingsTable.ownerKey, opts.ownerKey));
      await tx.delete(hireListingsTable).where(eq(hireListingsTable.ownerKey, opts.ownerKey));
    }

    await tx.delete(ownersTable).where(eq(ownersTable.id, ownerId));
  });

  // Last, so a failed database delete never leaves someone unable to sign in
  // to an account that still exists.
  try {
    await firebaseAuth.deleteUser(owner.firebaseUid);
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") {
      logger.error({ err, ownerId }, "Account deletion: Firebase user delete failed");
    }
  }
  logger.info({ ownerId }, "ACCOUNT_DELETED");
}
