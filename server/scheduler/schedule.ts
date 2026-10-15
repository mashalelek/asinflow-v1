// Schedule definition (SPEC §11 "Refresh job", scheduler patch decision 7).
//
// ONE definition, node-cron with `timezone: 'America/New_York'` passed
// explicitly — never host-local again (the old crons' "EST/UTC" comments
// described a timezone they never passed, so they fired in host time).
//
//   0 0 * * *       enqueue refresh { trigger: scheduled, include_daily: true }
//   0 4-23 * * *    enqueue refresh { trigger: scheduled, include_daily: false }
//
// One pass at 00:00 ET that also runs the daily block (components 2–8); no
// passes 01–03; hourly passes 04:00–23:00. 21 passes a day. Gated by
// ENABLE_CRONS === 'true' in server/index.ts. If a pass is still running
// when the next tick fires, the tick enqueues anyway and the job waits —
// the queue is the lock; the log shows the overrun.
//
// Express-free; the cron library, the enqueue and the clock are injectable
// so the tests drive the ticks and the DST arithmetic without a timer.
import cron from "node-cron";
import { enqueueJob, listActive, type EnqueueInput } from "./jobs-repo";
import type { JobRow, QueryLike } from "./types";

export const SCHEDULE_TZ = "America/New_York";
export const MIDNIGHT_EXPR = "0 0 * * *";   // the pass that includes the daily block
export const HOURLY_EXPR = "0 4-23 * * *";  // the other twenty

/** Which wall-clock ET hours a pass starts at (decision 7). */
export function isPassHour(etHour: number): boolean {
  return etHour === 0 || (etHour >= 4 && etHour <= 23);
}

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** Wall-clock parts of an instant in Eastern time. */
export function etParts(d: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const p: Record<string, number> = {};
  for (const part of ET_FMT.formatToParts(d)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute };
}

/**
 * The first pass strictly after `from`: its instant and whether it is the
 * midnight pass. Walks hour-aligned UTC instants and reads each one's ET
 * hour, so DST is whatever Intl says it is: the fall-back hour (01:00 ET
 * twice) and the spring-forward gap (no 02:00 ET) both fall inside the
 * 01–03 window where nothing fires anyway.
 */
export function nextPassAfter(from: Date): { at: Date; includeDaily: boolean } {
  const start = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let k = 0; k < 48; k++) {
    const at = new Date(start.getTime() + k * 3_600_000);
    const h = etParts(at).hour;
    if (isPassHour(h)) return { at, includeDaily: h === 0 };
  }
  throw new Error("no pass within 48 hours — the schedule definition is broken");
}

type Logger = (message: string) => void;
let scheduleLog: Logger = (m) => console.log(`[schedule] ${m}`);
export function setScheduleLogger(fn: Logger): void { scheduleLog = fn; }

export interface ScheduleDeps {
  query?: QueryLike;
  enqueue?: (input: EnqueueInput) => Promise<JobRow>;
  /** Injected cron library (tests pass a fake that captures the registrations). */
  cronLib?: { schedule: (expr: string, fn: () => unknown, opts: { timezone: string; name?: string }) => { stop(): unknown } };
}

export interface ScheduleHandle {
  stop: () => void;
  /** Runs one tick as the schedule would, without waiting for the clock (the local dry run). */
  tick: (includeDaily: boolean) => Promise<JobRow>;
}

/** The tick handler: enqueue one scheduled pass; say so if one is still running. */
export async function runScheduledTick(includeDaily: boolean, deps: ScheduleDeps = {}): Promise<JobRow> {
  const enqueue = deps.enqueue ?? ((input: EnqueueInput) => enqueueJob(input, deps.query));
  const active = await listActive(deps.query);
  const running = active.find((j) => j.status === "running");
  const job = await enqueue({ trigger: "scheduled", includeDaily, scopeAsins: null });
  if (running) {
    scheduleLog(`scheduled pass ${includeDaily ? "(midnight, daily block)" : "(hourly)"} enqueued as job ${job.id} — job ${running.id} is still running (overrun); it waits behind ${active.length} active`);
  } else {
    scheduleLog(`scheduled pass ${includeDaily ? "(midnight, daily block)" : "(hourly)"} enqueued as job ${job.id}`);
  }
  return job;
}

/** Register both cron lines. Call only when ENABLE_CRONS === 'true'. */
export function startSchedule(deps: ScheduleDeps = {}): ScheduleHandle {
  const lib = deps.cronLib ?? cron;
  const guard = (includeDaily: boolean) => async () => {
    try { await runScheduledTick(includeDaily, deps); }
    catch (err: any) { scheduleLog(`scheduled tick failed to enqueue: ${err?.message ?? err}`); }
  };
  const midnight = lib.schedule(MIDNIGHT_EXPR, guard(true), { timezone: SCHEDULE_TZ, name: "refresh-midnight" });
  const hourly = lib.schedule(HOURLY_EXPR, guard(false), { timezone: SCHEDULE_TZ, name: "refresh-hourly" });
  const next = nextPassAfter(new Date());
  scheduleLog(`schedule registered (${SCHEDULE_TZ}): "${MIDNIGHT_EXPR}" daily block, "${HOURLY_EXPR}" hourly; next pass ${next.at.toISOString()}${next.includeDaily ? " (daily block)" : ""}`);
  return {
    stop: () => { midnight.stop(); hourly.stop(); },
    tick: (includeDaily) => runScheduledTick(includeDaily, deps),
  };
}
