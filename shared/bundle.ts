// Bundles (Maria 2026-11-09, walmart 200015415094735 B0GWG5S64Q). A bundle's
// "×N" (po_asins.units_per_pack) is the TOTAL Individual units in one bundle —
// the same meaning a multi-pack's ×N has. Each component line carries "units
// of this component per bundle" (po_line_items.units_per_bundle, integer ≥ 1);
// the components' counts must sum to N. When AF does not know the split it
// PROPOSES an even one (×2 with 2 components → 1 + 1) for Maria to confirm;
// a "(6 pack)" in a title never sets it.
//
//   line Individual units   = qty ordered × Individual units per Product unit (retailer_units_per_product; NULL reads as 1)
//   bundles a component builds = its Individual units ÷ its per-bundle count
//   bundle ASIN units       = min over components (2 dp)
//   leftover (per component) = its Individual units − ASIN units × its per-bundle count   (shown, never hidden)
//   bundle Cost/Unit (pre share) = Σ component per-Individual cost × per-bundle count
//                                  (per-Individual cost = the line's unit money ÷ its Individual units per Product unit)
//   bundle row's Individual count = ASIN units × N
// The PO's tax / shipping / discount share is applied by shared/po-cost.ts (bundleAsinCosts), per the COGS rule.
//
// Before this rule (migration 080 model) a bundle's ×N was each component line's
// yield denominator (qty × retailer ÷ N) — right only when every component is a
// single and N = the component count — and the bundle's cost summed the
// component lines' money regardless of their packs.

export interface BundleLine {
  qty_ordered: number | string | null;
  /** Individual units per Product unit (the retailer's pack); NULL reads as 1 — or, with no pack and a stored yield, the legacy reading below. */
  retailer_units_per_product?: number | string | null;
  /**
   * A line without its pack integers (an unresolved sheet import) keeps its stored yield (migration 080 model): the bundles
   * it builds = qty × yield, so its Individual units read as qty × yield × its per-bundle count.
   */
  asin_qty_per_product?: number | string | null;
  /** Units of this component in one bundle; NULL = not known (an even split is proposed). */
  units_per_bundle?: number | string | null;
  /** The line's unit money (price, or line total ÷ qty); optional — only the cost needs it. */
  unit_money?: number | null;
}

export interface BundleComponent {
  individual: number;
  perBundle: number;
  /** The per-bundle count was proposed (even split), not stored. */
  proposed: boolean;
  /** Bundles this component alone could build (individual ÷ perBundle, 2 dp). */
  builds: number;
  /** Individual units of this component left over after the bundles (2 dp). */
  leftover: number;
  /** This component's cost in one bundle: per-Individual cost × perBundle; null without money. */
  costShare: number | null;
}

export interface BundleResult {
  /** The bundle's ASIN units: the scarcest component's builds (2 dp). */
  asinUnits: number;
  /** ASIN units × N. */
  individual: number;
  components: BundleComponent[];
  /** Σ per-bundle counts. */
  sumPerBundle: number;
  /** Σ per-bundle counts = N. */
  sumMatches: boolean;
  /** Every component's per-bundle count is stored (none proposed). */
  splitKnown: boolean;
  /** An even split could be proposed (N ÷ components is a whole number) — false when some count is missing and N does not divide. */
  splitProposable: boolean;
  /** Any component has leftover Individual units. */
  hasLeftover: boolean;
  /** Σ component cost shares — the bundle's Cost/Unit before the PO's tax / shipping share; null when a line lacks money. */
  costPreShare: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: number | string | null | undefined): number | null => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const posInt = (v: number | string | null | undefined): number | null => { const n = num(v); return n != null && Number.isInteger(n) && n >= 1 ? n : null; };

/** The even split AF proposes when the counts are unknown: N ÷ components when whole, else null. */
export function evenSplit(n: number | null, components: number): number | null {
  if (n == null || components < 1 || !Number.isInteger(n) || n < 1) return null;
  return n % components === 0 ? n / components : null;
}

/** Pure: the bundle rule over its component lines at pack N (po_asins.units_per_pack). */
export function bundleFromLines(lines: ReadonlyArray<BundleLine>, n: number | string | null | undefined): BundleResult {
  const N = posInt(n);
  const even = evenSplit(N, lines.length);
  const comps = lines.map((l) => {
    const qty = num(l.qty_ordered) ?? 0;
    const stored = posInt(l.units_per_bundle);
    const perBundle = stored ?? even ?? 1;
    const packKnown = posInt(l.retailer_units_per_product) != null;
    const legacyYield = !packKnown && num(l.asin_qty_per_product) != null && Number(l.asin_qty_per_product) > 0 ? Number(l.asin_qty_per_product) : null;
    // Individual units: qty × the pack; a line with no pack but a stored yield builds qty × yield bundles (the old model's sets).
    const per = packKnown ? posInt(l.retailer_units_per_product)! : legacyYield != null ? legacyYield * perBundle : 1;
    const individual = r2(qty * per);
    const unit = l.unit_money != null && Number.isFinite(l.unit_money) ? l.unit_money : null;
    return { individual, perBundle, proposed: stored == null, builds: r2(individual / perBundle), costShare: unit == null ? null : (unit / per) * perBundle };
  });
  const asinUnits = comps.length === 0 ? 0 : Math.min(...comps.map((c) => c.builds));
  const components: BundleComponent[] = comps.map((c) => ({ ...c, leftover: r2(c.individual - asinUnits * c.perBundle), costShare: c.costShare == null ? null : r2(c.costShare) }));
  const sumPerBundle = components.reduce((t, c) => t + c.perBundle, 0);
  const costPreShare = comps.some((c) => c.costShare == null) || comps.length === 0 ? null : r2(comps.reduce((t, c) => t + (c.costShare ?? 0), 0));
  return {
    asinUnits, individual: N == null ? asinUnits : r2(asinUnits * N), components, sumPerBundle,
    sumMatches: N != null && sumPerBundle === N,
    splitKnown: comps.length > 0 && comps.every((c) => !c.proposed),
    splitProposable: comps.every((c) => !c.proposed) || even != null,
    hasLeftover: components.some((c) => c.leftover > 0.005),
    costPreShare,
  };
}

/** The message the form and the Products tab show when the components' per-bundle counts do not add up to N. */
export function bundleSplitMessage(r: BundleResult, n: number | null): string | null {
  if (n == null) return null;
  if (r.sumMatches) return null;
  return `the components' units per bundle add up to ${r.sumPerBundle}, not ×${n}`;
}
