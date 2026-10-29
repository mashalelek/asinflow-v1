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
import type { SheetRow } from "./google-sheets";
import { loadAfPoRows } from "./po-af-source";
import { query as defaultQuery } from "./db";
import {
  buildVelocityRecords, formatYMD,
  type VelocityRecord, type VelocitySkip, type VelocityBundleRecord, type BundleFlag,
} from "./velocity-export";
import { fetchAllKnownOrders, matchKeysForOrder, type KnownVelocityOrder } from "./velocity-api";
import { recordableBundles, hydrateChildlessBundles, type BundleIdentityRow } from "./velocity-bundle-identity";

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
  // Home POs (ships_to = 'home', 2026-10-29): what a create WOULD send for
  // them, minus anything Velocity already has. The dialog lists these under
  // "Self-prep — not uploaded", unticked; only a deliberate tick sends one.
  homeCreates: VelocityRecord[];
  homeBundleCreates: VelocityBundleRecord[];
  homeSkipped: number;
  // §11 Part B.3 (2026-09-21): identity recording the plan WOULD perform.
  // Computed here, written only by execute — the plan is a preview.
  identityWouldRecord: BundleIdentityRow[];
  unplacedBundles: Array<{
    velocity_order_id: string; asin: string; date: string; quantity: number | null;
    units_per_pack: any; amazon_sku: string | null; item_name: string | null;
    created_at: string | null; shipment_ids: string[]; candidateOrderNumbers: string[];
  }>;
}

const normKey = (orderNumber: string, asin: string) =>
  `${orderNumber.trim()} ${asin.trim().toUpperCase()}`;

/**
 * Skips are built from the sheet alone (buildVelocityRecords), so a row
 * Velocity already knows — inbound, inventory or shipped — used to surface
 * as "no live SKU" / "quantity not divisible by units/pack" although there
 * is nothing to create. Drop every skip whose (order #, ASIN) is matched in
 * Velocity, exactly as creates are filtered. bundle_unplaced_candidate is
 * about Velocity state already and always stays. (Fix 2026-10-17.)
 */
export function dropSkipsKnownToVelocity(skips: VelocitySkip[], known: { has(key: string): boolean }): VelocitySkip[] {
  return skips.filter((sk) =>
    sk.reason === "bundle_unplaced_candidate" ||
    !known.has(normKey(String(sk.orderNumber ?? ""), String(sk.asin ?? ""))));
}

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// §11 Part D: sheet is M/D/YYYY, Velocity serializes zero-padded MM/DD/YYYY.
// Compare as parsed calendar dates, ±1 day inclusive. Unparseable either side
// → NOT a candidate (fail-closed: never hold a group on a date we can't read).
export function withinOneDay(sheetDate: string, velocityDate: string): boolean {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
    if (!m) return null;
    return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  };
  const a = parse(sheetDate), b = parse(velocityDate);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= 86400000;
}

