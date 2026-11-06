// A list page's scroll position survives leaving it (2026-11-06): saved per
// page and URL query in sessionStorage while scrolling, restored once when the
// page's list first renders (the browser's own restoration runs before an
// async list exists). Used by POs, ASINs and Bulk Calc.
import { useEffect, useRef } from "react";

const keyOf = (page: string) => `af.list-scroll.${page}`;

export function saveListScroll(page: string, query: string, y: number): void {
  try { window.sessionStorage.setItem(keyOf(page), JSON.stringify({ query, y })); } catch { /* private mode */ }
}
export function savedListScroll(page: string, query: string): number | null {
  try { const v = JSON.parse(window.sessionStorage.getItem(keyOf(page)) ?? "null"); return v && v.query === query && typeof v.y === "number" ? v.y : null; } catch { return null; }
}

/**
 * `ready`: the list has rendered. Nothing is saved before the restore, when the short loading page would save 0 over it.
 * `container`: a selector for the element that scrolls instead of the window (the ASINs / Bulk Calc table,
 * `[data-list-scroll="results-table"]`).
 */
export function useListScroll(page: string, ready: boolean, container?: string): void {
  const restored = useRef(false);
  useEffect(() => {
    let raf = 0;
    const el = () => (container ? document.querySelector<HTMLElement>(container) : null);
    const onScroll = (e: Event) => {
      if (!restored.current) return;
      const target = el();
      if (container && e.target !== target) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => saveListScroll(page, window.location.search, target ? target.scrollTop : window.scrollY));
    };
    // Capture: an element's scroll event does not bubble.
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => { window.removeEventListener("scroll", onScroll, { capture: true }); cancelAnimationFrame(raf); };
  }, [page, container]);
  useEffect(() => {
    if (!ready || restored.current) return;
    const y = savedListScroll(page, window.location.search);
    if (y != null) requestAnimationFrame(() => { const target = container ? document.querySelector<HTMLElement>(container) : null; if (target) target.scrollTop = y; else window.scrollTo(0, y); });
    restored.current = true;
  }, [ready, page, container]);
}

/** Rewrite the page's own URL query without a history step (a filter change is not one). */
export function replaceQuery(path: string, query: string): void {
  if (window.location.pathname === path && window.location.search !== query) window.history.replaceState(window.history.state, "", `${path}${query}`);
}
