// Emails that named an order AF had no PO for yet (2026-11-06). A pass reads
// Gmail from its watermark minus an overlap (6 h documents, 24 h
// confirmations), so a confirmation that arrived longer than that before its
// PO was entered was never read again. Each pass keeps the ones that matched
// no PO here — settings[key] = { message_id: received ISO } — and reads them
// again on every pass for RECHECK_DAYS, and once more when a PO is created
// (POST /api/pos → recheckForNewPo); an email leaves the list when it
// matches, is excluded, or ages out.
import type { QueryLike } from "./scheduler/types";

export const RECHECK_DAYS = 14;
export type RecheckList = Record<string, string>;

/** The stored list, without the entries older than RECHECK_DAYS. */
export async function readRecheck(query: QueryLike, key: string, now: Date): Promise<RecheckList> {
  const v = ((await query(`SELECT value FROM settings WHERE key = $1`, [key])).rows[0]?.value ?? {}) as RecheckList;
  return pruneRecheck(v && typeof v === "object" ? v : {}, now);
}

/** Pure: the entries received within RECHECK_DAYS of `now`. */
export function pruneRecheck(list: RecheckList, now: Date): RecheckList {
  const floor = now.getTime() - RECHECK_DAYS * 86_400_000;
  return Object.fromEntries(Object.entries(list).filter(([, at]) => new Date(at).getTime() >= floor));
}

export async function writeRecheck(query: QueryLike, key: string, list: RecheckList, now: Date): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(pruneRecheck(list, now))],
  );
}

/** Pure: the window's ids then the stored ones it does not already hold. */
export function withRecheck(windowIds: readonly string[], stored: RecheckList): { ids: string[]; rechecked: number } {
  const seen = new Set(windowIds);
  const extra = Object.keys(stored).filter((id) => !seen.has(id));
  return { ids: [...windowIds, ...extra], rechecked: extra.length };
}

/** One at a time per process: a pass and a PO-creation recheck never render the same email twice. */
export function serialized<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...a: A) => {
    const run = tail.then(() => fn(...a), () => fn(...a));
    tail = run.catch(() => undefined);
    return run;
  };
}
