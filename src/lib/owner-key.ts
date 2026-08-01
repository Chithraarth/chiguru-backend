// Shared ownership helpers for the open (no-auth) classifieds boards: hire,
// produce (marketplace) and equipment. Each ad stores a per-device secret
// `ownerKey`; the poster's device presents it as the `X-Owner-Key` header on
// reads (to flag "mine") and in the delete body/header to prove ownership.
// The secret itself is never echoed back in any response.

export function requestOwnerKey(req: { get: (name: string) => string | undefined }): string {
  const raw = req.get("X-Owner-Key");
  return typeof raw === "string" && raw.length <= 80 ? raw.trim() : "";
}

// Strip the secret before sending a row to any client; add a `mine` flag the
// caller's device can trust to show its own delete button.
export function publicRow<T extends { ownerKey: string | null }>(row: T, callerKey: string) {
  const { ownerKey, ...rest } = row;
  return { ...rest, mine: Boolean(callerKey && ownerKey && ownerKey === callerKey) };
}

// Sanitize an ownerKey supplied in a POST body (optional; capped like every
// other free-text input on these unauthenticated write routes).
export function bodyOwnerKey(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed.length <= 80 ? trimmed : null;
}
