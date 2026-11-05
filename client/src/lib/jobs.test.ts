import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  runningLabel, queuedLabel, completionText, groupFlips, failedAsinsFromRuns, formatDuration, jobDurationMs, jobKindLabel,
  enqueueRefresh, lastPassText, failedStepsText, type Job, type ComponentRun,
} from "./jobs-api";

// Scheduler patch commit 2 (client). Pure helpers + source checks on the
// wiring, the same approach as auth.test.ts.

const base: Job = {
  id: 7, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: true,
  scope_asins: ["A1", "A2", "A3"], components: null, params: null, status: "running", progress: { done: [1, 9], component: 10, asin_cursor: "A2", position: 840, total: 2453 },
  summary: null, requested_by: 1, queued_at: "2026-10-15T12:00:00Z", started_at: "2026-10-15T12:00:01Z", finished_at: null, error: null,
};

describe("toolbar labels", () => {
  it("running: component name + position/total", () => {
    expect(runningLabel(base)).toBe("Refresh · prices 840/2453");
    expect(runningLabel({ ...base, progress: { done: [] } })).toBe("Refresh · starting");
    expect(runningLabel({ ...base, progress: { done: [], component: 15, total: 2453 } })).toBe("Refresh · inventory");
  });
  it("running: a unit other than ASINs (sales backfill) reads 'sales chunk 3/30'", () => {
    expect(runningLabel({ ...base, progress: { done: [], component: 19, position: 3, total: 30, unit: "chunk" } })).toBe("Refresh · sales chunk 3/30");
    expect(runningLabel({ ...base, progress: { done: [], component: 19, position: 0, total: 30, unit: "chunk" } })).toBe("Refresh · sales chunk 0/30");
  });
  it("jobs-dialog kind label (2026-10-16): subset jobs name their component with no suffix; full passes keep (hourly)/(daily)", () => {
    expect(jobKindLabel(base)).toBe("manual (daily)");
    expect(jobKindLabel({ ...base, include_daily: false, trigger: "scheduled" })).toBe("scheduled (hourly)");
    expect(jobKindLabel({ ...base, components: [19], params: { sales_window: { from: "2024-05-01", to: "2026-10-16" } } })).toBe("manual · sales backfill");
    expect(jobKindLabel({ ...base, components: [19], include_daily: false })).toBe("manual · sales"); // no window = a plain sales job
    expect(jobKindLabel({ ...base, components: [], include_daily: false })).toBe("manual (hourly)");   // empty list = full pass
  });
  it("queued: shows the queue position", () => {
    expect(queuedLabel(0)).toBe("Refresh · queued");
    expect(queuedLabel(1)).toBe("Refresh · queued (1 ahead)");
    expect(queuedLabel(3)).toBe("Refresh · queued (3 ahead)");
  });
  it("formatDuration", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(44 * 60_000)).toBe("44 min");
    expect(formatDuration(95 * 60_000)).toBe("1 h 35 min");
  });
});

describe("jobDurationMs — wall clock, not the last runner segment (jobs #367 / #374, 2026-11-01)", () => {
  const summary = { asins: 2541, durationMs: 6 * 60_000, components: {}, flips: [] };
  it("a finished job reads started_at → finished_at even when summary.durationMs is the resumed segment's 6 min", () => {
    const j = { ...base, status: "done" as const, summary, started_at: "2026-11-01T18:00:25Z", finished_at: "2026-11-01T18:47:25Z" };
    expect(jobDurationMs(j)).toBe(47 * 60_000);
    expect(completionText(j).description).toBe("2,541 ASINs · 47 min");
  });
  it("a running job reads started_at → now; a finished row without timestamps falls back to the summary; nothing known → null", () => {
    const now = () => Date.parse("2026-11-01T18:10:25Z");
    expect(jobDurationMs({ ...base, started_at: "2026-11-01T18:00:25Z", finished_at: null }, now)).toBe(10 * 60_000);
    expect(jobDurationMs({ ...base, status: "done", summary, started_at: "2026-11-01T18:00:25Z", finished_at: null }, now)).toBe(6 * 60_000);
    expect(jobDurationMs({ ...base, status: "queued", summary: null, started_at: null, finished_at: null })).toBeNull();
  });
});

