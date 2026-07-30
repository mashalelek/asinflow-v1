// Velocity reconciliation — plan → approve → execute (SPEC §11 "Velocity
// reconciliation"). Replaces "already-in-Velocity → silently drop" with a
// classified plan: CREATE / UPDATE (field diffs) / DELETE-CANDIDATE (manual
// list — the API has no DELETE endpoint) / UNCHANGED, plus the ASIN-level
// aggregate check (manual-review-only). Floor + dedup + plan-approval +
// aggregate check are layered defenses over distinct failure classes.
import { fetchSheetRows } from "./google-sheets";
import { query as defaultQuery } from "./db";
import {
  buildVelocityRecords, formatYMD,
  type VelocityRecord, type VelocitySkip,
} from "./velocity-export";
import { fetchAllInboundOrders, type VelocityInboundOrder } from "./velocity-api";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

// Actionable = still editable in Velocity. "inbound" is the only value
// observed across all 44 orders (2026-07-30); docs name "outbound" = shipped.
// Unknown statuses are treated as closed — fail-safe: never audit what we
// don't understand.
const ACTIONABLE_STATUSES = new Set(["inbound"]);

// Per-order audit is QUANTITY ONLY (Maria, 2026-07-30): actionable qty
// mismatches, not SKU/date noise. sold_as/units_per_pack still pre-validate
// CREATEs (pack-math guard) — they're just not audited on existing orders.
export type AuditedField = "quantity";

export interface FieldDiff {
  field: AuditedField;
  sheet_value: string | number | null;
  velocity_value: string | number | null;
}

export interface PlanUpdate {
  order_id: string;
  order_number: string;
  asin: string;
  status: string;
  item_name: string | null;
  diffs: FieldDiff[];
}

export interface PlanDeleteCandidate {
  order_id: string;
  order_number: string;
  asin: string;
  status: string;
  item_name: string | null;
  sheet_status: string; // the canceled status text that triggered this
}

export interface AggregateOrderLine {
  order_number: string;
  side: "sheet" | "velocity";
  quantity: number | null;
  status: string; // velocity status, or sheet status text
}

export interface AggregateMismatch {
  asin: string;
  sheet_total: number;
  velocity_total: number;
  delta: number; // sheet_total - velocity_total
  orders: AggregateOrderLine[];
}

export interface VelocityPlan {
  from: string;               // YMD
  to: string;                 // YMD
  effectiveFrom: string;      // YMD (creation floor applied to creates only)
  clamped: boolean;
  creates: VelocityRecord[];
  updates: PlanUpdate[];
  deleteCandidates: PlanDeleteCandidate[]; // manual dashboard action — no API DELETE exists
  aggregateMismatches: AggregateMismatch[]; // MANUAL REVIEW ONLY — execute never consumes these
  unchanged: number;
  closedInVelocity: number;   // matched but no longer actionable — never audited per-order
  unmatchedVelocity: number;  // Velocity orders with no sheet row — counted, never touched
  selfPrepExcluded: number;
  skips: VelocitySkip[];
}

