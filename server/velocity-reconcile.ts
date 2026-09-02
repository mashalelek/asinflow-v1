// Velocity reconciliation — plan → approve → execute (SPEC §11 "Velocity
// reconciliation"). Replaces "already-in-Velocity → silently drop" with a
// classified plan: CREATE / UPDATE (quantity diffs) / DELETE-CANDIDATE
// (manual list — the API has no DELETE endpoint) / UNCHANGED.
// Shipped/received matched pairs ARE compared and included when mismatched,
// marked actionable:false (flag-only — no PUT ever targets them). This
// per-PO comparison including shipped orders is what catches the cross-order
// check-in case (a partial cancel on the sheet vs. a full check-in in
// Velocity is a per-PO mismatch on that order) — the former ASIN-level
// aggregate check was removed 2026-07-30 as redundant with it.
import { fetchSheetRows } from "./google-sheets";
import { query as defaultQuery } from "./db";
import {
  buildVelocityRecords, formatYMD,
  type VelocityRecord, type VelocitySkip, type VelocityBundleRecord, type BundleFlag,
} from "./velocity-export";
import { fetchAllKnownOrders, matchKeysForOrder, unidentifiedShippedBundles, type KnownVelocityOrder } from "./velocity-api";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

// Actionable = still editable in Velocity. "inbound" is the only editable
// state; the complete-coverage fetch (2026-08-11) also carries "inventory"
// (checked-in) and "shipped" (pseudo-orders from shipment details) — both
// non-actionable. Unknown statuses are treated as closed — fail-safe: never
// audit what we don't understand.
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
  // false = shipped/received (or unknown status): displayed as a flag only —
  // no checkbox in the UI, never a PUT target (SPEC §11).
  actionable: boolean;
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

