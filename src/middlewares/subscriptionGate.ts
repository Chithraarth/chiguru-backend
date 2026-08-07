import type { NextFunction, Request, Response } from "express";
import { effectiveOwnerId } from "./firebaseAuth";
import { isSubscriptionActive } from "../services/entitlement.service";

export { isSubscriptionActive as hasActiveSubscription };

/**
 * Route guard for anything that requires a paid plan: farm data entry
 * (attendance, Farm Accounts), the AI features, Agri Doctor consults, and
 * posting a marketplace/nursery/equipment listing. Works for both a
 * signed-in Owner and a Manager acting on that Owner's behalf — the
 * Owner's own subscription is what's checked either way.
 */
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  const ownerId = effectiveOwnerId(req);
  if (!ownerId) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  if (!(await isSubscriptionActive(ownerId))) {
    res.status(403).json({
      message: "An active subscription is required for this feature.",
      code: "SUBSCRIPTION_REQUIRED",
    });
    return;
  }
  next();
}
