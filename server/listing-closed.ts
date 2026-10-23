// The closed test (listing-hygiene amendment 2026-10-23) — ONE definition,
// used everywhere AF reads an offer's end_at as "closed".
//
// No Amazon source exposes SC's inactive sub-status (probe 2026-10-23: the
// Listings API, searchListingsItems and every listings report show Closed
// and Out of stock alike). What end_at's FORM says:
//   - a real close timestamp (Amazon rewrites the date when a close is
//     applied — an SC close, or one applied later) → closed;
//   - the literal BORN_CLOSED_END_AT (2000-01-01) → Amazon stored the value
//     AF sent. Sent at CREATE it is NOT applied (the listing stays open, "Out
//     of stock"); sent by AF's close PATCH it is. So it counts as closed only
//     when AF has an accepted close PATCH on the SKU after its latest creation;
//   - null → open.
// BUYABLE always means open, whatever end_at says. Pure.
import { BORN_CLOSED_END_AT } from "./offer-add";

const LITERAL_MS = Date.parse(`${BORN_CLOSED_END_AT}T00:00:00Z`);
const toMs = (v: Date | string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
};

/** The literal AF sends (as Amazon echoes it, "2000-01-01", or as the DB stores it, 2000-01-01T00:00:00Z). */
export function isBornClosedLiteral(endAt: Date | string | null | undefined): boolean {
  if (endAt === BORN_CLOSED_END_AT) return true;
  return toMs(endAt) === LITERAL_MS;
}

export interface ClosedInput {
  endAt: Date | string | null | undefined;
  /** summaries[].status includes BUYABLE — known on a live read only; null/undefined = not known. */
  buyable?: boolean | null;
  /** The listing's creation (summaries createdDate / asin_skus.listing_created_at). */
  createdAt?: Date | string | null;
  /** The newest accepted (or verified) live AF close PATCH on the SKU. */
  closePatchAt?: Date | string | null;
}

export function isOfferClosed(i: ClosedInput, now: Date = new Date()): boolean {
  if (i.buyable === true) return false;
  const end = toMs(i.endAt);
  if (end == null) return false;
  if (isBornClosedLiteral(i.endAt)) {
    const patch = toMs(i.closePatchAt);
    if (patch == null) return false;
    const created = toMs(i.createdAt);
    return created == null || patch > created;
  }
  return end <= now.getTime();
}