const normKey = (orderNumber: string, asin: string) =>
  `${orderNumber.trim()} ${asin.trim().toUpperCase()}`;

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export async function buildVelocityPlan(
  from: Date,
  to: Date,
  deps: { query?: QueryLike } = {},
): Promise<VelocityPlan> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured");

  // CREATE candidates: full selection rules incl. creation floor + guards.
  const build = await buildVelocityRecords(from, to, { query });

  // Matching needs the FULL sheet (audit is status-bound, not date-bound) and
  // the full Velocity list.
  const [sheetRows, velocityOrders] = await Promise.all([
    fetchSheetRows(sheetId),
    fetchAllInboundOrders(),
  ]);

  // One canonical sheet row per (order_number, asin): first non-canceled wins
  // (top-of-sheet canonical, as everywhere); a canceled row is kept only if
  // no non-canceled row exists for the key — that's exactly the
  // delete-candidate signal.
  const sheetByKey = new Map<string, (typeof sheetRows)[number]>();
  for (const row of sheetRows) {
    if (!row.orderNumber || !row.asin) continue;
    const key = normKey(row.orderNumber, row.asin);
    const existing = sheetByKey.get(key);
    if (!existing) { sheetByKey.set(key, row); continue; }
    const existingCanceled = (existing.status ?? "").toLowerCase().includes("canceled");
    const rowCanceled = (row.status ?? "").toLowerCase().includes("canceled");
    if (existingCanceled && !rowCanceled) sheetByKey.set(key, row);
  }

  const updates: PlanUpdate[] = [];
  const deleteCandidates: PlanDeleteCandidate[] = [];
  let unchanged = 0, closedInVelocity = 0, unmatchedVelocity = 0;

  // Per-ASIN aggregate bookkeeping over MATCHED, non-canceled orders — all
  // statuses included in the sums; the actionable flag only gates reporting.
  // Comparable only when EVERY matched non-canceled order for the ASIN has an
  // asserted (non-null) sheet quantity — partial sums would mislead. An
  // explicit 0 IS an assertion (e.g. supplier-canceled qty) and stays in the
  // sums; a null (pre-Velocity-columns row) poisons comparability.
  interface AggEntry { sheet: number; velocity: number; lines: AggregateOrderLine[]; hasActionable: boolean; countable: boolean; hasUnasserted: boolean }
  const agg = new Map<string, AggEntry>();

  const matchedVelocityByKey = new Map<string, VelocityInboundOrder>();

  for (const o of velocityOrders) {
    const orderNumber = String(o.order_number ?? "");
    const asin = String(o.asin ?? "");
    const key = normKey(orderNumber, asin);
    matchedVelocityByKey.set(key, o);
    const sheetRow = sheetByKey.get(key);
    if (!sheetRow) { unmatchedVelocity++; continue; }

    const status = String(o.status ?? "").toLowerCase();
    const actionable = ACTIONABLE_STATUSES.has(status);
    const sheetCanceled = (sheetRow.status ?? "").toLowerCase().includes("canceled");

    // Aggregate sums: matched + sheet-row-not-canceled, ALL statuses.
    if (!sheetCanceled) {
      const asinKey = asin.trim().toUpperCase();
      let e = agg.get(asinKey);
      if (!e) { e = { sheet: 0, velocity: 0, lines: [], hasActionable: false, countable: false, hasUnasserted: false }; agg.set(asinKey, e); }
      const sheetQty = numOrNull(sheetRow.quantity);
      const velQty = numOrNull(o.quantity);
      if (sheetQty === null) e.hasUnasserted = true;
      e.sheet += sheetQty ?? 0;
      e.velocity += velQty ?? 0;
      e.countable = true;
      e.hasActionable = e.hasActionable || actionable;
      e.lines.push({ order_number: orderNumber, side: "sheet", quantity: sheetQty, status: sheetRow.status ?? "" });
      e.lines.push({ order_number: orderNumber, side: "velocity", quantity: velQty, status });
    }

    if (!actionable) { closedInVelocity++; continue; } // shipped/received/unknown — moot

    if (sheetCanceled) {
      deleteCandidates.push({
        order_id: o.order_id, order_number: orderNumber, asin,
        status, item_name: o.item_name ?? null, sheet_status: sheetRow.status ?? "",
      });
      continue;
    }

    // Field audit — QUANTITY ONLY (SPEC §11). Assertion rules: a null/empty
    // sheet value is NO ASSERTION (older sheet rows predate the Velocity
    // columns AX–AZ) — never propose writing over a real Velocity value; only
    // a POSITIVE INTEGER proposes an update (explicit 0 = full-cancel
    // territory → aggregate/manual only, never an update).
    const diffs: FieldDiff[] = [];
    const sheetQty = numOrNull(sheetRow.quantity), velQty = numOrNull(o.quantity);
    if (sheetQty !== null && Number.isInteger(sheetQty) && sheetQty > 0 && sheetQty !== velQty) {
      diffs.push({ field: "quantity", sheet_value: sheetQty, velocity_value: velQty });
    }

    if (diffs.length === 0) { unchanged++; continue; }
    updates.push({
      order_id: o.order_id, order_number: orderNumber, asin,
      status, item_name: o.item_name ?? null, diffs,
    });
  }

  // CREATE = build output minus anything matched in Velocity.
  const creates = build.records.filter(
    (r) => !matchedVelocityByKey.has(normKey(r.order_number, r.asin)),
  );

  // Aggregate mismatches: only ASINs with ≥1 still-actionable order (all-
  // shipped mismatches are moot), sums over ALL matched non-canceled orders.
  const aggregateMismatches: AggregateMismatch[] = [];
  for (const [asin, e] of Array.from(agg.entries())) {
    if (!e.countable || !e.hasActionable || e.hasUnasserted) continue;
    if (e.sheet === e.velocity) continue;
    aggregateMismatches.push({
      asin, sheet_total: e.sheet, velocity_total: e.velocity,
      delta: e.sheet - e.velocity, orders: e.lines,
    });
  }

  return {
    from: formatYMD(from),
    to: formatYMD(to),
    effectiveFrom: formatYMD(build.effectiveFrom),
    clamped: build.clamped,
    creates,
    updates,
    deleteCandidates,
    aggregateMismatches,
    unchanged,
    closedInVelocity,
    unmatchedVelocity,
    selfPrepExcluded: build.selfPrepExcluded,
    skips: build.skips,
  };
}

// PUT body from a diff list. Audit is quantity-only, so only quantity ever
// maps; anything else in a submitted plan is ignored here (and would be
// rejected by the client's allowed-field set anyway).
export function putBodyFromDiffs(diffs: FieldDiff[]): Record<string, any> {
  const body: Record<string, any> = {};
  for (const d of diffs) {
    if (d.field === "quantity") body.quantity = d.sheet_value;
  }
  return body;
}
