// Shipment sync A's matching rules past the legacy (retailer, Order #, ASIN)
// keys — patch docs/claude_spec-patch-po-matching.md §3, §4 (amended
// 2026-10-29). Pure; the sync supplies the AF rows, the retailer resolution
// and what every other line already places on each row.
//
// §3 (a) full normalized order # + ASIN (supplier via alias when the
//        retailer resolves) — exactly one row.
// §3 (b) base order # (no _N / -N) + ASIN — exactly one row AND the units
//        fit: CAR118805142_1 must not land on a CAR118805142 row that is
//        already fully shipped (the over-link class, 2026-10-29).
// §4     candidate: same ASIN, supplier via alias (any when the retailer is
//        blank, none when it is unresolved), PO date within ±30 days of the
//        Velocity order date, units fit. Ranked by |Δdays|, then the
//        tightest fit. Exactly one → link; several → review; none → a
//        nearest-miss sentence.
import { orderKey, orderBaseKey, afOrderKeys, afOrderBaseKeys } from "./order-number";
import type { RetailerResolution } from "./supplier-aliases";

/** The AF row fields the rules read (a subset of sync A's AfAsinRow). */
export interface MatchRow { id: string; asin: string; order_id: string; supplier: string; order_date: string; qty?: number | string | null; units_per_pack: number | null }

export interface MatchCandidate {
  po_asin_id: string; order_id: string; supplier: string; asin: string;
  source: "col_p" | "candidate";
  order_date?: string; days?: number; remaining_units?: number; units?: number;
}

export const CANDIDATE_WINDOW_DAYS = 30;

/**
 * Velocity eligibility (Maria 2026-10-29): a Velocity line is never offered
 * or auto-linked to a PO that ships to Home or is dated before
 * tracking.velocity_start_date — on every rule (keys, Col P, base order #,
 * §4) and in the picker's suggestions. The picker's free-text search still
 * lists such a PO, with this reason as a warning. null = eligible.
 */
export type VelocityIneligible = "home" | "pre_velocity";
export function velocityIneligible(row: { ships_to?: string | null; order_date: string }, velocityStartDate: string | null): VelocityIneligible | null {
  if (row.ships_to === "home") return "home";
  if (velocityStartDate && String(row.order_date).slice(0, 10) < velocityStartDate) return "pre_velocity";
  return null;
}
export const ineligibleText = (why: VelocityIneligible, velocityStartDate: string | null): string =>
  why === "home" ? "ships to Home, not Velocity" : `dated before the Velocity start (${velocityStartDate})`;

export interface KeyIndex<R extends MatchRow = MatchRow> {
  full: Map<string, R[]>; base: Map<string, R[]>;
  /** order key (full or base) → every row of that PO, any ASIN — for the "Order # in AF without this ASIN" miss. */
  order: Map<string, R[]>;
  byAsin: Map<string, R[]>;
}
const ka = (k: string, asin: string) => `${k}\u0000${asin}`;
const push = <R>(m: Map<string, R[]>, k: string, r: R) => { const a = m.get(k); if (a) { if (!a.includes(r)) a.push(r); } else m.set(k, [r]); };

export function buildKeyIndex<R extends MatchRow>(rows: readonly R[]): KeyIndex<R> {
  const ki: KeyIndex<R> = { full: new Map(), base: new Map(), order: new Map(), byAsin: new Map() };
  for (const r of rows) {
    const asin = r.asin.trim().toUpperCase();
    for (const k of afOrderKeys(r.order_id)) { push(ki.full, ka(k, asin), r); push(ki.order, k, r); }
    for (const k of afOrderBaseKeys(r.order_id)) { push(ki.base, ka(k, asin), r); push(ki.order, k, r); }
    push(ki.byAsin, asin, r);
  }
  return ki;
}

const sameSupplier = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Rows narrowed to the retailer's supplier when it resolves; blank or unresolved → all (an order # is strong evidence on its own). */
export function bySupplier<R extends MatchRow>(rows: readonly R[], ret: RetailerResolution): R[] {
  return ret.kind === "supplier" ? rows.filter((r) => sameSupplier(r.supplier, ret.supplier)) : [...rows];
}

/** §3 (a). */
export function matchFullKey<R extends MatchRow>(orderNumber: string, asin: string, ret: RetailerResolution, ki: KeyIndex<R>): R | null {
  const k = orderKey(orderNumber);
  if (!k) return null;
  const rows = bySupplier(ki.full.get(ka(k, asin.toUpperCase())) ?? [], ret);
  return rows.length === 1 ? rows[0] : null;
}

/** §3 (b) rows (fit is the caller's check). */
export function baseKeyRows<R extends MatchRow>(orderNumber: string, asin: string, ret: RetailerResolution, ki: KeyIndex<R>): R[] {
  const k = orderBaseKey(orderNumber);
  return k ? bySupplier(ki.base.get(ka(k, asin.toUpperCase())) ?? [], ret) : [];
}

