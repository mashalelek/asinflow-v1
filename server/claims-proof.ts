// The before / after proof of claims commit 1 (migration 101, SPEC patch §9): pure comparisons the dry run
// (script/claims-commit1-dryrun.ts) applies to the three readers computed the OLD way on the pre-migration
// database (server/__fixtures__/claims-before-readers.ts) and the NEW way after the migration ran in the same
// transaction — On Order per ASIN, the auto-close verdict per PO, the Velocity plan — and to the row-level
// SheetRows the plan is built from. Identical = nothing listed.
export interface Pipeline { on_order: number; at_prep: number; at_warehouse: number; open_po_count: number }
export interface Diff { key: string; field: string; before: string; after: string }

const r2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const same = (a: unknown, b: unknown) => Math.abs(r2(a) - r2(b)) < 0.005;

/** On Order / At Prep / At CQG Warehouse / open PO count per ASIN, 2 dp. */
export function comparePipelines(before: Map<string, Pipeline>, after: Map<string, Pipeline>): Diff[] {
  const out: Diff[] = [];
  for (const asin of Array.from(new Set(Array.from(before.keys()).concat(Array.from(after.keys()))))) {
    const b = before.get(asin), a = after.get(asin);
    for (const f of ["on_order", "at_prep", "at_warehouse", "open_po_count"] as const) {
      const bv = b?.[f] ?? null, av = a?.[f] ?? null;
      if (bv == null || av == null ? bv !== av : !same(bv, av)) out.push({ key: asin, field: f, before: String(bv), after: String(av) });
    }
  }
  return out;
}

/** The auto-close verdict per PO (true = would close / stay closed). */
export function compareVerdicts(before: Map<string, { verdict: boolean }>, after: Map<string, { verdict: boolean }>): Diff[] {
  const out: Diff[] = [];
  for (const po of Array.from(new Set(Array.from(before.keys()).concat(Array.from(after.keys()))))) {
    const b = before.get(po)?.verdict, a = after.get(po)?.verdict;
    if (b !== a) out.push({ key: po, field: "verdict", before: String(b), after: String(a) });
  }
  return out;
}

/** The fields of server/velocity-reconcile.ts's VelocityPlan the proof reads. */
export interface PlanLike {
  creates: Array<{ order_number: string; asin: string; quantity: string }>;
  bundleCreates: Array<{ orderNumbers: string[]; asin: string; quantity: number; units_per_pack: number }>;
  updates: Array<{ order_number: string; asin: string; actionable: boolean; diffs: Array<{ field: string; sheet?: unknown; velocity?: unknown }> }>;
  skips: Array<{ orderNumber: string | null; asin: string | null; reason: string }>;
  deleteCandidates: Array<{ order_number?: string; asin?: string }>;
  unchanged: number; closedInVelocity: number; unmatchedVelocity: number;
  homeCreates: Array<{ order_number: string; asin: string; quantity: string }>;
  homeBundleCreates: Array<{ orderNumbers: string[]; asin: string; quantity: number; units_per_pack: number }>;
}
/** Per (order #, ASIN): create (with its quantity) / update (with its diffs) / skip (reason) / delete candidate / home create; plus the counts. */
export function planByKey(p: PlanLike): Map<string, string> {
  const m = new Map<string, string>();
  const k = (o: unknown, a: unknown) => `${String(o ?? "").trim()}|${String(a ?? "").trim().toUpperCase()}`;
  for (const c of p.creates ?? []) m.set(k(c.order_number, c.asin), `create ${c.quantity}`);
  for (const b of p.bundleCreates ?? []) m.set(k(b.orderNumbers[0], b.asin), `create bundle ${b.quantity} (×${b.units_per_pack})`);
  for (const u of p.updates ?? []) m.set(k(u.order_number, u.asin), `update${u.actionable ? "" : " (flag-only)"} ${u.diffs.map((d) => `${d.field}: ${d.sheet} vs ${d.velocity}`).join("; ")}`);
  for (const s of p.skips ?? []) m.set(k(s.orderNumber, s.asin), `skip ${s.reason}`);
  for (const d of p.deleteCandidates ?? []) m.set(k(d.order_number, d.asin), `delete-candidate`);
  for (const h of p.homeCreates ?? []) m.set(k(h.order_number, h.asin), `home ${h.quantity}`);
  for (const b of p.homeBundleCreates ?? []) m.set(k(b.orderNumbers[0], b.asin), `home bundle ${b.quantity} (×${b.units_per_pack})`);
  return m;
}
export function comparePlans(before: PlanLike, after: PlanLike): Diff[] {
  const out: Diff[] = [];
  const b = planByKey(before), a = planByKey(after);
  for (const key of Array.from(new Set(Array.from(b.keys()).concat(Array.from(a.keys()))))) if ((b.get(key) ?? "—") !== (a.get(key) ?? "—")) out.push({ key, field: "plan", before: b.get(key) ?? "—", after: a.get(key) ?? "—" });
  for (const f of ["unchanged", "closedInVelocity", "unmatchedVelocity"] as const) if (before[f] !== after[f]) out.push({ key: "*", field: f, before: String(before[f]), after: String(after[f]) });
  return out;
}

export interface RowLike { poAsinId?: string; lineNumber?: number; orderNumber: string | null; asin: string; status: string | null; qty: number; quantity: string | null; setsN?: string | null; yieldT?: string | null; unitsPerPack?: string | null; soldAs?: string | null; prepCost: number | null; shipsTo?: string }
/** The plan's input rows per (PO ASIN row, line): the fields the plan reads. */
export function compareRows(before: RowLike[], after: RowLike[]): Diff[] {
  const key = (r: RowLike) => `${r.poAsinId ?? r.orderNumber}#${r.lineNumber ?? 0}`;
  const b = new Map(before.map((r) => [key(r), r])), a = new Map(after.map((r) => [key(r), r]));
  const out: Diff[] = [];
  for (const k of Array.from(new Set(Array.from(b.keys()).concat(Array.from(a.keys()))))) {
    const x = b.get(k), y = a.get(k);
    if (!x || !y) { out.push({ key: k, field: "row", before: x ? "present" : "—", after: y ? "present" : "—" }); continue; }
    for (const f of ["status", "quantity", "setsN", "yieldT", "unitsPerPack", "soldAs", "shipsTo"] as const) if (String(x[f] ?? "") !== String(y[f] ?? "")) out.push({ key: `${x.orderNumber} ${x.asin} #${x.lineNumber ?? 0}`, field: f, before: String(x[f] ?? ""), after: String(y[f] ?? "") });
    if (!same(x.qty, y.qty)) out.push({ key: `${x.orderNumber} ${x.asin} #${x.lineNumber ?? 0}`, field: "qty", before: String(x.qty), after: String(y.qty) });
    if (!same(x.prepCost ?? 0, y.prepCost ?? 0)) out.push({ key: `${x.orderNumber} ${x.asin} #${x.lineNumber ?? 0}`, field: "prepCost", before: String(x.prepCost), after: String(y.prepCost) });
  }
  return out;
}
