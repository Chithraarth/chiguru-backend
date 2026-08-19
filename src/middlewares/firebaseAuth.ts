import type { NextFunction, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { db, ownersTable, managersTable, type Owner, type ManagerRow } from "../db";
import { firebaseAuth } from "../lib/firebase-admin";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in Owner, if the request carried a valid Firebase ID token. */
      owner?: Owner;
      /** The signed-in Manager, if the token belongs to an invited manager phone. */
      manager?: ManagerRow;
    }
  }
}

/**
 * Verifies a Firebase ID token (Authorization: Bearer <token>) if present.
 *
 * A single phone number can legitimately be an Owner on their own farm AND,
 * separately, an invited Manager on someone else's farm — so this attaches
 * BOTH req.owner and req.manager whenever both exist, rather than picking
 * one. Which identity a request actually acts as is decided per-route by
 * requireOwner/requireManager below (the Owner apps only ever call
 * owner-gated routes; the Manager apps only ever call manager-gated ones),
 * not by this middleware guessing.
 *
 * Never blocks the request itself — an invalid/missing token, or one that
 * matches neither, just leaves req.owner/req.manager unset.
 */
export async function firebaseAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return next();

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);

    const [existing] = await db
      .select()
      .from(ownersTable)
      .where(eq(ownersTable.firebaseUid, decoded.uid));

    const [linkedManager] = await db
      .select()
      .from(managersTable)
      .where(and(eq(managersTable.firebaseUid, decoded.uid), eq(managersTable.status, "active")));
    if (linkedManager) {
      req.manager = linkedManager;
    } else if (decoded.phone_number) {
      const [pendingInvite] = await db
        .select()
        .from(managersTable)
        .where(and(eq(managersTable.phone, decoded.phone_number), eq(managersTable.status, "pending")))
        .orderBy(managersTable.createdAt);
      if (pendingInvite) {
        const [activated] = await db
          .update(managersTable)
          .set({ firebaseUid: decoded.uid, status: "active", activatedAt: new Date() })
          .where(eq(managersTable.id, pendingInvite.id))
          .returning();
        req.manager = activated;
      }
    }

    if (existing) {
      const [updated] = await db
        .update(ownersTable)
        .set({
          lastLogin: new Date(),
          // Keep profile fields fresh in case the farmer updated their name/photo
          // with the provider, or verified an email/phone since we last saw them.
          fullName: decoded.name ?? existing.fullName,
          email: decoded.email ?? existing.email,
          mobileNumber: decoded.phone_number ?? existing.mobileNumber,
          profileImage: decoded.picture ?? existing.profileImage,
        })
        .where(eq(ownersTable.id, existing.id))
        .returning();
      req.owner = updated;
    } else if (!req.manager) {
      // Only auto-create an Owner account for a UID with no Owner row of its
      // own AND no Manager identity either — a Manager's very first
      // phone-OTP sign-in must never silently create a bogus Owner account.
      const [created] = await db
        .insert(ownersTable)
        .values({
          firebaseUid: decoded.uid,
          fullName: decoded.name ?? null,
          email: decoded.email ?? null,
          mobileNumber: decoded.phone_number ?? null,
          profileImage: decoded.picture ?? null,
          loginProvider: decoded.firebase?.sign_in_provider ?? null,
          role: "OWNER",
          status: "ACTIVE",
        })
        .returning();
      req.owner = created;
    }
  } catch (err) {
    // Expired/invalid token — treat as signed-out rather than failing the request;
    // requireOwner/requireManager (below) are what actually enforce auth where it matters.
    logger.warn({ err }, "Firebase ID token verification failed");
  }

  next();
}

/** Route guard: 401s if firebaseAuthMiddleware didn't attach a signed-in Owner. */
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.owner) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

/** Route guard: 401s if firebaseAuthMiddleware didn't attach a signed-in Manager. */
export function requireManager(req: Request, res: Response, next: NextFunction) {
  if (!req.manager) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

/** Route guard: allows either an Owner or a Manager acting on that Owner's behalf. */
export function requireOwnerOrManager(req: Request, res: Response, next: NextFunction) {
  if (!req.owner && !req.manager) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

/**
 * The effective Owner id this request is scoped to, whether Owner or
 * Manager. Almost always unambiguous (a token resolves to only one of
 * req.owner/req.manager) — but one phone number can legitimately be an
 * Owner on their own farm AND an invited Manager on someone else's, in
 * which case both are set and only the calling app knows which farm it
 * means. Every client sends X-Actor-Role ("owner" | "manager") precisely so
 * this can disambiguate instead of guessing; an old/missing header falls
 * back to the historical owner-first preference.
 */
export function effectiveOwnerId(req: Request): number | null {
  if (req.owner && req.manager) {
    const role = req.header("X-Actor-Role");
    if (role === "manager") return req.manager.ownerId;
    return req.owner.id;
  }
  return req.owner?.id ?? req.manager?.ownerId ?? null;
}
