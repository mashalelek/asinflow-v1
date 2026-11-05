// Born-closed poll (SPEC §18 "Close-after-create", Maria 2026-11-04). Every
// new offer — Add to SC and Relist — is closed right after creation; the
// close used to wait for the §19 auto-verify ladder (in-process timers at
// 1 / 3 / 10 / 30 / 60 min, lost on any restart), and on 2026-11-04 the 22
// Add to SC listings created at 3:19 PM ET were closed at 6:37 PM although
// Amazon had them ~1 minute after submission (summaries.createdDate). This
// poll reads its work from the database, so a restart loses nothing: every
// minute, each submission younger than 30 minutes that is not
// open_on_create and has no live close since it was submitted is probed
// (getListingsItem through verifyPending, which closes on the first probe
// that sees the listing; a row already 'live' is closed directly). After 30
// minutes §19 takes over as before (the sweep, the pill, component 22).
import { query as defaultQuery } from "./db";
import { verifyPending } from "./listing-submissions-repo";
import { closeAfterCreate } from "./listing-hygiene-run";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export const BORN_CLOSED_POLL_MS = 60 * 1000;
export const BORN_CLOSED_WINDOW_MIN = 30;

/** Submissions the poll still owns: younger than the window, not opted open, not failed, no live close since submitted. */
export const BORN_CLOSED_DUE_SQL = `
  SELECT s.id, s.asin, s.sku, s.submitted_at, s.verify_status
    FROM listing_submissions s
   WHERE s.submitted_at >= now() - ($1::int * interval '1 minute')
     AND s.open_on_create IS NOT TRUE
     AND s.verify_status IN ('pending', 'processing', 'live')
     AND NOT EXISTS (SELECT 1 FROM listing_actions a
                      WHERE a.sku = s.sku AND a.action = 'close' AND a.dry_run = FALSE AND a.fired_at >= s.submitted_at)
   ORDER BY s.submitted_at`;

export interface BornClosedDeps {
  query?: QueryLike;
  verify?: typeof verifyPending;
  close?: (query: QueryLike, sellerId: string, row: { asin: string; sku: string; submittedAt: Date | string }) => Promise<unknown>;
}

/** One tick: probe the due submissions; returns how many were due and how many closes were attempted. */
export async function bornClosedTick(sellerId: string, deps: BornClosedDeps = {}): Promise<{ due: number; closes: number }> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const verify = deps.verify ?? verifyPending;
  const close = deps.close ?? ((q, s, r) => closeAfterCreate(q as any, s, r));
  const rows = (await query(BORN_CLOSED_DUE_SQL, [BORN_CLOSED_WINDOW_MIN])).rows;
  if (rows.length === 0) return { due: 0, closes: 0 };
  let closes = 0;
  const hook = async (r: { asin: string; sku: string; submittedAt: Date | string }) => { closes++; return close(query, sellerId, r); };
  const open = rows.filter((r) => r.verify_status !== "live").map((r) => String(r.id));
  if (open.length) await verify(sellerId, { ids: open, query: query as any, closeAfterCreate: hook });
  // 'live' already (seen by an earlier probe whose close did not go out, e.g. a failed pre-flight read): close directly.
  for (const r of rows.filter((x) => x.verify_status === "live")) {
    try { await hook({ asin: r.asin, sku: r.sku, submittedAt: r.submitted_at }); }
    catch (err: any) { console.error(`[born-closed] close failed for ${r.sku}: ${err?.message ?? err}`); }
  }
  return { due: rows.length, closes };
}

/** The minute ticker; ticks never overlap. Started with the schedule (ENABLE_CRONS=true). */
export function startBornClosedPoll(sellerId: string, log: (m: string) => void = console.log): { stop: () => void } {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await bornClosedTick(sellerId);
      if (r.due) log(`born-closed poll: ${r.due} new submission(s) due, ${r.closes} close(s) sent`);
    } catch (err: any) { log(`born-closed poll failed: ${err?.message ?? err}`); }
    finally { busy = false; }
  }, BORN_CLOSED_POLL_MS);
  (t as any).unref?.();
  return { stop: () => clearInterval(t) };
}