/** Velocity's order date ("MM/DD/YYYY"; else its created_at) as YYYY-MM-DD, or null. */
export function velocityDate(line: { date?: unknown; created_at?: unknown }): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(line.date ?? "").trim());
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  const t = Date.parse(String(line.created_at ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** A row's ordered component units: ASIN qty × AF pack (Velocity's pack when AF's is NULL, else 1). */
export const capacityUnits = (row: MatchRow, fallbackUpp: number | null): number => (Number(row.qty) || 0) * (Number(row.units_per_pack) || fallbackUpp || 1);

export interface CandidateInput { asin: string; retailer: RetailerResolution; units: number; vDate: string | null; orderNumber: string }

/**
 * §4: ranked candidates (best first) and, when there are none, why.
 * `remaining(row)` = the row's ordered units minus what every other line places on it.
 */
export function rankCandidates<R extends MatchRow>(
  input: CandidateInput, ki: KeyIndex<R>, remaining: (row: R) => number, windowDays = CANDIDATE_WINDOW_DAYS,
): { candidates: Array<MatchCandidate & { row: R }>; miss: string | null } {
  const asin = input.asin.toUpperCase();
  const withAsin = ki.byAsin.get(asin) ?? [];
  const cands: Array<MatchCandidate & { row: R }> = [];
  if (input.retailer.kind !== "unresolved" && input.vDate) {
    for (const r of bySupplier(withAsin, input.retailer)) {
      const days = dayDiff(r.order_date, input.vDate);
      const rem = remaining(r);
      if (Math.abs(days) <= windowDays && rem + 1e-9 >= input.units) {
        cands.push({ row: r, po_asin_id: r.id, order_id: r.order_id, supplier: r.supplier, asin: r.asin, source: "candidate", order_date: r.order_date.slice(0, 10), days, remaining_units: round2(rem), units: input.units });
      }
    }
    cands.sort((a, b) => Math.abs(a.days!) - Math.abs(b.days!) || (a.remaining_units! - b.remaining_units!) || a.order_id.localeCompare(b.order_id) || a.po_asin_id.localeCompare(b.po_asin_id));
  }
  return { candidates: cands, miss: cands.length > 0 ? null : nearestMiss(input, ki, remaining, windowDays) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: why a line has no candidate — the first test it fails, with the closest row. */
export function nearestMiss<R extends MatchRow>(input: CandidateInput, ki: KeyIndex<R>, remaining: (row: R) => number, windowDays = CANDIDATE_WINDOW_DAYS): string {
  const asin = input.asin.toUpperCase();
  if (input.orderNumber) {
    const onPo = [...(ki.order.get(orderKey(input.orderNumber)) ?? []), ...(ki.order.get(orderBaseKey(input.orderNumber)) ?? [])];
    if (onPo.length > 0 && !onPo.some((r) => r.asin.toUpperCase() === asin)) {
      const p = onPo[0];
      return `Order # ${p.order_id} (${p.supplier}) is in AF without ${asin} — it has ${Array.from(new Set(onPo.map((r) => r.asin))).slice(0, 3).join(", ")}`;
    }
  }
  const withAsin = ki.byAsin.get(asin) ?? [];
  if (withAsin.length === 0) return `no AF PO has ${asin}`;
  if (input.retailer.kind === "unresolved") return `retailer "${input.retailer.retailer}" is not mapped to a supplier (${asin} is on ${withAsin.length} PO${withAsin.length === 1 ? "" : "s"})`;
  const sup = bySupplier(withAsin, input.retailer);
  if (sup.length === 0) {
    const others = Array.from(new Set(withAsin.map((r) => r.supplier))).slice(0, 3).join(", ");
    return `${asin} is only on POs from ${others}`;
  }
  if (!input.vDate) return `Velocity order has no date`;
  const byDays = [...sup].sort((a, b) => Math.abs(dayDiff(a.order_date, input.vDate!)) - Math.abs(dayDiff(b.order_date, input.vDate!)));
  const inWindow = byDays.filter((r) => Math.abs(dayDiff(r.order_date, input.vDate!)) <= windowDays);
  if (inWindow.length === 0) {
    const n = byDays[0]; const d = dayDiff(n.order_date, input.vDate);
    return `nearest PO ${n.order_id} (${n.supplier}) is ${Math.abs(d)} days ${d < 0 ? "before" : "after"} the Velocity order`;
  }
  const n = inWindow[0];
  return `PO ${n.order_id} (${n.supplier}) has ${round2(Math.max(0, remaining(n)))} units left, the line needs ${round2(input.units)}`;
}
