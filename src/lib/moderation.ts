import { eq } from "drizzle-orm";
import { db, contentBlocksTable } from "../db";

export type Board = "produce" | "equipment" | "hire";

/** What this device has hidden: whole posters (by owner key) and single listings. */
export async function hiddenFor(callerKey: string) {
  const owners = new Set<string>();
  const listings = new Set<string>();
  if (!callerKey) return { owners, listings };
  const rows = await db.select().from(contentBlocksTable).where(eq(contentBlocksTable.blockerKey, callerKey));
  for (const r of rows) {
    listings.add(`${r.board}:${r.listingId}`);
    if (r.blockedOwnerKey) owners.add(r.blockedOwnerKey);
  }
  return { owners, listings };
}

/** Drops listings this device reported or whose poster it blocked. */
export function visible<T extends { id: number; ownerKey: string | null }>(
  rows: T[],
  board: Board,
  hidden: { owners: Set<string>; listings: Set<string> },
): T[] {
  if (hidden.owners.size === 0 && hidden.listings.size === 0) return rows;
  return rows.filter(
    (r) => !hidden.listings.has(`${board}:${r.id}`) && !(r.ownerKey && hidden.owners.has(r.ownerKey)),
  );
}