export async function buildVelocityPlan(
  from: Date,
  to: Date,
  deps: { query?: QueryLike; loadRows?: () => Promise<SheetRow[]> } = {},
): Promise<VelocityPlan> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  // PO rows come from the AF PO tables (po-af-owned §2.4, 2026-10-18), read
  // once and shared by the CREATE build and the match below.
  const poRows = deps.loadRows ? await deps.loadRows() : (await loadAfPoRows(query)).rows;
  const loadRows = async () => poRows;

  // CREATE candidates: full selection rules incl. creation floor + guards.
  const build = await buildVelocityRecords(from, to, { query, loadRows });

  // Matching needs the FULL sheet (audit is status-bound, not date-bound) and
  // the full Velocity list.
  // COMPLETE coverage (2026-08-11): /inbound + /inventory + shipment details.
  // A completed order must MATCH (landing in the shipped/closed buckets) —
  // never classify as CREATE (the duplicate-send near-miss, 2026-08-07).
  // fetchAllKnownOrders is fail-closed: any leg failing throws, the plan
  // build fails, and NOTHING is classified — no partial match set.
  const sheetRows = poRows;
  const velocityOrders = await fetchAllKnownOrders();

  // §11 Part B.3 (2026-09-21): the plan is a preview (dryRun by nature), so
  // the identity recording it WOULD do is computed and reported — never
  // written. The execute path does the writing after its own fetch.
  const wouldRecordRows: BundleIdentityRow[] = recordableBundles(velocityOrders);

  // §11 Part C.2 (2026-09-21): hydration order for a child-less shipment
  // bundle is (a) in-batch from the list legs by order_id — already done
  // inside fetchAllKnownOrders — then (b) from velocity_bundle_identity by
  // order_id. A hydrated parent gets child order numbers and flows through
  // the SAME child-derived match keys as any list-visible bundle, so it
  // classifies as matched and counts under "shipped".
  // §11 Part C.2/C.3 — ONE shared implementation with execute (2026-09-24).
  const { unplaced: unplacedBundles } = await hydrateChildlessBundles(velocityOrders, { query });

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

  // Skips follow the same rule as creates: a row Velocity already has is not
  // "skipped", it is done (its quantity audit lives in updates).
  build.skips = dropSkipsKnownToVelocity(build.skips, matchedVelocityByKey);

  // CREATE = build output minus anything matched in Velocity.
  const creates = build.records.filter(
    (r) => !matchedVelocityByKey.has(normKey(r.order_number, r.asin)),
  );
  // Bundle CREATE dedup: ANY child-derived key already known in Velocity
  // means the bundle exists — never re-send (SPEC §11 Bundles).
  //
  // §11 Part D (2026-09-21, replaces the 2026-09-02 ASIN-wide suppression):
  // only a group that could BE an unplaced parent is held, and only by that
  // parent. Candidate = same ASIN + derived total units = the parent's
  // quantity (bundle total) + sheet order date within ±1 calendar day of the
  // Velocity date. The ±1 day exists because 2 of the 5 legacy bundles are
  // dated one day after their sheet order (dashboard UTC-default hypothesis).
  // Every OTHER group of that ASIN proceeds normally — the whole point.
  const unplacedInfo = unplacedBundles.map((o) => ({
    velocity_order_id: String((o as any).order_id ?? ""),
    asin: String(o.asin ?? "").toUpperCase(),
    date: String(o.date ?? ""),
    quantity: numOrNull(o.quantity),
    units_per_pack: (o as any).units_per_pack ?? null,
    amazon_sku: (o as any).amazon_sku ?? null,
    item_name: o.item_name ?? null,
    created_at: (o as any).created_at ?? null,
    shipment_ids: ((o as any).__shipment_ids ?? []) as string[],
    candidateOrderNumbers: [] as string[],
  }));

  const bundleCreates: typeof build.bundles = [];
  for (const b of build.bundles) {
    if (b.orderNumbers.some((n) => matchedVelocityByKey.has(normKey(n, b.asin)))) continue;
    const holders = unplacedInfo.filter((u) =>
      u.asin === b.asin.toUpperCase() &&
      u.quantity !== null && u.quantity === numOrNull(b.quantity) &&
      withinOneDay(b.date, u.date));
    if (holders.length > 0) {
      for (const h of holders) h.candidateOrderNumbers.push(b.orderNumbers[0] ?? "");
      build.skips.push({
        reason: "bundle_unplaced_candidate",
        orderNumber: b.orderNumbers[0] ?? "", asin: b.asin, itemName: b.item_name,
        row: { date: b.date, retailer: null, quantity: String(b.quantity), soldAs: "bundle", unitsPerPack: String(b.units_per_pack) },
        unplaced: holders.map((h) => ({
          velocity_order_id: h.velocity_order_id, date: h.date, quantity: h.quantity,
          units_per_pack: h.units_per_pack, amazon_sku: h.amazon_sku,
          item_name: h.item_name, created_at: h.created_at,
        })),
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
    homeCreates: build.homeRecords.filter((r) => !matchedVelocityByKey.has(normKey(r.order_number, r.asin))),
    homeBundleCreates: build.homeBundles.filter((b) => !b.orderNumbers.some((n) => matchedVelocityByKey.has(normKey(n, b.asin)))),
    homeSkipped: build.homeSkipped,
    identityWouldRecord: wouldRecordRows,
    // Part C.3/D: unplaced parents, incl. those holding nothing (info only).
    unplacedBundles: unplacedInfo,
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
