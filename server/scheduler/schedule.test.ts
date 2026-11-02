import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  SCHEDULE_TZ, MIDNIGHT_EXPR, HOURLY_EXPR, isPassHour, etParts, nextPassAfter, startSchedule, runScheduledTick, setScheduleLogger,
  LATE_TICK_WARN_MS, type ScheduleDeps,
} from "./schedule";
import type { JobRow, QueryLike } from "./types";

// Scheduler patch commit 5 (decision 7): one pass at 00:00 ET with the daily
// block, none 01–03, hourly 04–23, in Eastern time. The tests pin the
// expressions, the ET arithmetic across both DST boundaries of 2026 (spring
// forward 03-08, fall back 11-01), the timer chain across both nights
// (2026-11-01: node-cron 4.2.1 lost nine passes on fall-back night), and the
// tick handler.

setScheduleLogger(() => {});

/** A clock + timer pair the schedule can be driven with: `fireNext` jumps the clock to the earliest armed instant and runs it. */
function fakeClock(startIso: string) {
  let t = new Date(startIso).getTime();
  const armed: Array<{ fn: () => unknown; at: number }> = [];
  const deps: Pick<ScheduleDeps, "now" | "timer"> = {
    now: () => new Date(t),
    timer: {
      setTimeout: (fn, ms) => { const e = { fn, at: t + ms }; armed.push(e); return e; },
      clearTimeout: (h) => { const i = armed.indexOf(h as any); if (i >= 0) armed.splice(i, 1); },
    },
  };
  return {
    deps,
    armedAt: () => armed.map((e) => new Date(e.at).toISOString()),
    advanceTo: (iso: string) => { t = new Date(iso).getTime(); },
    async fireNext(atOverride?: string) {
      const e = armed.shift();
      if (!e) throw new Error("nothing armed");
      t = atOverride ? new Date(atOverride).getTime() : e.at;
      await e.fn();
      return new Date(t);
    },
  };
}

/** Drive the schedule from `startIso` through `n` passes; returns "ET-hour[D]" per pass plus the UTC instants. */
async function runChain(startIso: string, n: number) {
  const clock = fakeClock(startIso);
  const fired: Array<{ at: string; includeDaily: boolean }> = [];
  const enqueue = vi.fn(async (input: any) => { fired.push({ at: clock.deps.now!().toISOString(), includeDaily: input.includeDaily }); return { id: fired.length } as JobRow; });
  const h = startSchedule({ ...clock.deps, enqueue, query: (async () => ({ rows: [], rowCount: 0 })) as QueryLike });
  for (let i = 0; i < n; i++) await clock.fireNext();
  h.stop();
  expect(clock.armedAt()).toEqual([]); // stop() disarmed the next pass
  return { fired, labels: fired.map((f) => `${etParts(new Date(f.at)).hour}${f.includeDaily ? "D" : ""}`) };
}