describe("completion toast (decision 16): ASINs and duration, flips count, never price counts", () => {
  const done: Job = { ...base, status: "done", summary: { asins: 2453, durationMs: 44 * 60_000, components: { "10_prices": { updated: 2400 } }, flips: [{ asin: "A1", field: "gating", from: "gated", to: "ungated" }] } };
  it("done with changes", () => {
    const t = completionText(done);
    expect(t.title).toBe("Refresh done");
    expect(t.description).toBe("2,453 ASINs · 44 min · 1 change");
    expect(t.description).not.toMatch(/2400|updated|price/);
  });
  it("scheduled jobs say so; failed and cancelled carry the reason / stop point", () => {
    expect(completionText({ ...done, trigger: "scheduled" }).title).toBe("Scheduled refresh done");
    expect(completionText({ ...done, status: "failed", error: "component 10 10_prices: 429" })).toEqual({ title: "Refresh failed", description: "component 10 10_prices: 429" });
    expect(completionText({ ...done, status: "cancelled", summary: { ...done.summary!, stoppedAt: 16, flips: [] } }).description).toBe("2,453 ASINs · stopped at listings");
  });
});

describe("groupFlips — the four Changes lists", () => {
  it("buckets gating and suppression flips by direction and ignores anything else", () => {
    const g = groupFlips([
      { asin: "A", field: "gating", from: "gated", to: "ungated" },
      { asin: "B", field: "gating", from: "ungated", to: "gated" },
      { asin: "C", field: "suppression", from: "suppressed", to: "unsuppressed" },
      { asin: "D", field: "suppression", from: "unsuppressed", to: "suppressed" },
      { asin: "E", field: "gating", from: "check", to: "ungated" } as any,
    ]);
    expect(g).toEqual({ gatedToUngated: ["A"], ungatedToGated: ["B"], suppressedToUnsuppressed: ["C"], unsuppressedToSuppressed: ["D"] });
    expect(groupFlips(undefined)).toEqual({ gatedToUngated: [], ungatedToGated: [], suppressedToUnsuppressed: [], unsuppressedToSuppressed: [] });
  });
});

describe("Retry failed (N) spans every component", () => {
  it("collects error: outcomes across runs, skips component-level notes, dedups", () => {
    const runs: ComponentRun[] = [
      { id: "1", started_at: "", finished_at: null, stage: "07_hazmat", scope: "full", requested: 3, counts: {}, outcomes: { A1: "error: 503", A2: "updated" }, error: null },
      { id: "2", started_at: "", finished_at: null, stage: "10_prices", scope: "full", requested: 3, counts: {}, outcomes: { A1: "error: timeout", A3: "throttled", _phase_c: "error: sc_list_incomplete" }, error: null },
    ];
    expect(failedAsinsFromRuns(runs)).toEqual(["A1"]);
  });
});

