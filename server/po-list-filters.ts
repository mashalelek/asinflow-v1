// The POs list's filters (GET /api/pos) and the counts its dropdowns show
// (2026-11-06). Each filter is one facet; the list is every facet ANDed.
// A dropdown's counts are "how many POs match this option, given the OTHER
// active filters" — the same facets with that one left out — so a count
// never disagrees with the list it leads to. One extra query per facet,
// in the same request as the list; no round trip per dropdown.
import type { QueryLike } from "./scheduler/types";
import { LEGACY_ACTION_ITEMS, ACTION_ITEMS, REVIEW_VELOCITY, DISPLAY_ACTION_ITEMS, PACK_SIZE_MISSING, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, EXTRA_UNITS_SHIPPED, NO_INVOICE_SAVED } from "./po-status-map";
import { openLineItemsSql, PACK_SIZE_MISSING_EXISTS_SQL, PACK_SIZE_MISMATCH_EXISTS_SQL, RECEIVING_MISMATCH_EXISTS_SQL, EXTRA_UNITS_EXISTS_SQL, NO_INVOICE_EXISTS_SQL } from "./po-action-items";
import { OPEN_DEFECT_PO_SQL } from "./po-defect-sql";
import { DEFECT_ACTION_ITEM } from "@shared/po-defect";
import { refundsFilterCond } from "./po-queries";
import { replacementTrackingCondSql } from "./tracking-replacement-pair";

export type PoClosedFilter = "open" | "closed" | "all";
export type PoRefundsFilter = "any" | "due" | "none";
export interface PoListFilters {
  search: string; action: string[]; supplier: string[]; from: string; to: string; closed: PoClosedFilter; refunds: PoRefundsFilter;
}
export type PoFacet = "search" | "action" | "supplier" | "dates" | "closed" | "refunds";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => str(v).split(",").map((x) => x.trim()).filter(Boolean);

/** The request's query string → filters (D3: Status defaults to Open; Refunds any). */
export function parsePoListFilters(q: Record<string, unknown>): PoListFilters {
  const closedRaw = str(q.closed).toLowerCase() || "open", refundsRaw = str(q.refunds).toLowerCase();
  return {
    search: str(q.search),
    // Old label spellings map to today's.
    action: list(q.action).map((x): string => LEGACY_ACTION_ITEMS[x] ?? x),
    supplier: list(q.supplier),
    from: str(q.from), to: str(q.to),
    closed: closedRaw === "closed" ? "closed" : closedRaw === "all" ? "all" : "open",
    refunds: refundsRaw === "due" || refundsRaw === "none" ? refundsRaw : "any",
  };
}

