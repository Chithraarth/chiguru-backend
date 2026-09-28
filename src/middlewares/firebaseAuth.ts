import type { NextFunction, Request, Response } from "express";
import { eq, and, or } from "drizzle-orm";
import { db, ownersTable, managersTable, farmProfileTable, type Owner, type ManagerRow } from "../db";
import { firebaseAuth } from "../lib/firebase-admin";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in Owner, if the request carried a valid Firebase ID token. */
      owner?: Owner;
      /**
       * Every ACTIVE invite (still called "manager" in the DB) this signed-in
       * person holds — one row per Owner who invited them. Usually 0 or 1,
       * but a person can be invited by several Owners at once, so this is
       * always an array; never assume a single manager identity. Empty array
       * (not undefined) when the token matched no invite, so callers can
       * check `.length` without an extra null-check.
       */
      managers: ManagerRow[];
      /**
       * The Owner id this request resolved to, considering the X-Estate-Id
       * header — computed once here so effectiveOwnerId() can stay a plain
       * synchronous reader for its many call sites. See effectiveOwnerId's
       * own doc comment for the resolution order.
       */
      resolvedOwnerId: number | null;
      /**
       * The verified Firebase token's own identity fields, whenever a valid
       * token was presented — set regardless of whether it resolved to an
       * Owner/invitee yet. Used by routes/invites.ts to find pending invites
       * that match THIS person's phone/email, since a not-yet-accepted
       * invite has no firebaseUid to look it up by.
       */
      firebaseIdentity?: { uid: string; phone: string | null; email: string | null };
    }
  }
}

/**
 * Verifies a Firebase ID token (Authorization: Bearer <token>) if present.
 *
 * A single person can legitimately be an Owner on their own farm AND,
 * separately, hold invites from one or more other Owners — so this attaches
 * req.owner and req.managers (plural) independently, rather than picking
 * one. Which identity/estate a request actually acts as is resolved by
 * effectiveOwnerId() below, using the X-Estate-Id header the client sends
 * once the person has chosen which estate they're working in.
 *
 * Never blocks the request itself — an invalid/missing token, or one that
 * matches neither, just leaves req.owner unset and req.managers empty.
 */
export async function firebaseAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.managers = [];
  req.resolvedOwnerId = null;
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return next();

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    req.firebaseIdentity = {
      uid: decoded.uid,
      phone: decoded.phone_number ?? null,
      email: decoded.email ?? null,
    };

    const [existing] = await db
      .select()
      .from(ownersTable)
      .where(eq(ownersTable.firebaseUid, decoded.uid));

    req.managers = await db
      .select()
      .from(managersTable)
      .where(and(eq(managersTable.firebaseUid, decoded.uid), eq(managersTable.status, "active")));

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
    } else if (req.managers.length === 0) {
      // Only auto-create an Owner account for a UID with no Owner row of its
      // own AND no invite identity either — an invitee's very first sign-in
      // must never silently create a bogus Owner account.
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

    req.resolvedOwnerId = await resolveOwnerId(req);
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

/** Route guard: 401s if firebaseAuthMiddleware didn't attach at least one active invite. */
export function requireManager(req: Request, res: Response, next: NextFunction) {
  if (req.managers.length === 0) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

/** Route guard: allows either an Owner or an invitee acting on some Owner's behalf. */
export function requireOwnerOrManager(req: Request, res: Response, next: NextFunction) {
  if (!req.owner && req.managers.length === 0) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  next();
}

/**
 * Computes the Owner id a request is scoped to — whether acting as the Owner
 * themselves, or as an invitee on one of the Owner(s) who invited them. Runs
 * once per request, inside firebaseAuthMiddleware, and its result is cached
 * on req.resolvedOwnerId; effectiveOwnerId() below just reads that cache so
 * its many call sites can stay synchronous.
 *
 * Resolution order:
 *  1. X-Estate-Id header, if present: look up which Owner that estate
 *     actually belongs to, then confirm this person may act for that
 *     Owner — either it's their own estate, or one of their active invites
 *     is for that same Owner AND (that invite has no estateId, i.e. it
 *     predates per-estate scoping, or its estateId matches this exact
 *     estate). This is the only path that can disambiguate when a person
 *     holds several invites, or is both an Owner and an invitee.
 *  2. No header, or it didn't resolve to an estate this person may act on:
 *     fall back to the legacy behavior (req.owner if signed in as Owner,
 *     else the sole invite's Owner) — keeps older app builds that never
 *     sent X-Estate-Id for this purpose working unchanged.
 */
async function resolveOwnerId(req: Request): Promise<number | null> {
  const header = req.header("X-Estate-Id");
  const estateId = header && !isNaN(Number(header)) ? Number(header) : null;

  if (estateId != null) {
    const [estate] = await db
      .select({ ownerId: farmProfileTable.ownerId })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.id, estateId));
    if (estate?.ownerId != null) {
      const canActForThisOwner =
        req.owner?.id === estate.ownerId ||
        req.managers.some((m) => m.ownerId === estate.ownerId && (m.estateId == null || m.estateId === estateId));
      if (canActForThisOwner) return estate.ownerId;
    }
  }

  return req.owner?.id ?? req.managers[0]?.ownerId ?? null;
}

/** The effective Owner id this request is scoped to — see resolveOwnerId() for how it's computed. */
export function effectiveOwnerId(req: Request): number | null {
  return req.resolvedOwnerId;
}
