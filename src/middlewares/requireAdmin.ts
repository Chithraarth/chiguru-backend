import type { NextFunction, Request, Response } from "express";

/**
 * Chiguru staff only (owners.role = 'ADMIN', set directly in the database).
 * Doctor earnings, payouts and nursery moderation are operations work, not
 * something any farmer account may do. Run after requireOwner.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.owner?.role !== "ADMIN") {
    res.status(403).json({ message: "Only Chiguru admins can do this.", code: "ADMIN_ONLY" });
    return;
  }
  next();
}

export function isAdmin(req: Request): boolean {
  return req.owner?.role === "ADMIN";
}
