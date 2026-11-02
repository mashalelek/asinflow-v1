// Schedule definition (SPEC §11 "Refresh job", scheduler patch decision 7).
//
// ONE definition in Eastern time — never host-local again (the old crons'
// "EST/UTC" comments described a timezone they never passed, so they fired
// in host time). Written as cron lines for the record:
//
//   0 0 * * *       enqueue refresh { trigger: scheduled, include_daily: true }
//   0 4-23 * * *    enqueue refresh { trigger: scheduled, include_daily: false }
//
// One pass at 00:00 ET that also runs the daily block (components 2–8); no
// passes 01–03; hourly passes 04:00–23:00. 21 passes a day. Gated by
// ENABLE_CRONS === 'true' in server/index.ts.
//
// No stacking (Maria, 2026-10-16): at most ONE scheduled pass waits at any
// time. A tick that finds a scheduled pass already QUEUED does not enqueue
// (the 00:00 tick instead promotes that queued pass to carry the daily
// block); a tick that finds one RUNNING but none queued enqueues as before
// and the job waits. Queued MANUAL jobs (Refresh button, backfill) do not
// count — a long manual job delays the next pass but never produces
// back-to-back identical passes.
//
// The timer is OURS (2026-11-01): one setTimeout per pass, armed at the
// instant `nextPassAfter` returns. node-cron 4.2.1 computed the next run by
// editing the wall-clock fields of a date and re-reading them with the UTC
// offset of the date it started from, so a walk that crossed a DST change
// landed on the wrong instant: after the 22:00 EDT pass of 2026-10-31 it
// scheduled the next hourly run for 23:00 EST on 2026-11-01 — no 23:00 EDT
// pass, none of Nov 1's 04:00–22:00 EST passes (jobs #364 → #367 were
// nine passes apart; the restart at the deploy recomputed from a post-DST
// date and the 13:00 EST pass fired). The spring-forward walk lost the
// 04:00 EDT pass and the following day's midnight pass the same way.
// `nextPassAfter` walks hour-aligned UTC instants and asks Intl for each
// one's ET hour, so there is no offset to carry; its DST tests are the
// schedule's DST tests.
//
// Express-free; the clock, the timer and the enqueue are injectable so the
// tests drive the chain across both DST nights without waiting.
import { enqueueJob, listActive, setIncludeDaily, type EnqueueInput } from "./jobs-repo";
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

export interface ScheduleTimer {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ScheduleDeps {
  query?: QueryLike;
  enqueue?: (input: EnqueueInput) => Promise<JobRow>;
  /** Injected clock (tests drive the chain without waiting). */
  now?: () => Date;
  /** Injected timer (tests capture the armed instants). */
  timer?: ScheduleTimer;
}

/** A tick that fires this late is logged (the event loop was blocked, or the host slept). */
export const LATE_TICK_WARN_MS = 60_000;

export interface ScheduleHandle {
  stop: () => void;
  /** Runs one tick as the schedule would, without waiting for the clock (the local dry run). */
  tick: (includeDaily: boolean) => Promise<JobRow>;
}

/**
 * The tick handler. At most one scheduled pass waits at any time:
 *  - a scheduled pass already QUEUED → skip (the 00:00 tick promotes it to
 *    include the daily block instead); the queued job is returned;
 *  - otherwise enqueue one; if a pass is RUNNING the new one waits, and the
 *    log says so.
 * Only scheduled jobs count; a queued manual job never suppresses a tick.
 */
export async function runScheduledTick(includeDaily: boolean, deps: ScheduleDeps = {}, now: Date = new Date()): Promise<JobRow> {
  const enqueue = deps.enqueue ?? ((input: EnqueueInput) => enqueueJob(input, deps.query));
  const active = await listActive(deps.query);
  const label = includeDaily ? "(midnight, daily block)" : "(hourly)";
  const hh = String(etParts(now).hour).padStart(2, "0");

  const queued = active.find((j) => j.status === "queued" && j.trigger === "scheduled");
  if (queued) {
    if (includeDaily && !queued.include_daily) {
      const promoted = await setIncludeDaily(queued.id, deps.query);
      scheduleLog(`tick ${hh}:00 skipped — scheduled pass #${queued.id} already queued; promoted to carry the daily block`);
      return promoted ?? queued;
    }
    scheduleLog(`tick ${hh}:00 skipped — scheduled pass #${queued.id} already queued`);
    return queued;
  }

  // Lane S only: a running manual/onboarding/bulk job is in the other lane
  // and never delays a scheduled pass.
  const running = active.find((j) => j.status === "running" && j.trigger === "scheduled");
  const job = await enqueue({ trigger: "scheduled", includeDaily, scopeAsins: null });
  if (running) {
    scheduleLog(`scheduled pass ${label} enqueued as job ${job.id} — scheduled pass #${running.id} is still running (overrun); it waits`);
  } else {
    scheduleLog(`scheduled pass ${label} enqueued as job ${job.id}`);
  }
  return job;
}

/**
 * Arm the schedule: one timer per pass, at the instant `nextPassAfter`
 * returns for the clock now; when it fires, run the tick and re-arm from
 * that pass's instant (never from a clock that may read a few ms early,
 * which would arm the same pass twice). A late wake-up still runs its pass
 * (late, not lost) and re-arms from the clock, so a wake-up more than one
 * pass late skips the passes it slept through — no stacking, as before.
 * Call only when ENABLE_CRONS === 'true'.
 */
export function startSchedule(deps: ScheduleDeps = {}): ScheduleHandle {
  const now = deps.now ?? (() => new Date());
  const timer: ScheduleTimer = deps.timer ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let handle: unknown = null;
  let stopped = false;

  const arm = (from: Date) => {
    if (stopped) return;
    const next = nextPassAfter(from);
    const delay = Math.max(0, next.at.getTime() - now().getTime());
    handle = timer.setTimeout(async () => {
      handle = null;
      const fired = now();
      const late = fired.getTime() - next.at.getTime();
      if (late > LATE_TICK_WARN_MS) scheduleLog(`tick for ${next.at.toISOString()} fired ${Math.round(late / 60_000)} min late`);
      try { await runScheduledTick(next.includeDaily, deps, fired); }
      catch (err: any) { scheduleLog(`scheduled tick failed to enqueue: ${err?.message ?? err}`); }
      arm(new Date(Math.max(next.at.getTime(), now().getTime())));
    }, delay);
  };

  arm(now());
  const next = nextPassAfter(now());
  scheduleLog(`schedule registered (${SCHEDULE_TZ}): "${MIDNIGHT_EXPR}" daily block, "${HOURLY_EXPR}" hourly, own timer on nextPassAfter; next pass ${next.at.toISOString()}${next.includeDaily ? " (daily block)" : ""}`);
  return {
    stop: () => { stopped = true; if (handle != null) timer.clearTimeout(handle); handle = null; },
    tick: (includeDaily) => runScheduledTick(includeDaily, deps),
  };
}