/** Collects parameters; `$` hands back the placeholder for one. */
class Params {
  values: unknown[] = [];
  $(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/**
 * One Action Item's condition: a PO matches when ANY product line has it open
 * (po_line_action_items, PO table v2), or — for the derived items — when the
 * derived rule holds (the pack-size / receiving / extra-units / invoice /
 * supplier-defect rules). null for a label that is no Action Item.
 */
function actionItemCond(item: string, p: Params): string | null {
  const any: string[] = [];
  if ((ACTION_ITEMS as readonly string[]).includes(item) || item === REVIEW_VELOCITY) any.push(`EXISTS (${openLineItemsSql(`l.po_id = p.id AND ai.item = ${p.$(item)}`)})`);
  if (item === PACK_SIZE_MISSING) any.push(PACK_SIZE_MISSING_EXISTS_SQL);
  if (item === PACK_SIZE_MISMATCH) any.push(PACK_SIZE_MISMATCH_EXISTS_SQL);
  if (item === RECEIVING_MISMATCH) any.push(RECEIVING_MISMATCH_EXISTS_SQL);
  if (item === EXTRA_UNITS_SHIPPED) any.push(EXTRA_UNITS_EXISTS_SQL);
  if (item === NO_INVOICE_SAVED) any.push(NO_INVOICE_EXISTS_SQL("p"));
  // Derived from open supplier defects too (SPEC §22 "Supplier defects"); the stored manual badges still match above.
  if (item === DEFECT_ACTION_ITEM) any.push(OPEN_DEFECT_PO_SQL("p"));
  const pair = replacementTrackingCondSql("p", item); // the one-off replacement pair's item — until 2026-11-06 the filter ignored it
  if (pair) any.push(pair);
  return any.length ? `(${any.join(" OR ")})` : null;
}

function closedCond(c: PoClosedFilter): string | null {
  return c === "open" ? `p.closed_at IS NULL` : c === "closed" ? `p.closed_at IS NOT NULL` : null;
}

/** Every facet's condition but `omit`'s, ANDed — `p` is the purchase_orders alias. */
function conds(f: PoListFilters, p: Params, omit?: PoFacet): string[] {
  const out: string[] = [];
  if (omit !== "search" && f.search) {
    const n = p.$(`%${f.search}%`);
    // Notes too (2026-11-04): the PO's, its ASIN rows' and its product
    // lines' — a replacement order # noted on the original PO finds it.
    // The Supplier field and its alias names too (Maria 2026-11-04): "zara" or "ZARA DEL AMO" finds zara.com's POs.
    out.push(`(p.order_id ILIKE ${n} OR p.notes ILIKE ${n} OR p.alt_order_ids ILIKE ${n}
        OR p.supplier ILIKE ${n}
        OR EXISTS (SELECT 1 FROM supplier_aliases sa WHERE sa.supplier = p.supplier AND sa.alias ILIKE ${n})
        OR EXISTS (SELECT 1 FROM po_asins a WHERE a.po_id = p.id AND (a.asin ILIKE ${n} OR a.notes ILIKE ${n}))
        OR EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id AND (l.product_name ILIKE ${n} OR l.notes ILIKE ${n})))`);
  }
  // Both multi-selects: OR within the facet, AND across facets.
  if (omit !== "action" && f.action.length) {
    const any = f.action.map((x) => actionItemCond(x, p)).filter((x): x is string => !!x);
    if (any.length) out.push(`(${any.join(" OR ")})`);
  }
  if (omit !== "supplier" && f.supplier.length) out.push(`p.supplier = ANY(${p.$(f.supplier)}::text[])`);
  if (omit !== "dates") {
    if (f.from) out.push(`p.order_date >= ${p.$(f.from)}`);
    if (f.to) out.push(`p.order_date <= ${p.$(f.to)}`);
  }
  if (omit !== "closed") { const c = closedCond(f.closed); if (c) out.push(c); }
  if (omit !== "refunds") { const c = refundsFilterCond(f.refunds); if (c) out.push(c); }
  return out;
}

const whereOf = (c: string[]) => (c.length ? `WHERE ${c.join(" AND ")}` : "");

/** The list's WHERE clause and its parameters. */
export function poListWhere(f: PoListFilters, omit?: PoFacet): { where: string; params: unknown[] } {
  const p = new Params();
  return { where: whereOf(conds(f, p, omit)), params: p.values };
}

export interface PoFacetCounts {
  closed: Record<PoClosedFilter, number>;
  refunds: Record<PoRefundsFilter, number>;
  suppliers: Record<string, number>;
  actionItems: Record<string, number>;
}

/** Per dropdown option: the POs that match it under the other active filters. */
export async function poFacetCounts(query: QueryLike, f: PoListFilters): Promise<PoFacetCounts> {
  const one = async (omit: PoFacet, select: (p: Params) => string, tail = "") => {
    const p = new Params();
    const sel = select(p); // its parameters first, then the WHERE's
    return (await query(`SELECT ${sel} FROM purchase_orders p ${whereOf(conds(f, p, omit))} ${tail}`, p.values)).rows;
  };
  const [closed, refunds, suppliers, actions] = await Promise.all([
    one("closed", () => `COUNT(*) FILTER (WHERE ${closedCond("open")})::int AS open, COUNT(*) FILTER (WHERE ${closedCond("closed")})::int AS closed, COUNT(*)::int AS "all"`),
    one("refunds", () => `COUNT(*) FILTER (WHERE ${refundsFilterCond("due")})::int AS due, COUNT(*) FILTER (WHERE ${refundsFilterCond("none")})::int AS none, COUNT(*)::int AS "any"`),
    one("supplier", () => `p.supplier, COUNT(*)::int AS n`, `GROUP BY p.supplier`),
    one("action", (p) => DISPLAY_ACTION_ITEMS.map((item, i) => { const c = actionItemCond(item, p); return `${c ? `COUNT(*) FILTER (WHERE ${c})` : "0"}::int AS a${i}`; }).join(", ")),
  ]);
  return {
    closed: { open: closed[0].open, closed: closed[0].closed, all: closed[0].all },
    refunds: { any: refunds[0].any, due: refunds[0].due, none: refunds[0].none },
    suppliers: Object.fromEntries(suppliers.map((r: any) => [r.supplier, r.n])),
    actionItems: Object.fromEntries(DISPLAY_ACTION_ITEMS.map((item, i) => [item, actions[0][`a${i}`]])),
  };
}
