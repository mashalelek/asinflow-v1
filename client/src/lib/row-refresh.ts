// Job-finish row refresh (ASINs page performance, 2026-10-18). A finished job
// reloads only the rows of its scope that are on screen — never the full list
// (the full list cost 24–60 s on production, and every open tab used to fire
// one per finished job). A scheduled pass (no scope) refreshes the visible
// rows once. Concurrent requests coalesce: while one refresh is in flight,
// further ASINs queue and go out together once it returns.
import type { AsinResult } from "@shared/schema";

/** The on-screen ASINs a finished job touched: its scope ∩ visible; a job without scope (scheduled pass) → all visible. */
export function rowsToRefresh(job: { scope_asins: string[] | null | undefined }, visible: readonly string[]): string[] {
  const vis = Array.from(new Set(visible.map((a) => a.toUpperCase())));
  if (job.scope_asins == null) return vis;
  const scope = new Set(job.scope_asins.map((a) => String(a).toUpperCase()));
  return vis.filter((a) => scope.has(a));
}

/** Replace the refreshed rows in place; a requested row the server no longer returns (e.g. now dead) leaves the list. */
export function mergeRefreshedRows(prev: readonly AsinResult[], fresh: readonly AsinResult[], requested: readonly string[]): AsinResult[] {
  const byAsin = new Map(fresh.map((r) => [r.asin.toUpperCase(), r]));
  const asked = new Set(requested.map((a) => a.toUpperCase()));
  const out: AsinResult[] = [];
  for (const r of prev) {
    const k = r.asin.toUpperCase();
    if (byAsin.has(k)) out.push(byAsin.get(k)!);
    else if (!asked.has(k)) out.push(r);
  }
  return out;
}

/**
 * One refresh at a time per tab: `request(asins)` sends now if idle, else
 * queues; the queue goes out as one request when the current one returns.
 * `seenJob(id)` is true the first time only — a job is handled once.
 */
export class RowRefresher {
  private inFlight = false;
  private pending = new Set<string>();
  private seen = new Set<number>();
  constructor(private send: (asins: string[]) => Promise<void>) {}
  seenJob(id: number): boolean { if (this.seen.has(id)) return false; this.seen.add(id); return true; }
  async request(asins: readonly string[]): Promise<void> {
    for (const a of asins) this.pending.add(a.toUpperCase());
    if (this.inFlight || this.pending.size === 0) return;
    this.inFlight = true;
    try {
      while (this.pending.size > 0) {
        const batch = Array.from(this.pending); this.pending.clear();
        try { await this.send(batch); } catch { /* a failed refresh leaves the rows as they were */ }
      }
    } finally { this.inFlight = false; }
  }
}

/** The stale rows now on screen — removed from the stale set as they are handed out for refresh. */
export function staleRowsDue(stale: Set<string>, onScreen: readonly string[]): string[] {
  const due: string[] = [];
  for (const a of onScreen) { const k = a.toUpperCase(); if (stale.has(k)) { due.push(k); stale.delete(k); } }
  return due;
}