describe("the two cron lines", () => {
  it("are exactly the patch's, in America/New_York", () => {
    expect(MIDNIGHT_EXPR).toBe("0 0 * * *");
    expect(HOURLY_EXPR).toBe("0 4-23 * * *");
    expect(SCHEDULE_TZ).toBe("America/New_York");
  });

  it("fire at 00 and 04–23 ET: 21 passes a day, none at 01, 02, 03", () => {
    const hours = Array.from({ length: 24 }, (_, h) => h).filter(isPassHour);
    expect(hours).toEqual([0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(hours).toHaveLength(21);
  });

  it("startSchedule arms ONE timer, at the instant nextPassAfter(now) names, and stop() disarms it", () => {
    const clock = fakeClock("2026-10-16T18:20:00Z"); // 14:20 EDT
    const h = startSchedule({ ...clock.deps, enqueue: async () => ({} as JobRow), query: (async () => ({ rows: [], rowCount: 0 })) as QueryLike });
    expect(clock.armedAt()).toEqual(["2026-10-16T19:00:00.000Z"]); // 15:00 EDT
    expect(clock.armedAt()[0]).toBe(nextPassAfter(new Date("2026-10-16T18:20:00Z")).at.toISOString());
    h.stop();
    expect(clock.armedAt()).toEqual([]);
  });
});

// The timer chain itself, across both DST nights of 2026. node-cron 4.2.1's
// walker, given the 22:00 EDT pass of 2026-10-31, named 23:00 EST on 11-01
// as the next hourly run (nine passes lost on production, jobs #364 → #367);
// given the 00:00 EST pass of 2026-03-08 it named 2026-03-10 for the next
// midnight pass. Our timer asks nextPassAfter, which has no offset to carry.
describe("the timer chain across the 2026 DST boundaries", () => {
  it("fall-back night: 18–23 EDT, 00 EDT with the daily block, then 04 EST onward — nothing lost, nothing doubled", async () => {
    const { fired, labels } = await runChain("2026-10-31T21:30:00Z", 14); // 17:30 EDT Oct 31
    expect(labels).toEqual(["18", "19", "20", "21", "22", "23", "0D", "4", "5", "6", "7", "8", "9", "10"]);
    expect(fired.map((f) => f.at)).toEqual([
      "2026-10-31T22:00:00.000Z", "2026-10-31T23:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-01T01:00:00.000Z",
      "2026-11-01T02:00:00.000Z", "2026-11-01T03:00:00.000Z", // 22:00 and 23:00 EDT — the pass node-cron lost first
      "2026-11-01T04:00:00.000Z",                             // 00:00 EDT, daily block (job #365 on production)
      "2026-11-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z", "2026-11-01T12:00:00.000Z", // 04:00 EST onward — the five-hour gap
      "2026-11-01T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-01T15:00:00.000Z",
    ]);
  });

  it("the day after fall-back ends with 23 EST and the next midnight pass at 05:00Z, not 04:00Z", async () => {
    const { labels, fired } = await runChain("2026-11-02T03:30:00Z", 3); // 22:30 EST Nov 1
    expect(labels).toEqual(["23", "0D", "4"]);
    expect(fired.map((f) => f.at)).toEqual(["2026-11-02T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
  });

  it("spring-forward night: 22, 23 EST, 00 EST with the daily block, then 04 EDT onward (02:00 never happens)", async () => {
    const { fired, labels } = await runChain("2026-03-08T02:30:00Z", 7); // 21:30 EST Mar 7
    expect(labels).toEqual(["22", "23", "0D", "4", "5", "6", "7"]);
    expect(fired.map((f) => f.at)).toEqual([
      "2026-03-08T03:00:00.000Z", "2026-03-08T04:00:00.000Z",
      "2026-03-08T05:00:00.000Z",                             // 00:00 EST, daily block
      "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z", "2026-03-08T10:00:00.000Z", "2026-03-08T11:00:00.000Z", // 04:00 EDT — the three-hour gap
    ]);
  });

  it("the day after spring-forward: 23 EDT at 03:00Z, then the midnight pass at 04:00Z — the one node-cron pushed to Mar 10", async () => {
    const { labels, fired } = await runChain("2026-03-09T02:30:00Z", 3); // 22:30 EDT Mar 8
    expect(labels).toEqual(["23", "0D", "4"]);
    expect(fired.map((f) => f.at)).toEqual(["2026-03-09T03:00:00.000Z", "2026-03-09T04:00:00.000Z", "2026-03-09T08:00:00.000Z"]);
  });

  it("a full year of passes: 365 midnight passes and 20 hourly ones every day, each on an ET pass hour, none repeated", async () => {
    const { fired, labels } = await runChain("2025-12-31T23:30:00Z", 365 * 21);
    expect(labels.filter((l) => l.endsWith("D"))).toHaveLength(365);
    expect(new Set(fired.map((f) => f.at)).size).toBe(fired.length);
    for (const f of fired) { const p = etParts(new Date(f.at)); expect(isPassHour(p.hour)).toBe(true); expect(p.minute).toBe(0); }
    // 5 passes left on Dec 31 2025 (19–23 EST), 364 × 21, then 16 on Dec 31 2026: 0D, 4 … 18 EST
    expect(fired[fired.length - 1].at).toBe("2026-12-31T23:00:00.000Z");
    expect(labels[labels.length - 1]).toBe("18");
  });

  it("a timer that wakes a few ms early arms the FOLLOWING pass, never the same one twice", async () => {
    const clock = fakeClock("2026-06-01T11:30:00Z");
    const fired: string[] = [];
    const enqueue = vi.fn(async () => { fired.push(clock.deps.now!().toISOString()); return { id: 1 } as JobRow; });
    const h = startSchedule({ ...clock.deps, enqueue, query: (async () => ({ rows: [], rowCount: 0 })) as QueryLike });
    await clock.fireNext("2026-06-01T11:59:59.990Z"); // 10 ms early
    expect(fired).toEqual(["2026-06-01T11:59:59.990Z"]);
    expect(clock.armedAt()).toEqual(["2026-06-01T13:00:00.000Z"]); // not 12:00 again
    h.stop();
  });

  it("a timer that wakes late runs its pass late, says so, and re-arms from the clock (skipping passes it slept through)", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const clock = fakeClock("2026-06-01T11:30:00Z");
    const fired: Array<{ at: string; d: boolean }> = [];
    const enqueue = vi.fn(async (i: any) => { fired.push({ at: clock.deps.now!().toISOString(), d: i.includeDaily }); return { id: 1 } as JobRow; });
    const h = startSchedule({ ...clock.deps, enqueue, query: (async () => ({ rows: [], rowCount: 0 })) as QueryLike });
    await clock.fireNext("2026-06-01T14:10:00Z"); // the 12:00Z timer wakes 2h10m late
    expect(fired).toEqual([{ at: "2026-06-01T14:10:00.000Z", d: false }]);
    expect(lines.join("\n")).toMatch(/tick for 2026-06-01T12:00:00.000Z fired 130 min late/);
    expect(clock.armedAt()).toEqual(["2026-06-01T15:00:00.000Z"]); // 13:00Z and 14:00Z are gone, not stacked
    expect(LATE_TICK_WARN_MS).toBe(60_000);
    h.stop();
    setScheduleLogger(() => {});
  });
});

describe("nextPassAfter across the 2026 DST boundaries", () => {
  // Fall back: 2026-11-01 02:00 EDT → 01:00 EST. EDT = UTC-4, EST = UTC-5.
  it("the midnight pass on fall-back night is 00:00 EDT = 04:00Z, with the daily block", () => {
    const r = nextPassAfter(new Date("2026-11-01T03:30:00Z")); // 23:30 EDT Oct 31
    expect(r.at.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(r.includeDaily).toBe(true);
    expect(etParts(r.at)).toMatchObject({ month: 11, day: 1, hour: 0, minute: 0 });
  });

  it("after the midnight pass, the next is 04:00 EST = 09:00Z — the repeated 01:00 and the 02–03 window are skipped", () => {
    const r = nextPassAfter(new Date("2026-11-01T04:30:00Z")); // 00:30 EDT
    expect(r.at.toISOString()).toBe("2026-11-01T09:00:00.000Z"); // not 08:00Z (that is 03:00 EST)
    expect(r.includeDaily).toBe(false);
    expect(etParts(r.at).hour).toBe(4);
    // a five-hour gap on that night (01 EDT, 01 EST, 02, 03), four on a normal one
    expect((r.at.getTime() - new Date("2026-11-01T04:00:00Z").getTime()) / 3_600_000).toBe(5);
  });

  it("the hourly passes after fall-back are on EST hours: 05:00 EST = 10:00Z", () => {
    expect(nextPassAfter(new Date("2026-11-01T09:00:00Z")).at.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  // Spring forward: 2026-03-08 02:00 EST → 03:00 EDT.
  it("the midnight pass on spring-forward night is 00:00 EST = 05:00Z", () => {
    const r = nextPassAfter(new Date("2026-03-08T04:30:00Z")); // 23:30 EST Mar 7
    expect(r.at.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(r.includeDaily).toBe(true);
  });

  it("after it, the next is 04:00 EDT = 08:00Z — a three-hour gap because 02:00 never happens", () => {
    const r = nextPassAfter(new Date("2026-03-08T05:30:00Z")); // 00:30 EST
    expect(r.at.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(r.includeDaily).toBe(false);
    expect((r.at.getTime() - new Date("2026-03-08T05:00:00Z").getTime()) / 3_600_000).toBe(3);
  });

  it("a normal summer day: 21 passes, hourly from 04:00 EDT (08:00Z) to 23:00 EDT (03:00Z next day)", () => {
    const passes: string[] = [];
    let t = new Date("2026-06-01T03:59:00Z"); // 23:59 EDT May 31
    for (let i = 0; i < 21; i++) { const r = nextPassAfter(t); passes.push(`${etParts(r.at).hour}${r.includeDaily ? "D" : ""}`); t = r.at; }
    expect(passes).toEqual(["0D", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23"]);
    expect(nextPassAfter(t).at.toISOString()).toBe("2026-06-02T04:00:00.000Z"); // the next midnight pass
  });

  it("is strictly after `from`: at an exact pass instant it returns the following pass", () => {
    expect(nextPassAfter(new Date("2026-06-01T12:00:00Z")).at.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });
});

describe("the tick handler", () => {
  const fakeQuery = (active: Partial<JobRow>[]): QueryLike => async (sql) => {
    if (/FROM jobs WHERE status IN \('running','queued'\)/.test(sql)) return { rows: active, rowCount: active.length };
    throw new Error(`unexpected sql ${sql.slice(0, 60)}`);
  };

  it("enqueues a scheduled pass with the null scope (the active+parked rule) and the right daily flag", async () => {
    const enqueued: any[] = [];
    const enqueue = vi.fn(async (input: any) => { enqueued.push(input); return { id: 11, status: "queued" } as JobRow; });
    await runScheduledTick(true, { enqueue, query: fakeQuery([]) });
    await runScheduledTick(false, { enqueue, query: fakeQuery([]) });
    expect(enqueued).toEqual([
      { trigger: "scheduled", includeDaily: true, scopeAsins: null },
      { trigger: "scheduled", includeDaily: false, scopeAsins: null },
    ]);
  });

  it("enqueues when a pass is RUNNING but none is queued — the new one waits", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const enqueue = vi.fn(async () => ({ id: 12, status: "queued" } as JobRow));
    await runScheduledTick(false, { enqueue, query: fakeQuery([{ id: 10, status: "running", trigger: "scheduled" } as JobRow]) });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toMatch(/job 12 — scheduled pass #10 is still running \(overrun\); it waits/);
    setScheduleLogger(() => {});
  });

  // No stacking (2026-10-16): at most one scheduled pass waiting.
  it("skips the tick when a scheduled pass is already QUEUED, and says which", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const enqueue = vi.fn(async () => ({ id: 13 } as JobRow));
    const q = fakeQuery([{ id: 10, status: "running", trigger: "scheduled" } as JobRow, { id: 11, status: "queued", trigger: "scheduled", include_daily: false } as JobRow]);
    const r = await runScheduledTick(false, { enqueue, query: q }, new Date("2026-10-16T19:00:00Z")); // 15:00 ET
    expect(enqueue).not.toHaveBeenCalled();
    expect(r.id).toBe(11);
    expect(lines).toEqual(["tick 15:00 skipped — scheduled pass #11 already queued"]);
    setScheduleLogger(() => {});
  });

  it("the 00:00 tick promotes an already-queued hourly pass to carry the daily block instead of enqueuing", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const updates: any[] = [];
    const enqueue = vi.fn(async () => ({ id: 13 } as JobRow));
    const base = fakeQuery([{ id: 11, status: "queued", trigger: "scheduled", include_daily: false } as JobRow]);
    const query: QueryLike = async (sql, params) => {
      if (/^UPDATE jobs SET include_daily = TRUE WHERE id = \$1 AND status = 'queued'/.test(sql.trim())) { updates.push(params); return { rows: [{ id: 11, status: "queued", trigger: "scheduled", include_daily: true, progress: {} }], rowCount: 1 }; }
      return base(sql, params);
    };
    const r = await runScheduledTick(true, { enqueue, query }, new Date("2026-10-16T04:00:00Z")); // 00:00 ET
    expect(enqueue).not.toHaveBeenCalled();
    expect(updates).toEqual([[11]]);
    expect(r.include_daily).toBe(true);
    expect(lines).toEqual(["tick 00:00 skipped — scheduled pass #11 already queued; promoted to carry the daily block"]);
    setScheduleLogger(() => {});
  });

  it("the 00:00 tick leaves an already-daily queued pass alone", async () => {
    const enqueue = vi.fn(async () => ({ id: 13 } as JobRow));
    const q = fakeQuery([{ id: 11, status: "queued", trigger: "scheduled", include_daily: true } as JobRow]);
    const updates: string[] = [];
    const query: QueryLike = async (sql, params) => { if (sql.includes("UPDATE jobs")) { updates.push(sql); return { rows: [], rowCount: 0 }; } return q(sql, params); };
    await runScheduledTick(true, { enqueue, query });
    expect(enqueue).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("a queued MANUAL job (Refresh button, backfill) never suppresses a tick", async () => {
    const enqueue = vi.fn(async () => ({ id: 14 } as JobRow));
    await runScheduledTick(false, { enqueue, query: fakeQuery([{ id: 10, status: "running", trigger: "manual" } as JobRow, { id: 12, status: "queued", trigger: "manual" } as JobRow]) });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a tick whose enqueue throws is logged, never crashes the process, and the next pass is still armed", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const clock = fakeClock("2026-06-01T11:30:00Z");
    const h = startSchedule({ ...clock.deps, enqueue: async () => { throw new Error("db down"); }, query: fakeQuery([]) });
    await expect(clock.fireNext()).resolves.toBeInstanceOf(Date);
    expect(lines.join("\n")).toMatch(/scheduled tick failed to enqueue: db down/);
    expect(clock.armedAt()).toEqual(["2026-06-01T13:00:00.000Z"]);
    h.stop();
    setScheduleLogger(() => {});
  });
});

describe("wiring", () => {
  const here = __dirname;
  it("the three old cron files are gone and nothing imports them", () => {
    for (const f of ["refresh-cron.ts", "sourcing-sync-cron.ts", "aura-sync-cron.ts"]) expect(existsSync(join(here, "..", f))).toBe(false);
    const idx = readFileSync(join(here, "..", "index.ts"), "utf8");
    expect(idx).not.toMatch(/refresh-cron|sourcing-sync-cron|aura-sync-cron|startRefreshCron|startSourcingSyncCron|startAuraSyncCron/);
  });

  it("index.ts starts the schedule only when ENABLE_CRONS === 'true', after the runner, and feeds nextPassAt to the jobs router", () => {
    const idx = readFileSync(join(here, "..", "index.ts"), "utf8");
    const runner = idx.indexOf("startRunner({");
    const sched = idx.indexOf("startSchedule(");
    expect(runner).toBeGreaterThan(-1);
    expect(sched).toBeGreaterThan(runner);
    expect(idx.slice(sched - 400, sched)).toMatch(/process\.env\.ENABLE_CRONS === "true"/);
    expect(idx).toMatch(/createJobsRouter\(\{ nextPassAt/);
    expect(idx).toMatch(/nextPassAfter\(new Date\(\)\)/);
  });

  it("nothing in the server imports node-cron any more — the timer is ours (2026-11-01)", () => {
    const { execSync } = require("child_process");
    const out = execSync(`grep -rlE --include=*.ts "from \\"node-cron\\"|require\\(\\"node-cron\\"" ${join(here, "..")} || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(out.map((p: string) => p.replace(join(here, ".."), "")).filter((p: string) => !p.endsWith(".test.ts"))).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    expect(pkg.dependencies["node-cron"]).toBeUndefined();
    expect(pkg.devDependencies?.["node-cron"]).toBeUndefined();
  });
});
