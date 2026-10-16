// Expand-by-ASIN state for the POs page (patch §3.4): the Expand All flag
// and the per-PO expanded set persist across reloads in localStorage, the
// same per-browser mechanism as the ASINs page's view state (P6). Default:
// all collapsed. Pure helpers are exported for tests.

export const PO_EXPANDED_KEY = "fba-po-expanded";

export interface PoExpandedState {
  /** Expand All on: every PO in the current filtered list renders expanded. */
  all: boolean;
  /** Individually expanded PO ids (only meaningful when `all` is off). */
  ids: string[];
}

export const DEFAULT_PO_EXPANDED: PoExpandedState = { all: false, ids: [] };

export function loadPoExpanded(): PoExpandedState {
  try {
    const raw = localStorage.getItem(PO_EXPANDED_KEY);
    if (!raw) return DEFAULT_PO_EXPANDED;
    const parsed = JSON.parse(raw);
    return { all: parsed?.all === true, ids: Array.isArray(parsed?.ids) ? parsed.ids.filter((x: unknown) => typeof x === "string") : [] };
  } catch {
    return DEFAULT_PO_EXPANDED;
  }
}

export function savePoExpanded(state: PoExpandedState): void {
  try { localStorage.setItem(PO_EXPANDED_KEY, JSON.stringify(state)); } catch { /* storage unavailable — state stays in memory */ }
}

/** Is this PO expanded under the state? */
export function isPoExpanded(state: PoExpandedState, id: string): boolean {
  return state.all || state.ids.includes(id);
}

/** Chevron click: toggle one PO. Under Expand All, collapsing one turns the flag off and keeps the others open. */
export function togglePoExpanded(state: PoExpandedState, id: string, visibleIds: string[]): PoExpandedState {
  if (state.all) {
    return { all: false, ids: visibleIds.filter((x) => x !== id) };
  }
  const ids = state.ids.includes(id) ? state.ids.filter((x) => x !== id) : [...state.ids, id];
  return { all: false, ids };
}

/** Toolbar toggle: Expand All ↔ Collapse All. Collapse All clears the individual set too. */
export function toggleExpandAll(state: PoExpandedState): PoExpandedState {
  return state.all ? { all: false, ids: [] } : { all: true, ids: [] };
}
