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
       * How this request acts on resolvedOwnerId's data: "owner" when it's
       * the person's own estate, "invitee" when it's through an invite (see
       * middlewares/inviteeAccess.ts for what an invitee may do), null when
       * the request isn't signed in as either.
       */
      actorRole: "owner" | "invitee" | null;
      /**
       * For an invitee whose invite is scoped to one estate: that estate's id.
       * resolveActiveEstateId() pins every estate-scoped query to it, so the
       * invitee can never reach the Owner's other estates. null for owners
       * and for legacy invites that predate per-estate scoping.
       */
      inviteEstateId: number | null;
      /**
       * True when the request named an estate (X-Estate-Id) this person may
       * not act on — a revoked invite, a deleted farm, or someone else's.
       * Estate data routes then refuse (see inviteeAccess.ts) rather than
       * silently falling back to another estate, which would e.g. replay a
       * revoked invitee's queued records onto their own farm.
       */
      estateHeaderRejected: boolean;
      /**
       * The verified Firebase token's own identity fields, whenever a valid
       * token was presented — set regardless of whether it resolved to an
       * Owner/invitee yet. Used by routes/invites.ts to find pending invites
       * that match THIS person's phone/email, since a not-yet-accepted
       * invite has no firebaseUid to look it up by. email is only set when
       * Firebase has verified it — an unverified email/password account must
       * never be able to claim an invite addressed to someone else's email.
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
  req.actorRole = null;
  req.inviteEstateId = null;
  req.estateHeaderRejected = false;
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return next();

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    req.firebaseIdentity = {
      uid: decoded.uid,
      phone: decoded.phone_number ?? null,
      email: decoded.email && decoded.email_verified === true ? decoded.email : null,
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
      // Everyone signs into the same Owner app, so a first sign-in gets an
      // Owner account of its own — an invitee may run their own farm too.
      // Skipped only for legacy invitees who were already active before
      // they ever signed in here, so they keep acting purely as invitees.
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

    await resolveAccess(req);
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
 * Resolves which Owner's data this request acts on, and in what role — run
 * once per request inside firebaseAuthMiddleware and cached on the request.
 *
 * Resolution order:
 *  1. X-Estate-Id header, if present: the estate's Owner, when it's this
 *     person's own estate (role "owner") or they hold an active invite for
 *     that Owner whose estateId is this exact estate, or null for a legacy
 *     unscoped invite (role "invitee").
 *  2. Otherwise: their own Owner account (role "owner"), else their first
 *     active invite (role "invitee", pinned to that invite's estate).
 */
async function resolveAccess(req: Request): Promise<void> {
  const header = req.header("X-Estate-Id");
  const estateId = header && !isNaN(Number(header)) ? Number(header) : null;

  if (estateId != null) {
    const [estate] = await db
      .select({ ownerId: farmProfileTable.ownerId })
      .from(farmProfileTable)
      .where(eq(farmProfileTable.id, estateId));
    if (estate?.ownerId != null) {
      if (req.owner?.id === estate.ownerId) {
        setAccess(req, estate.ownerId, "owner", null);
        return;
      }
      const invite = req.managers.find(
        (m) => m.ownerId === estate.ownerId && (m.estateId == null || m.estateId === estateId),
      );
      if (invite) {
        setAccess(req, estate.ownerId, "invitee", invite.estateId);
        return;
      }
    }
    req.estateHeaderRejected = true;
  }

  if (req.owner) {
    setAccess(req, req.owner.id, "owner", null);
  } else if (req.managers[0]) {
    setAccess(req, req.managers[0].ownerId, "invitee", req.managers[0].estateId);
  }
}

function setAccess(req: Request, ownerId: number, role: "owner" | "invitee", inviteEstateId: number | null) {
  req.resolvedOwnerId = ownerId;
  req.actorRole = role;
  req.inviteEstateId = inviteEstateId;
}

/**
 * The estate every estate-scoped query in this request should use:
 *  - a scoped invitee: always their invite's estate, whatever header was sent;
 *  - otherwise: the X-Estate-Id header when that estate belongs to the
 *    resolved Owner, else that Owner's oldest estate.
 * null when the request isn't signed in or the Owner has no estate yet —
 * never another Owner's estate.
 */
export async function resolveActiveEstateId(req: Request): Promise<number | null> {
  const ownerId = req.resolvedOwnerId;
  if (ownerId == null) return null;
  if (req.actorRole === "invitee" && req.inviteEstateId != null) return req.inviteEstateId;

  const header = req.header("X-Estate-Id");
  const headerEid = header && !isNaN(Number(header)) ? Number(header) : null;
  if (headerEid != null) {
    const [row] = await db
      .select({ id: farmProfileTable.id })
      .from(farmProfileTable)
      .where(and(eq(farmProfileTable.id, headerEid), eq(farmProfileTable.ownerId, ownerId)))
      .limit(1);
    if (row) return row.id;
  }

  const [oldest] = await db
    .select({ id: farmProfileTable.id })
    .from(farmProfileTable)
    .where(eq(farmProfileTable.ownerId, ownerId))
    .orderBy(farmProfileTable.id)
    .limit(1);
  return oldest?.id ?? null;
}

/** The effective Owner id this request is scoped to — see resolveOwnerId() for how it's computed. */
export function effectiveOwnerId(req: Request): number | null {
  return req.resolvedOwnerId;
}
