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
  tagline: string;
  /** null = unlimited estates */
  maxEstates: number | null;
  /** Manager devices bundled with this plan (before any add-on purchases). */
  maxManagerDevices: number;
}

// Three simple, honest plans (plus a 30-day free trial of full features).
// Every plan unlocks EVERYTHING — attendance, work updates, expenses, harvest,
// profit & loss, Agri Doctor consults and selling on Chiguru — and bundles
// estates and manager devices. The tiers differ only in how many of each:
//   • Farmer — ₹399/month: 2 estates, 2 manager devices.
//   • Planter — ₹699/month: 5 estates, 5 manager devices.
//   • Company Estate — ₹999/month: unlimited estates, 5 manager devices.
export const PLANS: Record<string, Plan> = {
  farmer: {
    id: "farmer",
    name: "Farmer",
    amount: 399,
    billingCycle: "monthly",
    tagline: "Attendance + AI count, advances + loans, profit/loss, Agri Doctor, sell + works offline.",
    maxEstates: 2,
    maxManagerDevices: 2,
  },
  planter: {
    id: "planter",
    name: "Planter",
    amount: 699,
    billingCycle: "monthly",
    tagline: "Everything in Farmer, for a growing plantation with more estates and devices.",
    maxEstates: 5,
    maxManagerDevices: 5,
  },
  company: {
    id: "company",
    name: "Company Estate",
    amount: 999,
    billingCycle: "monthly",
    tagline: "For companies and large estates — unlimited estates included.",
    maxEstates: null,
    maxManagerDevices: 5,
  },
};

export function planById(id: string): Plan | undefined {
  return PLANS[id];
}

/** Extra estate on top of any plan's bundled allowance. */
export const ESTATE_ADDON = { amount: 199 };
/** Extra manager device on top of any plan's bundled allowance. */
export const MANAGER_DEVICE_ADDON = { amount: 199 };

/**
 * Inline recurring price for a Stripe subscription-mode Checkout Session —
 * avoids needing a Price object pre-created in the Stripe Dashboard for every
 * plan/add-on, so a rename or price change here takes effect immediately.
 */
export function inlinePrice(amount: number, productName: string): Stripe.Checkout.SessionCreateParams.LineItem.PriceData {
  return {
    currency: "inr",
    unit_amount: Math.round(amount * 100),
    recurring: { interval: "month" },
    product_data: { name: productName },
  };
}
