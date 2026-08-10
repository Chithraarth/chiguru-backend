import { google } from "googleapis";

if (!process.env.GOOGLE_PLAY_PACKAGE_NAME) {
  throw new Error("GOOGLE_PLAY_PACKAGE_NAME must be set. Did you forget to provision Google Play Billing?");
}
if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY) {
  throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_KEY must be set. Did you forget to provision Google Play Billing?");
}

export const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME;

// The service account JSON key (Play Console → Setup → API access → link/create
// a service account, grant it "Financial data" access) — stored as a single-line
// JSON string env var, same convention as FIREBASE_PRIVATE_KEY elsewhere.
const credentials = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY) as {
  client_email: string;
  private_key: string;
};

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

const androidpublisher = google.androidpublisher({ version: "v3", auth });

/**
 * Maps Play Billing's subscriptionState to this app's own status vocabulary
 * (the same one Razorpay's webhooks write) — subscriptionsTable.status is
 * provider-agnostic, so both providers normalize into it here.
 */
const STATUS_BY_SUBSCRIPTION_STATE: Record<string, string> = {
  SUBSCRIPTION_STATE_ACTIVE: "ACTIVE",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "GRACE_PERIOD",
  SUBSCRIPTION_STATE_ON_HOLD: "ON_HOLD",
  SUBSCRIPTION_STATE_PAUSED: "ON_HOLD",
  SUBSCRIPTION_STATE_CANCELED: "CANCELLED",
  SUBSCRIPTION_STATE_EXPIRED: "EXPIRED",
  SUBSCRIPTION_STATE_PENDING: "PENDING",
};

export interface GooglePlaySubscriptionState {
  status: string;
  productId: string | null;
  expiryTime: Date | null;
  latestOrderId: string | null;
  autoRenewing: boolean;
}

/**
 * Re-fetches the authoritative subscription state from Google's own API —
 * never trusts a purchase token's claimed state from the client or from an
 * RTDN notification payload, same principle as Razorpay's
 * `razorpay.subscriptions.fetch` re-check.
 */
export async function fetchSubscriptionState(purchaseToken: string): Promise<GooglePlaySubscriptionState> {
  const res = await androidpublisher.purchases.subscriptionsv2.get({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    token: purchaseToken,
  });

  const data = res.data;
  const lineItem = data.lineItems?.[0];
  const state = data.subscriptionState ?? "";

  return {
    status: STATUS_BY_SUBSCRIPTION_STATE[state] ?? "PENDING",
    productId: lineItem?.productId ?? null,
    expiryTime: lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null,
    latestOrderId: data.latestOrderId ?? null,
    autoRenewing: !!lineItem?.autoRenewingPlan?.autoRenewEnabled,
  };
}

/**
 * Google auto-refunds a subscription purchase if it isn't acknowledged
 * within 3 days — this must be called once per purchase token after we've
 * recorded it, separate from (and in addition to) fetchSubscriptionState.
 */
export async function acknowledgePurchase(purchaseToken: string, productId: string): Promise<void> {
  await androidpublisher.purchases.subscriptions.acknowledge({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    subscriptionId: productId,
    token: purchaseToken,
    requestBody: {},
  });
}

/** Google's RTDN push payload — see lib/google-play's handleWebhook caller for how this arrives. */
export interface DeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
}

/** Cloud Pub/Sub wraps the real payload as base64 JSON inside `message.data`. */
export function decodePubSubMessage(rawBody: string): DeveloperNotification | null {
  try {
    const envelope = JSON.parse(rawBody) as { message?: { data?: string } };
    const dataB64 = envelope.message?.data;
    if (!dataB64) return null;
    return JSON.parse(Buffer.from(dataB64, "base64").toString("utf8")) as DeveloperNotification;
  } catch {
    return null;
  }
}
