// Listing hygiene in the jobs UI (SPEC §11 components 22 / 24, 2026-10-19).
import { describe, it, expect } from "vitest";
import {
  completionText, changeCount, groupListingActions, pendingLabel, breakerHeldText, groupHygieneOutcomes, failedAsinsFromRuns, jobKindLabel, componentLabel,
  type Job, type ComponentRun,
} from "./jobs-api";

const base: Job = {
  id: 1, kind: "refresh", trigger: "scheduled", target: "main", bulk_list_id: null, include_daily: false, scope_asins: null,
  components: null, params: null, status: "done", progress: { done: [] }, summary: null, requested_by: null,
  queued_at: "2026-10-19T14:00:00Z", started_at: null, finished_at: null, error: null,
};

describe("Changes: listings closed / deleted alongside the flips (never price counts)", () => {
  const summary = {
    asins: 2453, durationMs: 60_000, components: {}, flips: [{ asin: "A1", field: "gating" as const, from: "gated", to: "ungated" }],
    listingActions: [{ action: "close" as const, asin: "B1", sku: "S1" }, { action: "close" as const, asin: "B2", sku: "S2" }, { action: "delete" as const, asin: "B3", sku: "S3" }],
  };
  it("the toast counts them as changes", () => {
    expect(changeCount(summary)).toBe(4);
    expect(completionText({ ...base, summary }).description).toBe("2,453 ASINs · 1 min · 4 changes");
  });
  it("grouped into closed and deleted", () => {
    expect(groupListingActions(summary.listingActions)).toEqual({
      closed: [{ action: "close", asin: "B1", sku: "S1" }, { action: "close", asin: "B2", sku: "S2" }],
      deleted: [{ action: "delete", asin: "B3", sku: "S3" }],
    });
    expect(changeCount({ ...summary, flips: [], listingActions: undefined })).toBe(0);
  });
});

describe("hygiene outcomes", () => {
  it("grouped per outcome, skip_clock days folded, notes (_mode, _breaker …) left out, largest group first", () => {
    const g = groupHygieneOutcomes({ _mode: "dry run", A: "would_close", B: "skip_has_stock:fulfillable", C: "would_close", D: "skip_clock:12/60", E: "skip_clock:3/14", F: "error: HTTP 500" });
    expect(g).toEqual([
      { outcome: "skip_clock", skus: ["D", "E"] },
      { outcome: "would_close", skus: ["A", "C"] },
      { outcome: "error", skus: ["F"] },
      { outcome: "skip_has_stock:fulfillable", skus: ["B"] },
    ]);
  });
  it("Retry failed never picks up hygiene SKUs (a Refresh cannot redo a close)", () => {
    const runs = [
      { stage: "22_close_oos", outcomes: { "ABC-001": "error: HTTP 500" } },
      { stage: "10_prices", outcomes: { B000000001: "error: 429" } },
    ] as unknown as ComponentRun[];
    expect(failedAsinsFromRuns(runs)).toEqual(["B000000001"]);
  });
  it("labels", () => {
    expect(componentLabel(22)).toBe("close OOS listings");
    expect(jobKindLabel({ ...base, trigger: "manual", components: [22], params: { listing_hygiene: { action: "close", mode: "run", dry_run: true } } })).toBe("manual · close OOS listings (dry run)");
    expect(jobKindLabel({ ...base, trigger: "manual", components: [24], params: { listing_hygiene: { action: "delete", mode: "release", release_of_job: 41 } } })).toBe("manual · delete dead listings (release #41)");
    expect(jobKindLabel({ ...base, trigger: "manual", components: [23], params: { ledger_window: { from: "a", to: "b" } } })).toBe("manual · ledger backfill");
  });
});

describe("Action required (Maria 2026-10-21)", () => {
  const hold = (action: "close" | "delete", count: number) => ({ job_id: 140, action, count, held_at: "2026-10-22T05:42:49Z" });
  it("label shows while a hold is unreleased; null (indicator hidden) when nothing is pending", () => {
    expect(pendingLabel({ close: null, delete: hold("delete", 30) })).toBe("Action required: 30 deletes held for review");
    expect(pendingLabel({ close: hold("close", 1), delete: hold("delete", 30) })).toBe("Action required: 1 close and 30 deletes held for review");
    expect(pendingLabel({ close: null, delete: null })).toBeNull();
    expect(pendingLabel(undefined)).toBeNull();
  });
  it("breaker toast for a pass that held candidates; none when nothing tripped", () => {
    const j = (c: any) => ({ ...base, trigger: "scheduled" as const, include_daily: true, summary: { asins: 1, durationMs: 1, flips: [], components: c } });
    expect(breakerHeldText(j({ "22_close_oos": { held: 60 }, "24_delete_dead": { held: 30 } }))).toBe("Daily pass held 60 closes / 30 deletes — review needed");
    expect(breakerHeldText(j({ "24_delete_dead": { held: 162, skip_clock: 83 } }))).toBe("Daily pass held 162 deletes — review needed");
    expect(breakerHeldText(j({ "22_close_oos": { closed: 24 } }))).toBeNull();
  });
});