describe("scope rule and API shape", () => {
  it("enqueueRefresh posts the ASIN list with includeDaily=true (a manual Refresh runs everything)", async () => {
    let sent: any;
    const f = vi.fn(async (_u: any, init: any) => { sent = JSON.parse(init.body); return { ok: true, status: 201, json: async () => ({ job: base, ahead: 1 }) } as Response; });
    const r = await enqueueRefresh(["A1", "A2"], f as any);
    expect(sent).toEqual({ asins: ["A1", "A2"], includeDaily: true });
    expect(r.ahead).toBe(1);
  });

  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("the Refresh button's scope is the selection, else the current filtered view (decision 15)", () => {
    const src = read("pages/home.tsx");
    expect(src).toMatch(/const ws = asinsOverride \?\? currentWorkingSet\(\);/);
    expect(src).toMatch(/enqueueRefresh\(ws\)/);
    // currentWorkingSet: selection wins, else the sorted filtered view
    expect(src).toMatch(/selectedSet\.size > 0\s*\?\s*Array\.from\(selectedSet\)\s*:\s*sortedFilteredResultsRef\.current\.map/);
  });
  it("Product Info and Prices & Stock buttons are gone; one Refresh button, a Cancel while running, the clock opens the jobs dialog", () => {
    const src = read("pages/home.tsx");
    expect(src).not.toMatch(/data-testid="button-product-info"/);
    expect(src).not.toMatch(/data-testid="button-prices-stock"/);
    expect(src).toMatch(/data-testid="button-refresh"/);
    expect(src).toMatch(/data-testid="button-refresh-cancel"/);
    expect(src).toMatch(/<JobsDialog/);
    expect(src).not.toMatch(/\/api\/analyze\/all|\/api\/refresh"/);
  });
  it("the hook polls /api/jobs/current and toasts own + scheduled jobs", () => {
    const src = read("hooks/use-jobs.ts");
    expect(src).toMatch(/JOBS_POLL_MS = 10_000/);
    expect(src).toMatch(/mineIds\.current\.has\(id\) \|\| job\.trigger === "scheduled"/);
  });
  it("two lanes (2026-10-16): the hook tracks both running jobs, counts queue position in lane M only; no toolbar progress bar (2026-10-17)", () => {
    const src = read("hooks/use-jobs.ts");
    expect(src).toMatch(/scheduled: cur\.scheduled, manual: cur\.manual, queued: cur\.queued/);
    expect(src).not.toMatch(/running: cur\.manual/);
    expect(read("pages/home.tsx")).not.toMatch(/progress-refresh|\(scheduled pass\)|jobs\.running/);
    expect(src).toMatch(/const laneM = \[\.\.\.\(cur\.manual \? \[cur\.manual\] : \[\]\), \.\.\.cur\.queued\.filter\(isLaneM\)\]/);
    expect(src).toMatch(/ahead = mineJob \? laneM\.findIndex/);
    const api = read("lib/jobs-api.ts");
    expect(api).toMatch(/interface CurrentJobs \{ scheduled: Job \| null; manual: Job \| null; queued: Job\[\] \}/);
    const home = read("pages/home.tsx");
    expect(home).toMatch(/jobs\.manual && !jobs\.mine/);
  });
  it("settings dialog has NO scheduler section — the jobs dialog is the only surface (2026-10-16)", () => {
    const src = read("components/settings-dialog.tsx");
    expect(src).not.toMatch(/getSchedulerInfo|SchedulerInfo|settings-scheduler/);
    expect(src).not.toMatch(/<h3[^>]*>Scheduler<\/h3>/);
    expect(read("lib/jobs-api.ts")).not.toMatch(/getSchedulerInfo/);
  });
  it("both threshold groups share the order Margin, ROI, Profit/Unit", () => {
    const src = read("components/settings-dialog.tsx");
    const order = (ids: string[]) => ids.map((id) => src.indexOf(`id="${id}"`));
    const mc = order(["mcMargin", "mcRoi", "mcProfit"]);
    const pt = order(["margin", "roi", "minProfitUnit"]);
    for (const o of [mc, pt]) { expect(o.every((i) => i > -1)).toBe(true); expect([...o].sort((x, y) => x - y)).toEqual(o); }
    expect(src).not.toMatch(/Replit/);
  });
});

describe("failed steps (2026-11-05)", () => {
  const step = { n: 13, key: "13_fees", name: "FBA fee estimate", count: 1, reason: "1 ASIN: error: There is an internal service failure." };
  it("'N steps failed in the last pass' until a pass runs clean", () => {
    expect(lastPassText({ jobId: 1, status: "done", finishedAt: null, failedSteps: [step, { ...step, n: 29 }], persistent: {} })).toBe("2 steps failed in the last pass");
    expect(lastPassText({ jobId: 1, status: "done", finishedAt: null, failedSteps: [], persistent: {} })).toBeNull();
    expect(lastPassText(null)).toBeNull();
  });
  it("a done job with a failed step says so on its row and in the toast", () => {
    const job = { id: 5, kind: "refresh", trigger: "scheduled", target: "main", bulk_list_id: null, include_daily: false, scope_asins: null, components: null, params: null, status: "done", progress: { done: [] }, requested_by: null, queued_at: "2026-11-05T20:00:00Z", started_at: "2026-11-05T20:00:00Z", finished_at: "2026-11-05T20:01:00Z", error: null, summary: { asins: 10, durationMs: 60000, components: {}, flips: [], failedSteps: [step] } } as any;
    expect(failedStepsText(job.summary)).toBe("1 step failed");
    expect(completionText(job).title).toBe("Scheduled refresh done · 1 step failed");
    expect(failedStepsText({ ...job.summary, failedSteps: [] })).toBeNull();
  });
  it("the banner is in the jobs dialog and Settings", () => {
    expect(readFileSync(join(__dirname, "../components/jobs-dialog.tsx"), "utf8")).toMatch(/<LastPassBanner/);
    expect(readFileSync(join(__dirname, "../components/settings-dialog.tsx"), "utf8")).toMatch(/<LastPassBanner \/>/);
  });
});
