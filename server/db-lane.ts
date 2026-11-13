// The database lane (2026-11-13, SPEC §24 "Database pools"): which pool `query` / the default pool in server/db.ts use.
// "web" (the default) is every request handler with a 15 s statement limit; "job" is the scheduler's lanes — the runner
// wraps runJob in runInDbLane("job"), and every query made while that job runs, through any module, goes to the job pool
// with its own, longer limit. AsyncLocalStorage follows the awaits, so no call site names a pool. No pg here: the
// runner and its tests import this module without constructing a pool.
import { AsyncLocalStorage } from "node:async_hooks";

export type DbLane = "web" | "job";

const lane = new AsyncLocalStorage<DbLane>();

/** The lane of the current async context ("web" outside any runInDbLane). */
export function currentDbLane(): DbLane {
  return lane.getStore() ?? "web";
}

/** Run `fn` with every db query inside it on `l`'s pool. */
export function runInDbLane<T>(l: DbLane, fn: () => Promise<T>): Promise<T> {
  return lane.run(l, fn);
}
