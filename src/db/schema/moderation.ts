import { pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Reports on the open listing boards (produce, equipment, hire). Reviewed by
// the team within 24 hours; three different reporters hide a listing for all.
export const contentReportsTable = pgTable("content_reports", {
  id: serial("id").primaryKey(),
  board: text("board").notNull(), // "produce" | "equipment" | "hire"
  listingId: integer("listing_id").notNull(),
  reason: text("reason").notNull(),
  details: text("details"),
  reporterKey: text("reporter_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// What a device has hidden: one listing (blockedOwnerKey null) or everything
// a poster has listed (blockedOwnerKey set). Keyed by the same per-device
// owner key the boards already use, so it works without signing in.
export const contentBlocksTable = pgTable(
  "content_blocks",
  {
    id: serial("id").primaryKey(),
    blockerKey: text("blocker_key").notNull(),
    board: text("board").notNull(),
    listingId: integer("listing_id").notNull(),
    blockedOwnerKey: text("blocked_owner_key"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    oneRowPerListing: uniqueIndex("content_blocks_blocker_listing_unique").on(t.blockerKey, t.board, t.listingId),
  }),
);
