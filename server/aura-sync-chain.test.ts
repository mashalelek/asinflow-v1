import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Scheduler decision 9 (2026-10-13): Push to Aura reads the PO sheet for its
// selection FIRST — component 9 as a one-component job on the queue — then
// pushes the same selection. Same hard dependency the full chain has.

vi.mock("./index", () => ({ log: () => {} }));
vi.mock("./aura-cost-sync", () => ({ pushAuraCosts: vi.fn() }));

const awaited: any[] = [];
vi.mock("./scheduler/await-job", () => ({
  runJobAndWait: vi.fn(async (input: any) => {
    awaited.push(input);
    return { id: 42, status: "done", summary: { components: { "09_po_sheet": { updated: 3, skipped: 10, cleared: 1, errors: 0 } } } };
  }),
  JobFailedError: class extends Error {},
}));

import { runAuraSyncChain, readPoSheetViaQueue } from "./aura-sync-chain";

const pushResult = (over: Partial<any> = {}) => ({
  pushed: 2, failed: 0, notInAura: ["SKU-X"],
  dryRunSummary: { perVerdict: { UNCHANGED: 5, "SKIP:unmapped_sku": 1, "SKIP:ambiguous_sku": 0, "SKIP:null_cogs": 2, "SKIP:zero_cost": 0 } },
  ...over,
});

describe("runAuraSyncChain", () => {
  it("reads the PO sheet for the SELECTION first, then pushes the same selection", async () => {
    const calls: string[] = [];
    const sel = new Set(["B1", "B2"]);
    const readPoSheet = vi.fn(async (filter: any) => { calls.push(`read:${filter ? Array.from(filter).join(",") : "full"}`); return { updated: 1, skipped: 0, errors: 0, cleared: 0, jobId: 9 }; });
    const push = vi.fn(async (opts: any) => { calls.push(`push:${opts.asinFilter ? Array.from(opts.asinFilter).join(",") : "full"}`); return pushResult(); });
    const r = await runAuraSyncChain({ asinFilter: sel, readPoSheet, push: push as any });
    expect(calls).toEqual(["read:B1,B2", "push:B1,B2"]);
    expect(push).toHaveBeenCalledWith({ limit: "all", asinFilter: sel });
    expect(r.poSync.jobId).toBe(9);
    expect(r.aura).toEqual({ pushed: 2, unchanged: 5, failed: 0, skipped: { unmapped_sku: 1, ambiguous_sku: 0, null_cogs: 2, zero_cost: 0 }, notInAura: ["SKU-X"] });
  });

  it("no selection = the full sheet and every mapped SKU (the chain)", async () => {
    const readPoSheet = vi.fn(async () => ({ updated: 0, skipped: 0, errors: 0, cleared: 0, jobId: 1 }));
    const push = vi.fn(async () => pushResult());
    await runAuraSyncChain({ readPoSheet, push: push as any });
    expect(readPoSheet).toHaveBeenCalledWith(undefined);
    expect(push).toHaveBeenCalledWith({ limit: "all", asinFilter: undefined });
  });

  it("a failed PO read aborts BEFORE any push — never push stale costs", async () => {
    const push = vi.fn(async () => pushResult());
    const readPoSheet = vi.fn(async () => { throw new Error("refresh job 5 failed at component 9: sheet unreachable"); });
    await expect(runAuraSyncChain({ asinFilter: new Set(["B1"]), readPoSheet, push: push as any })).rejects.toThrow(/component 9/);
    expect(push).not.toHaveBeenCalled();
  });

  it("the default PO read is a one-component (9) manual job for the selection, awaited", async () => {
    awaited.length = 0;
    const r = await readPoSheetViaQueue(new Set(["B7"]), 3);
    expect(awaited).toEqual([{ trigger: "manual", includeDaily: false, components: [9], scopeAsins: ["B7"], requestedBy: 3 }]);
    expect(r).toEqual({ updated: 3, skipped: 10, errors: 0, cleared: 1, jobId: 42 });
    awaited.length = 0;
    await readPoSheetViaQueue(undefined);
    expect(awaited[0].scopeAsins).toBeNull(); // full sheet
  });

  it("the chain never calls the sheet sync directly — the queue is the only reader", () => {
    const s = readFileSync(join(__dirname, "aura-sync-chain.ts"), "utf8");
    expect(s).not.toMatch(/runSheetsSync|getRunSheetsSync/);
    expect(s).toMatch(/components: \[9\]/);
  });
});
