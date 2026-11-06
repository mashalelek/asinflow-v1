// The POs list's state lives in its URL (Maria 2026-11-06): search, Status,
// Refunds, Action Items, Supplier, dates, sort and page are the query
// string, so opening a PO and pressing Back — or "← Back to POs", or
// detail → Edit PO → back — returns to the exact list, scroll included.
// The page rewrites its own URL with replaceState (a filter change is not
// a history step); the last list URL is kept in sessionStorage for the
// links that rebuild it, its scroll by lib/list-scroll.ts.

export type PoClosed = "open" | "closed" | "all";
export type PoRefunds = "any" | "due" | "none";
export interface PoListUrlState {
  search: string; action: string[]; supplier: string[]; closed: PoClosed; refunds: PoRefunds;
  from: string; to: string; sort: { key: string; dir: "asc" | "desc" } | null; page: number;
}

const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
const list = (v: string | null) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Pure: the query string → the list's state. `?asin=B0…` (the ASINs page's On Order link) searches that ASIN. D3: Status defaults to Open. */
export function readPoListUrl(search: string): PoListUrlState {
  const p = new URLSearchParams(search);
  const closed = p.get("closed"), refunds = p.get("refunds"), dir = p.get("dir"), sortKey = p.get("sort")?.trim() ?? "";
  return {
    search: p.get("search")?.trim() ?? p.get("asin")?.trim().toUpperCase() ?? "",
    action: list(p.get("action")), supplier: list(p.get("supplier")),
    closed: closed === "closed" || closed === "all" ? closed : "open",
    refunds: refunds === "due" || refunds === "none" ? refunds : "any",
    from: ymd(p.get("from")), to: ymd(p.get("to")),
    sort: sortKey ? { key: sortKey, dir: dir === "desc" ? "desc" : "asc" } : null,
    page: Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1),
  };
}

/** Pure: the list's state → its query string ("" for the default list); defaults are left out. */
export function writePoListUrl(s: PoListUrlState): string {
  const p = new URLSearchParams();
  if (s.search) p.set("search", s.search);
  if (s.closed !== "open") p.set("closed", s.closed);
  if (s.refunds !== "any") p.set("refunds", s.refunds);
  if (s.action.length) p.set("action", [...s.action].sort().join(","));
  if (s.supplier.length) p.set("supplier", [...s.supplier].sort().join(","));
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  if (s.sort) { p.set("sort", s.sort.key); p.set("dir", s.sort.dir); }
  if (s.page > 1) p.set("page", String(s.page));
  const q = p.toString();
  return q ? `?${q}` : "";
}

const SEARCH_KEY = "af.po-list.search";
const store = () => { try { return window.sessionStorage; } catch { return null; } };

/** Remember the list's query string (each time the page rewrites its URL). */
export function rememberPoList(query: string): void { try { store()?.setItem(SEARCH_KEY, query); } catch { /* private mode */ } }
/** The list as last seen: "/purchase-orders?…" — "← Back to POs" goes here. */
export function poListHref(): string { let q = ""; try { q = store()?.getItem(SEARCH_KEY) ?? ""; } catch { /* none */ } return `/purchase-orders${q}`; }
