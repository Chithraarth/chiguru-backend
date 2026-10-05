import type { NextFunction, Request, Response } from "express";

// ── Access rules for every /api request ─────────────────────────────────────
// Runs after firebaseAuthMiddleware has resolved req.resolvedOwnerId and
// req.actorRole (see resolveAccess in firebaseAuth.ts).
//
//  1. Anything not in PUBLIC_ROUTES reads or writes some Owner's data, so it
//     requires a signed-in request — no more anonymous fallback to "the
//     oldest estate", which used to expose every farm by X-Estate-Id alone.
//  2. An invitee acting on an invited estate may only use what the old
//     Manager app could: INVITEE_ROUTES plus the account-level routes that
//     only ever touch their own account. Everything else is 403, so a route
//     added later is owner-only by default.

type Route = { method: string; pattern: RegExp };

function route(method: string, path: string): Route {
  const pattern = new RegExp("^" + path.replace(/:[A-Za-z]+/g, "[^/]+") + "/?$");
  return { method, pattern };
}

function matches(routes: Route[], req: Request): boolean {
  return routes.some((r) => r.method === req.method && r.pattern.test(req.path));
}

// Reachable without signing in: public boards and catalogues (their writes
// are guarded by an owner key or their own checks), health, error reports.
const PUBLIC_ROUTES: Route[] = [
  route("GET", "/healthz"),
  route("POST", "/errors"),
  route("GET", "/ads/recent"),
  route("GET", "/subscriptions/plans"),
  route("GET", "/agronomists"),
  route("GET", "/agronomists/:id"),
  route("GET", "/agronomists/:id/earnings"),
  route("POST", "/agronomists/:id/payouts"),
  route("POST", "/agronomists/:id/payouts/:payoutId/paid"),
  route("GET", "/produce-listings"),
  route("GET", "/produce-listings/:id"),
  route("DELETE", "/produce-listings/:id"),
  route("GET", "/equipment-listings"),
  route("GET", "/equipment-listings/:id"),
  route("DELETE", "/equipment-listings/:id"),
  route("GET", "/hire-listings"),
  route("GET", "/hire-listings/:id"),
  route("POST", "/hire-listings"),
  route("PATCH", "/hire-listings/:id"),
  route("DELETE", "/hire-listings/:id"),
  route("GET", "/nursery/vendors"),
  route("GET", "/nursery/vendors/:id"),
  route("POST", "/nursery/vendors/:id/ratings"),
  route("PATCH", "/nursery/vendors/:id"),
  route("DELETE", "/nursery/vendors/:id"),
  route("GET", "/nursery/listings"),
  route("PATCH", "/nursery/listings/:id"),
  route("DELETE", "/nursery/listings/:id"),
  route("GET", "/mandi/prices"),
];

// Signed in, but not yet tied to any Owner's data — e.g. a first-time
// invitee checking their pending invites. These check the token themselves.
const IDENTITY_ROUTES: Route[] = [
  route("GET", "/me/invites"),
  route("POST", "/me/invites/:id/accept"),
  route("POST", "/me/invites/:id/decline"),
];

// Exactly the old Manager app's features, on the invited estate only.
const INVITEE_ROUTES: Route[] = [
  route("GET", "/manager/me"),
  route("GET", "/estates"),
  route("PATCH", "/estates/:id"),
  route("GET", "/farm/profile"),
  route("GET", "/crops"),
  route("GET", "/workers"),
  route("GET", "/work-groups"),
  route("POST", "/work-groups"),
  route("GET", "/work-groups/:id/advance-payments"),
  route("GET", "/attendance"),
  route("POST", "/attendance"),
  route("POST", "/ai/count-workers"),
  route("POST", "/estate-updates/count-workers"),
  route("GET", "/estate-updates"),
  route("POST", "/estate-updates"),
  route("GET", "/plan-tasks"),
  route("GET", "/expenses"),
  route("POST", "/expenses"),
  route("GET", "/expenses/:id/receipt"),
];

// The invitee's own account (never the inviting Owner's data): choosing an
// estate, their own devices, profile and farms list.
const INVITEE_ACCOUNT_ROUTES: Route[] = [
  route("GET", "/me/estates"),
  route("GET", "/me/farms"),
  route("POST", "/me/devices/register"),
  route("GET", "/me/devices"),
  route("DELETE", "/me/devices/:id"),
  route("GET", "/owners/me"),
  route("DELETE", "/owners/me"),
  route("GET", "/subscriptions/me"),
];

// About the signed-in person's own account rather than any one estate's data,
// so they still work when the client is holding a stale X-Estate-Id — that's
// how the apps find out which estates are valid and recover.
const ACCOUNT_ROUTE_PREFIXES = [
  "/me/",
  "/owners/",
  "/manager/me",
  "/managers",
  "/subscriptions",
  "/subscription/",
  "/payments",
  "/wallet",
  "/app-settings",
];

function isAccountRoute(req: Request): boolean {
  return ACCOUNT_ROUTE_PREFIXES.some((p) => req.path === p.replace(/\/$/, "") || req.path.startsWith(p));
}

export function enforceAccessRules(req: Request, res: Response, next: NextFunction) {
  if (matches(PUBLIC_ROUTES, req)) return next();

  if (matches(IDENTITY_ROUTES, req)) return next();

  if (req.resolvedOwnerId == null) {
    res.status(401).json({ message: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }

  if (req.estateHeaderRejected && !isAccountRoute(req)) {
    res.status(403).json({
      message: "You no longer have access to this farm.",
      code: "ESTATE_ACCESS_DENIED",
    });
    return;
  }

  if (req.actorRole !== "invitee") return next();

  if (matches(INVITEE_ROUTES, req) || matches(INVITEE_ACCOUNT_ROUTES, req)) return next();

  res.status(403).json({
    message: "This isn't available on a farm you've been invited to.",
    code: "INVITEE_FORBIDDEN",
  });
}
