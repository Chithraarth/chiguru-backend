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
 * Managers are checked FIRST: if the token's UID is already linked to a
 * managers row, or its phone number matches a still-"pending" invite from an
 * Owner, this request is a Manager — req.manager is attached and we return
 * without ever touching the owners table. This matters because a manager's
 * very first phone-OTP sign-in would otherwise fall through to the Owner
 * upsert below and silently create a bogus Owner account for them.
 *
 * Otherwise this is a normal Owner sign-in (email/Google/Facebook/phone) and
 * the existing upsert-on-every-request behavior applies unchanged.
 *
 * Never blocks the request itself — an invalid/missing token, or one that
 * matches neither, just leaves req.owner/req.manager unset; routes that
 * require one use requireOwner/requireManager below.
 */
export async function firebaseAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return next();

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);

    // Owner identity always wins: the same phone number can be both a farm's
    // own Owner and, separately, invited as a Manager on someone else's farm
    // (e.g. an Owner helping test the pairing flow). If this UID already has
    // an Owner row, this request is that Owner — full stop — even if it's
    // also an active/pending Manager elsewhere. Only a UID with no Owner row
    // of its own falls through to the Manager checks below.
    const [existing] = await db
      .select()
      .from(ownersTable)
      .where(eq(ownersTable.firebaseUid, decoded.uid));

    if (!existing) {
      const [linkedManager] = await db
        .select()
        .from(managersTable)
        .where(and(eq(managersTable.firebaseUid, decoded.uid), eq(managersTable.status, "active")));
      if (linkedManager) {
        req.manager = linkedManager;
        return next();
      }

      if (decoded.phone_number) {
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
          return next();
        }
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
    } else {
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

/** The effective Owner id this request is scoped to, whether Owner or Manager. */
export function effectiveOwnerId(req: Request): number | null {
  return req.owner?.id ?? req.manager?.ownerId ?? null;
}
