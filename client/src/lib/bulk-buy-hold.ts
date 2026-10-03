// Bulk Buy List / Hold — the pure decision layer behind the frozen-header
// cart and clock buttons (SPEC §21 "Bulk Buy List / Hold", 2026-10-03).
//
// Kept out of the page components because the toggle direction is the part
// with real semantics: a mixed selection must resolve to ADD-the-missing,
// never to a partial add-and-remove, and only an all-in selection removes.
// Both pages and the tests drive THIS function, so the two pages cannot
// drift apart.

export type BulkSetDirection = "add" | "remove";

export interface BulkSetPlan {
  direction: BulkSetDirection;
  /** The ASINs the action actually writes. Empty only when `selected` is empty. */
  targets: string[];
  /** Every selected ASIN, direction aside — what the tooltip counts. */
  selectedCount: number;
}

/**
 * Resolve what a bulk set-toggle would do, without doing it.
 *
 * ALL selected already in the set  -> remove all of them
 * otherwise                        -> add the ones not yet in it (remove none)
 *
 * An empty selection yields an empty plan; callers disable the control
 * rather than calling with nothing (§14 — a bulk write states its blast
 * radius, and "no selection" is never "everything").
 */
export function planBulkSetToggle(selected: string[], current: ReadonlySet<string>): BulkSetPlan {
  if (selected.length === 0) return { direction: "add", targets: [], selectedCount: 0 };
  const allIn = selected.every((a) => current.has(a));
  return allIn
    ? { direction: "remove", targets: [...selected], selectedCount: selected.length }
    : { direction: "add", targets: selected.filter((a) => !current.has(a)), selectedCount: selected.length };
}

/**
 * Tooltip text. States the resolved direction and the count BEFORE the
 * click, so the button never surprises (§14).
 */
export function bulkToggleLabel(plan: BulkSetPlan, setName: "Buy List" | "Hold"): string {
  if (plan.selectedCount === 0) return "Select rows first";
  const verb = plan.direction === "remove" ? "Remove" : "Add";
  const prep = plan.direction === "remove" ? "from" : "to";
  // Count reported is the SELECTION, not the write size: "Add 52 to Buy
  // List" when 30 of the 52 are already there is what the operator means.
  return `${verb} ${plan.selectedCount} ${prep} ${setName}`;
}

/**
 * Which of the plan's targets still need promoting into `asins`. Bulk Calc
 * only — the main page has no bulk-only ASINs. Never promotes on the remove
 * direction.
 */
export function promoteTargets(plan: BulkSetPlan, inDb: ReadonlySet<string>): string[] {
  if (plan.direction === "remove") return [];
  return plan.targets.filter((a) => !inDb.has(a));
}

/**
 * Apply one bulk plan to a set, honouring Buy/Hold mutual exclusion.
 * Returns BOTH next sets so the caller writes them together — the single-row
 * path already enforces that adding to one removes from the other, and the
 * bulk path must not diverge.
 *
 * `landed` is the subset that may be written: on the add direction it
 * excludes ASINs whose promote errored (SPEC §21 rule 4).
 */
export function applyBulkPlan(
  plan: BulkSetPlan,
  landed: ReadonlySet<string>,
  sets: { target: ReadonlySet<string>; other: ReadonlySet<string> },
): { target: Set<string>; other: Set<string> } {
  const target = new Set(sets.target);
  const other = new Set(sets.other);
  for (const asin of plan.targets) {
    if (!landed.has(asin)) continue;
    if (plan.direction === "add") {
      target.add(asin);
      other.delete(asin); // Buy and Hold are mutually exclusive
    } else {
      target.delete(asin); // removing never touches the other set
    }
  }
  return { target, other };
}