export interface VelocityPlan {
  from: string;               // YMD
  to: string;                 // YMD
  effectiveFrom: string;      // YMD (creation floor applied to creates only)
  clamped: boolean;
  creates: VelocityRecord[];
  // Bundles (SPEC §11, 2026-08-31): dedup by child-derived keys; AY/AZ
  // cross-check mismatches ride along for the review screen.
  bundleCreates: VelocityBundleRecord[];
  bundleFlags: BundleFlag[];
  updates: PlanUpdate[];      // incl. actionable:false shipped-pair mismatches (flag-only)
  deleteCandidates: PlanDeleteCandidate[]; // manual dashboard action — no API DELETE exists
  unchanged: number;
  closedInVelocity: number;   // matched, not actionable, no qty mismatch (or moot-canceled)
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
  // COMPLETE coverage (2026-08-11): /inbound + /inventory + shipment details.
  // A completed order must MATCH (landing in the shipped/closed buckets) —
  // never classify as CREATE (the duplicate-send near-miss, 2026-08-07).
  // fetchAllKnownOrders is fail-closed: any leg failing throws, the plan
  // build fails, and NOTHING is classified — no partial match set.
  const [sheetRows, velocityOrders] = await Promise.all([
    fetchSheetRows(sheetId),
    fetchAllKnownOrders(),
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

  const matchedVelocityByKey = new Map<string, KnownVelocityOrder>();

  // Sheet-side derived bundle units per (order, asin) — the units audit for
  // matched bundles compares parent quantity vs this (AZ is never an input).
  const sheetBundleUnits = new Map<string, number>();
  {
    const groups = new Map<string, typeof sheetRows>();
    for (const row of sheetRows) {
      if ((row.soldAs ?? "").trim().toLowerCase() !== "bundle") continue;
      if (!row.orderNumber || !row.asin) continue;
      const k = normKey(row.orderNumber, row.asin);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(row);
    }
    for (const [k, g] of Array.from(groups.entries())) {
      const S = Number((g[0].uniqueS ?? "").trim());
      if (!Number.isInteger(S) || g.length !== S) continue; // underivable — no audit assertion
      let total = 0, ok = true;
      for (const r of g) {
        const L = Number((r.qtyOrderedL ?? "").trim());
        const T = Number((r.yieldT ?? "").trim());
        const units = Math.round(L * T * 1e6) / 1e6;
        if (!Number.isFinite(units) || !Number.isInteger(units) || units <= 0) { ok = false; break; }
        total += units;
      }
      if (ok) sheetBundleUnits.set(k, total);
    }
  }

  for (const o of velocityOrders) {
    const asin = String(o.asin ?? "");
    const isBundle = String(o.sold_as ?? "").toLowerCase() === "bundle";
    // Child-derived match keys (SPEC §11 Bundles): a bundle registers one key
    // per distinct child order_number × parent asin; flat orders keep their
    // (order_number, asin) key. The first key with a sheet hit is the match.
    const keys = matchKeysForOrder(o);
    let sheetRow: (typeof sheetRows)[number] | undefined;
    let matchedKey: string | null = null;
    for (const k of keys) {
      const nk = normKey(k.orderNumber, k.asin);
      matchedVelocityByKey.set(nk, o);
      if (!sheetRow) {
        const hit = sheetByKey.get(nk);
        if (hit) { sheetRow = hit; matchedKey = nk; }
      }
    }
    const orderNumber = matchedKey != null ? String(sheetRow!.orderNumber ?? "") : String(o.order_number ?? "");
    if (!sheetRow) { unmatchedVelocity++; continue; }

    const status = String(o.status ?? "").toLowerCase();
    const actionable = ACTIONABLE_STATUSES.has(status);
    const sheetCanceled = (sheetRow.status ?? "").toLowerCase().includes("canceled");

    if (sheetCanceled) {
      // Delete-candidate only while actionable; a shipped order for a
      // canceled sheet row is moot.
      if (actionable) {
        deleteCandidates.push({
          order_id: o.order_id, order_number: orderNumber, asin,
          status, item_name: o.item_name ?? null, sheet_status: sheetRow.status ?? "",
        });
      } else {
        closedInVelocity++;
      }
      continue;
    }

    // Quantity audit — ALL matched pairs, shipped/received included (SPEC
    // §11): a shipped-pair mismatch is displayed flag-only (actionable:false,
    // no checkbox, never a PUT). This per-PO comparison incl. shipped orders
    // is what catches the cross-order check-in case; the former ASIN-level
    // aggregate check was removed as redundant with it. Assertion rules: a
    // null/empty sheet value is NO ASSERTION (older sheet rows predate the
    // Velocity columns AX–AZ); only a POSITIVE INTEGER proposes/flags a
    // mismatch (explicit 0 = full-cancel territory → manual, never an update).
    const diffs: FieldDiff[] = [];
    // Shipment-derived pseudo-orders carry quantity_shipped, NOT the order
    // quantity — different semantics, never quantity-audited (a partially
    // shipped order would flag pure noise). They exist to block CREATE and
    // land in closedInVelocity. Inbound/inventory rows audit as before.
    if (isBundle) {
      // Bundles audit in UNITS: parent quantity vs the sheet-derived total
      // (N × units_per_bundle). Underivable sheet groups assert nothing.
      // Flag-only regardless of status — a PUT against a bundle parent is
      // untested; fail-closed until proven (SPEC §11 Bundles).
      const derived = matchedKey != null ? sheetBundleUnits.get(matchedKey) : undefined;
      const velQty = numOrNull(o.quantity);
      if (derived !== undefined && derived !== velQty) {
        diffs.push({ field: "quantity", sheet_value: derived, velocity_value: velQty });
      }
    } else if (o.lifecycleSource !== "shipment") {
      const sheetQty = numOrNull(sheetRow.quantity), velQty = numOrNull(o.quantity);
      if (sheetQty !== null && Number.isInteger(sheetQty) && sheetQty > 0 && sheetQty !== velQty) {
        diffs.push({ field: "quantity", sheet_value: sheetQty, velocity_value: velQty });
      }
    }

    if (diffs.length === 0) { actionable ? unchanged++ : closedInVelocity++; continue; }
    updates.push({
      order_id: o.order_id, order_number: orderNumber, asin,
      status, item_name: o.item_name ?? null, actionable: actionable && !isBundle, diffs,
    });
  }

  // CREATE = build output minus anything matched in Velocity.
  const creates = build.records.filter(
    (r) => !matchedVelocityByKey.has(normKey(r.order_number, r.asin)),
  );
  // Bundle CREATE dedup: ANY child-derived key already known in Velocity
  // means the bundle exists — never re-send (SPEC §11 Bundles).
  // Shipped-bundle suppression (2026-09-02): a fully-shipped bundle's child
  // keys are unrecoverable (identity gap), so ALL bundle creates for its
  // ASIN are suppressed fail-closed with a loud skip — never risk
  // re-creating an order the API can no longer identify.
  const shippedUnidentifiedAsins = new Set(
    unidentifiedShippedBundles(velocityOrders).map((o) => String(o.asin ?? "").toUpperCase()),
  );
  const bundleCreates: typeof build.bundles = [];
  for (const b of build.bundles) {
    if (b.orderNumbers.some((n) => matchedVelocityByKey.has(normKey(n, b.asin)))) continue;
    if (shippedUnidentifiedAsins.has(b.asin.toUpperCase())) {
      build.skips.push({
        reason: "bundle_shipped_unidentified",
        orderNumber: b.orderNumbers[0] ?? "", asin: b.asin, itemName: b.item_name,
        row: { date: b.date, retailer: null, quantity: String(b.quantity), soldAs: "bundle", unitsPerPack: String(b.units_per_pack) },
      });
      continue;
    }
    bundleCreates.push(b);
  }

  return {
    from: formatYMD(from),
    to: formatYMD(to),
    effectiveFrom: formatYMD(build.effectiveFrom),
    clamped: build.clamped,
    creates,
    bundleCreates,
    bundleFlags: build.bundleFlags,
    updates,
    deleteCandidates,
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
