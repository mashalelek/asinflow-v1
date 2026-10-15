import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  runningLabel, queuedLabel, completionText, groupFlips, failedAsinsFromRuns, formatDuration,
  enqueueRefresh, type Job, type ComponentRun,
} from "./jobs-api";

// Scheduler patch commit 2 (client). Pure helpers + source checks on the
// wiring, the same approach as auth.test.ts.

const base: Job = {
  id: 7, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: true,
  scope_asins: ["A1", "A2", "A3"], status: "running", progress: { done: [1, 9], component: 10, asin_cursor: "A2", position: 840, total: 2453 },
  summary: null, requested_by: 1, queued_at: "2026-10-15T12:00:00Z", started_at: "2026-10-15T12:00:01Z", finished_at: null, error: null,
};

describe("toolbar labels", () => {
  it("running: component name + position/total", () => {
    expect(runningLabel(base)).toBe("Refresh · prices 840/2453");
    expect(runningLabel({ ...base, progress: { done: [] } })).toBe("Refresh · starting");
    expect(runningLabel({ ...base, progress: { done: [], component: 15, total: 2453 } })).toBe("Refresh · inventory");
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
  it("settings dialog shows the read-only Scheduler section", () => {
    const src = read("components/settings-dialog.tsx");
    expect(src).toMatch(/getSchedulerInfo/);
    expect(src).toMatch(/Scheduler/);
  });
});
