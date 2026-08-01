import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY must be set. Did you forget to provision Stripe?");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export interface Plan {
  id: string;
  name: string;
  amount: number; // INR, per billing cycle
  billingCycle: "monthly";
  /** null = unlimited estates */
  maxEstates: number | null;
  managerSeats: number;
  /** Set once the matching Stripe Price is created in the Dashboard. */
  stripePriceId: string | undefined;
}

// Price IDs come from env vars (created once in the Stripe Dashboard against
// these same plans) rather than being hardcoded, since they differ between
// Stripe's test mode and live mode.
export const PLANS: Record<string, Plan> = {
  basic: {
    id: "basic",
    name: "Basic",
    amount: 499,
    billingCycle: "monthly",
    maxEstates: 1,
    managerSeats: 0,
    stripePriceId: process.env.STRIPE_PRICE_BASIC,
  },
  premium: {
    id: "premium",
    name: "Premium",
    amount: 999,
    billingCycle: "monthly",
    maxEstates: null,
    managerSeats: 2,
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    amount: 1999,
    billingCycle: "monthly",
    maxEstates: null,
    managerSeats: 10,
    stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE,
  },
};

export function planById(id: string): Plan | undefined {
  return PLANS[id];
}

/** One additional manager seat, billed monthly alongside the plan. */
export const MANAGER_SEAT_ADDON = {
  amount: 199,
  stripePriceId: process.env.STRIPE_PRICE_MANAGER_SEAT,
};
