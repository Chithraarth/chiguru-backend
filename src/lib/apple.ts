import {
  Environment,
  SignedDataVerifier,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTS } from "./apple-root-certs";
import { logger } from "./logger";

/**
 * Apple In-App Purchase (StoreKit 2) verification.
 *
 * The iOS app never tells us "I paid" — it sends the JWS-signed transaction
 * StoreKit gave it, and we verify Apple's signature chain (up to Apple Root
 * CA G3) locally before trusting a single field. App Store Server
 * Notifications V2 are verified the same way. No App Store Server API key is
 * needed for this.
 *
 * Env:
 *  - APPLE_BUNDLE_ID   (default com.thechiguru.owner)
 *  - APPLE_APP_ID      numeric App Store app id (App Store Connect → App
 *                      Information → Apple ID). Required by Apple's library
 *                      to verify PRODUCTION data; until it's set only
 *                      Sandbox/TestFlight purchases verify.
 */
export const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.thechiguru.owner";
const APPLE_APP_ID = process.env.APPLE_APP_ID ? Number(process.env.APPLE_APP_ID) : undefined;

// ── Products (must match App Store Connect exactly) ──────────────────────────
// Subscriptions are DB-driven: subscription_plans.apple_product_id.
/** Wallet credit packs (consumables): product id → rupees credited. */
export const APPLE_WALLET_PACKS: Record<string, number> = {
  "com.thechiguru.owner.wallet.299": 299,
  "com.thechiguru.owner.wallet.499": 499,
  "com.thechiguru.owner.wallet.999": 999,
};
/** One extra invitee seat (consumable, one-time). */
export const APPLE_SEAT_PRODUCT_ID = "com.thechiguru.owner.invitee_seat";

const verifiers: { env: Environment; verifier: SignedDataVerifier }[] = [];
if (APPLE_APP_ID) {
  verifiers.push({ env: Environment.PRODUCTION, verifier: new SignedDataVerifier(APPLE_ROOT_CERTS, true, Environment.PRODUCTION, APPLE_BUNDLE_ID, APPLE_APP_ID) });
} else {
  logger.warn("APPLE_APP_ID is not set - only Sandbox/TestFlight Apple purchases can be verified");
}
verifiers.push({ env: Environment.SANDBOX, verifier: new SignedDataVerifier(APPLE_ROOT_CERTS, true, Environment.SANDBOX, APPLE_BUNDLE_ID) });

export class AppleVerificationError extends Error {
  status = 400;
  code = "APPLE_VERIFICATION_FAILED";
}

/** Tries Production first, then Sandbox (TestFlight and sandbox testers buy in Sandbox). */
async function firstVerified<T>(fn: (v: SignedDataVerifier) => Promise<T>): Promise<{ data: T; env: Environment }> {
  let lastErr: unknown;
  for (const { env, verifier } of verifiers) {
    try {
      return { data: await fn(verifier), env };
    } catch (err) {
      lastErr = err;
    }
  }
  logger.warn({ err: lastErr }, "Apple signed data failed verification in every environment");
  throw new AppleVerificationError("Apple couldn't confirm this purchase. Please try again.");
}

export async function verifyAppleTransaction(signedTransaction: string): Promise<JWSTransactionDecodedPayload & { verifiedEnv: Environment }> {
  if (!signedTransaction || typeof signedTransaction !== "string") throw new AppleVerificationError("signedTransaction is required");
  const { data, env } = await firstVerified((v) => v.verifyAndDecodeTransaction(signedTransaction));
  return { ...data, verifiedEnv: env };
}

export async function verifyAppleRenewalInfo(signedRenewalInfo: string): Promise<JWSRenewalInfoDecodedPayload> {
  return (await firstVerified((v) => v.verifyAndDecodeRenewalInfo(signedRenewalInfo))).data;
}

export async function verifyAppleNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload> {
  if (!signedPayload || typeof signedPayload !== "string") throw new AppleVerificationError("signedPayload is required");
  return (await firstVerified((v) => v.verifyAndDecodeNotification(signedPayload))).data;
}

/** Payments-table key for an Apple transaction (globally unique across owners). */
export const applePaymentKey = (transactionId: string) => `apple:${transactionId}`;
