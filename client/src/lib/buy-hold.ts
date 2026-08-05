// Buy List + On Hold persistence — SHARED between the main ASINs page and
// the §21 Bulk Profit Calculator. Both pages read and write the SAME
// localStorage keys, so carting an ASIN on one page shows on the other.
// Single source of truth for the keys (§14: two representations of one
// logical set is a bug).

const BUY_LIST_KEY = "fba-buy-list";
const ON_HOLD_LIST_KEY = "fba-on-hold-list";

export function loadBuyList(): Set<string> {
  try {
    const stored = localStorage.getItem(BUY_LIST_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

export function saveBuyList(set: Set<string>) {
  localStorage.setItem(BUY_LIST_KEY, JSON.stringify(Array.from(set)));
}

export function loadOnHoldList(): Set<string> {
  try {
    const stored = localStorage.getItem(ON_HOLD_LIST_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

export function saveOnHoldList(set: Set<string>) {
  localStorage.setItem(ON_HOLD_LIST_KEY, JSON.stringify(Array.from(set)));
}
