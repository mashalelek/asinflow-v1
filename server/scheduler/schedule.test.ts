import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import cron from "node-cron";
import {
  SCHEDULE_TZ, MIDNIGHT_EXPR, HOURLY_EXPR, isPassHour, etParts, nextPassAfter, startSchedule, runScheduledTick, setScheduleLogger,
} from "./schedule";
import type { JobRow, QueryLike } from "./types";

// Scheduler patch commit 5 (decision 7): one pass at 00:00 ET with the daily
// block, none 01–03, hourly 04–23, timezone passed explicitly. The tests pin
// the expressions, the ET arithmetic across both DST boundaries of 2026
// (spring forward 03-08, fall back 11-01), and the tick handler.

setScheduleLogger(() => {});

describe("the two cron lines", () => {
  it("are exactly the patch's, valid, and in America/New_York", () => {
    expect(MIDNIGHT_EXPR).toBe("0 0 * * *");
    expect(HOURLY_EXPR).toBe("0 4-23 * * *");
    expect(SCHEDULE_TZ).toBe("America/New_York");
    expect(cron.validate(MIDNIGHT_EXPR)).toBe(true);
    expect(cron.validate(HOURLY_EXPR)).toBe(true);
  });

  it("fire at 00 and 04–23 ET: 21 passes a day, none at 01, 02, 03", () => {
    const hours = Array.from({ length: 24 }, (_, h) => h).filter(isPassHour);
    expect(hours).toEqual([0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(hours).toHaveLength(21);
  });

  it("startSchedule registers both with the timezone option — never host-local", () => {
    const regs: Array<{ expr: string; opts: any }> = [];
    const lib = { schedule: (expr: string, _fn: () => unknown, opts: any) => { regs.push({ expr, opts }); return { stop() {} }; } };
    const h = startSchedule({ cronLib: lib, enqueue: async () => ({} as JobRow), query: (async () => ({ rows: [], rowCount: 0 })) as QueryLike });
    expect(regs.map((r) => r.expr)).toEqual([MIDNIGHT_EXPR, HOURLY_EXPR]);
    for (const r of regs) expect(r.opts.timezone).toBe("America/New_York");
    h.stop();
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

  it("a tick whose enqueue throws is logged, never crashes the process", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    let fn: () => Promise<unknown> = async () => {};
    const lib = { schedule: (_e: string, f: () => unknown, _o: any) => { fn = f as any; return { stop() {} }; } };
    startSchedule({ cronLib: lib, enqueue: async () => { throw new Error("db down"); }, query: fakeQuery([]) });
    await expect(fn()).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/scheduled tick failed to enqueue: db down/);
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

  it("schedule.ts is the only node-cron user in the server", () => {
    const { execSync } = require("child_process");
    const out = execSync(`grep -rl --include=*.ts "from \\"node-cron\\"" ${join(here, "..")} || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(out.map((p: string) => p.replace(join(here, ".."), "")).filter((p: string) => !p.endsWith(".test.ts"))).toEqual(["/scheduler/schedule.ts"]);
  });
});
