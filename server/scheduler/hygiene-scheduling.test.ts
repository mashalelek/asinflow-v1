// Listing hygiene (SPEC §11, 2026-10-19): 22 (close), 23 (ledger) and 24
// (delete) run only in the scheduled pass — never in a manual Refresh, an
// onboarding or a bulk job — except through their own entry points, which
// list the component AND carry its parameters.
import { describe, it, expect } from "vitest";
import { componentsForJob } from "./runner";
import { COMPONENTS } from "./components";
import { SCHEDULED_ONLY_COMPONENTS, ONBOARDING_COMPONENTS, type JobRow } from "./types";

const row = (p: Partial<JobRow>): JobRow => ({
  id: 1, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: true,
  scope_asins: null, components: null, params: null, status: "queued", progress: { done: [] }, summary: null,
  requested_by: null, queued_at: new Date(), started_at: null, finished_at: null, error: null, ...p,
});
const ns = (j: JobRow) => componentsForJob(j).map((c) => c.n);
const present = COMPONENTS.map((c) => c.n).filter((n) => SCHEDULED_ONLY_COMPONENTS.includes(n));

describe("22–24 are absent from manual, onboarding and bulk job component lists", () => {
  it("there is at least one hygiene component registered to test against", () => {
    expect(present.length).toBeGreaterThan(0);
  });
  for (const trigger of ["manual", "onboarding", "bulk"] as const) {
    for (const include_daily of [true, false]) {
      it(`${trigger}, include_daily=${include_daily}`, () => {
        for (const n of SCHEDULED_ONLY_COMPONENTS) expect(ns(row({ trigger, include_daily }))).not.toContain(n);
      });
    }
  }
  it("ONBOARDING_COMPONENTS never names them", () => {
    for (const n of SCHEDULED_ONLY_COMPONENTS) expect(ONBOARDING_COMPONENTS).not.toContain(n);
  });
  it("listing one explicitly WITHOUT its parameters does not run it (a stray components list cannot reach SC writes)", () => {
    for (const n of SCHEDULED_ONLY_COMPONENTS) expect(ns(row({ trigger: "manual", components: [n] }))).toEqual([]);
    expect(ns(row({ trigger: "manual", components: [22], params: { listing_hygiene: { action: "delete" } } }))).toEqual([]);
    expect(ns(row({ trigger: "manual", components: [24], params: { listing_hygiene: { action: "close" } } }))).toEqual([]);
  });
});

describe("the scheduled pass and the explicit entry points", () => {
  it("the 00:00 pass runs every registered hygiene component; an hourly pass none of the daily ones", () => {
    const daily = ns(row({ trigger: "scheduled", include_daily: true }));
    for (const n of present) expect(daily).toContain(n);
    const hourly = ns(row({ trigger: "scheduled", include_daily: false }));
    expect(hourly).not.toContain(23);
    expect(hourly).not.toContain(24);
  });
  it("the ledger backfill: components [23] + params.ledger_window", () => {
    expect(ns(row({ trigger: "manual", include_daily: false, components: [23], params: { ledger_window: { from: "2025-04-01", to: "2026-10-18" } } }))).toEqual([23]);
  });
});

describe("PO tracking 25 (ingest) / 26 (push) — SPEC §26", () => {
  const n = (j: JobRow) => componentsForJob(j).map((c) => c.n);
  it("the 00:00 pass runs 25 then 26, after Sync POs (9); never an hourly pass", () => {
    const daily = n(row({ trigger: "scheduled", include_daily: true }));
    expect(daily.indexOf(25)).toBeGreaterThan(daily.indexOf(9));
    expect(daily.indexOf(26)).toBe(daily.indexOf(25) + 1);
    const hourly = n(row({ trigger: "scheduled", include_daily: false }));
    expect(hourly).not.toContain(25);
    expect(hourly).not.toContain(26);
  });
  it("a manual Refresh (even with the daily block) never pushes to Velocity as a side effect", () => {
    expect(n(row({ trigger: "manual", include_daily: true }))).not.toContain(26);
    expect(n(row({ trigger: "onboarding", include_daily: true }))).not.toContain(25);
  });
});
