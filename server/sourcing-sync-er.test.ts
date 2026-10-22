// Sync Sourcing — the ER leads leg (SPEC §11, patch er-leads-sheet-sync).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sqls: Array<{ sql: string; params: any[] }> = [];
let existing: string[] = [];
let insertedNow: string[] = [];
vi.mock("./db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    sqls.push({ sql, params });
    if (sql.startsWith("SELECT asin FROM asins WHERE")) return { rows: insertedNow.filter((a) => params[0].includes(a)).map((asin) => ({ asin })), rowCount: 0 };
    if (sql.startsWith("SELECT asin FROM asins")) return { rows: existing.map((asin) => ({ asin })), rowCount: existing.length };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock("./index", () => ({ log: () => {} }));
const master = vi.fn();
const erSheet = vi.fn();
vi.mock("./sourcing-sheet", () => ({ fetchSourcingSheet: (...a: any[]) => master(...a) }));
vi.mock("./er-leads-sheet", () => ({ fetchErLeadsSheet: (...a: any[]) => erSheet(...a) }));
import { syncSourcingSheet, planErLeg, parseErDate } from "./sourcing-sync";
import type { RawErRow } from "./er-leads-sheet";

const er = (o: Partial<RawErRow>): RawErRow => ({ row: 2, asin: "B0ER000001", approvedRaw: "Yes", dateRaw: "2026-10-21", buyLink: null, promoNotes: null, cogs: null, vaNotes: null, myNotes: null, ...o });
const mrow = (asin: string) => ({ asin, status: "1. New", leadSourceRaw: "OA Hunt", buyLink: null, cogs: 5, promoNotes: null, vaNotes: null, myNotes: null });

describe("ER leg — pure", () => {
  it("dates: ISO and M/D/YYYY → YYYY-MM-DD; rolled-over or free text → null", () => {
    expect(parseErDate("2026-10-20")).toBe("2026-10-20");
    expect(parseErDate(" 10/9/2026 ")).toBe("2026-10-09");
    expect(parseErDate("2026-02-30")).toBeNull();
    expect(parseErDate("Oct 20")).toBeNull();
    expect(parseErDate("")).toBeNull();
  });
  it("filter: Approved = yes (trim/lower) AND Date parses AND ≥ floor; bad dates listed, never guessed", () => {
    const p = planErLeg([
      er({ row: 2, asin: "B0ER000001", approvedRaw: " YES " }),
      er({ row: 3, asin: "B0ER000002", approvedRaw: "See comments" }),
      er({ row: 4, asin: "B0ER000003", approvedRaw: "No" }),
      er({ row: 5, asin: "B0ER000004", dateRaw: "2026-10-19" }),
      er({ row: 6, asin: "B0ER000005", dateRaw: "" }),
      er({ row: 7, asin: "B0ER000006", dateRaw: "soon", approvedRaw: "No" }),
      er({ row: 8, asin: "B0ER000007", dateRaw: "2026-10-20" }),
    ], new Set(), new Set(), "2026-10-20");
    expect(p.inputs.map((i) => i.asin)).toEqual(["B0ER000001", "B0ER000007"]);
    expect(p.report).toMatchObject({ read: 7, filteredOut: 4, inserted: 2, unparseableDates: [{ row: 6, asin: "B0ER000005", value: "" }] });
  });
  it("insert-only: existing ASINs skipped (any status); Master's new ASINs left to Master; one record per ASIN, first non-empty wins, top row's date", () => {
    const p = planErLeg([
      er({ row: 2, asin: "B0OLD00001" }),
      er({ row: 3, asin: "B0BOTH0001" }),
      er({ row: 4, asin: "B0ER000001", dateRaw: "2026-10-22", cogs: null, buyLink: null, myNotes: "mine" }),
      er({ row: 5, asin: "B0ER000001", dateRaw: "2026-10-21", cogs: 7.5, buyLink: "https://www.acme.com/p", vaNotes: "va", promoNotes: "CODE10" }),
    ], new Set(["B0OLD00001"]), new Set(["B0BOTH0001"]), "2026-10-20");
    expect(p.report).toMatchObject({ alreadyInAf: 1, inMasterLeg: ["B0BOTH0001"], inserted: 1 });
    expect(p.inputs).toEqual([{ asin: "B0ER000001", cogs: 7.5, buyLink: "https://www.acme.com/p", leadSource: "ER", prepOverride: null, storageOverride: null, tags: null, notes: "mine\nVA: va", promoNotes: "CODE10" }]);
    expect(p.dates.get("B0ER000001")).toBe("2026-10-22");
    expect(p.report.rows).toEqual([{ asin: "B0ER000001", date: "2026-10-22", buyLink: "https://www.acme.com/p", cogs: 7.5, leadSource: "ER" }]);
  });
  it("unparseable COGS → NULL → cogs 0 (Master rule); both notes empty → NULL", () => {
    const p = planErLeg([er({})], new Set(), new Set(), "2026-10-20");
    expect(p.inputs[0]).toMatchObject({ cogs: 0, notes: null });
  });
});

describe("syncSourcingSheet with both legs", () => {
  const env = { ...process.env };
  beforeEach(() => {
    sqls.length = 0; existing = ["B0OLD00001"]; insertedNow = []; master.mockReset(); erSheet.mockReset();
    process.env.SOURCING_SHEET_ID = "master-id"; process.env.ER_LEADS_SHEET_ID = "er-id"; delete process.env.ER_LEADS_MIN_DATE;
  });
  afterEach(() => { process.env = { ...env }; });

  it("one onboarding call for both legs, then added_at = the ER date on the ER rows; per-sheet report", async () => {
    master.mockResolvedValue([mrow("B0MA000001"), mrow("B0OLD00001")]);
    erSheet.mockResolvedValue({ rawRows: 2, rows: [er({ asin: "B0ER000001", dateRaw: "2026-10-21" }), er({ row: 3, asin: "B0OLD00001" })] });
    const calls: string[][] = [];
    const r = await syncSourcingSheet(async (inputs) => { calls.push(inputs.map((i) => `${i.asin}:${i.leadSource}`)); insertedNow = inputs.map((i) => i.asin); });
    expect(calls).toEqual([["B0MA000001:OA Hunt", "B0ER000001:ER"]]);
    const upd = sqls.find((q) => q.sql.includes("SET added_at"))!;
    expect(upd.sql).toMatch(/AT TIME ZONE 'America\/New_York'/);
    expect(upd.params).toEqual([["B0ER000001"], ["2026-10-21"]]);
    expect(r.sheets.map((l) => [l.sheet, l.read, l.alreadyInAf, l.inserted, l.failed])).toEqual([["master", 2, 1, 1, 0], ["er", 2, 1, 1, 0]]);
    expect(r.inserted).toBe(2);
  });
  it("dry run writes nothing and reports the would-insert rows", async () => {
    master.mockResolvedValue([]);
    erSheet.mockResolvedValue({ rawRows: 1, rows: [er({ cogs: 9.99, buyLink: "https://x.com/a" })] });
    const run = vi.fn();
    const r = await syncSourcingSheet(run, undefined, { dryRun: true });
    expect(run).not.toHaveBeenCalled();
    expect(sqls.some((q) => /UPDATE|INSERT/.test(q.sql))).toBe(false);
    expect(r.sheets[1].rows).toEqual([{ asin: "B0ER000001", date: "2026-10-21", buyLink: "https://x.com/a", cogs: 9.99, leadSource: "ER" }]);
  });
  it("a failed read of one sheet does not stop the other leg", async () => {
    master.mockRejectedValue(new Error("403"));
    erSheet.mockResolvedValue({ rawRows: 1, rows: [er({})] });
    let r = await syncSourcingSheet(async (inputs) => { insertedNow = inputs.map((i) => i.asin); });
    expect(r.sheets[0].error).toMatch(/Master sheet read failed: 403/);
    expect(r.sheets[1].inserted).toBe(1);
    master.mockResolvedValue([mrow("B0MA000001")]);
    erSheet.mockRejectedValue(new Error("ER leads sheet header drift on tab Leads — ER leg aborted: M: expected"));
    r = await syncSourcingSheet(async (inputs) => { insertedNow = inputs.map((i) => i.asin); });
    expect(r.sheets[0].inserted).toBe(1);
    expect(r.sheets[1].error).toMatch(/header drift/);
    expect(r.errors).toHaveLength(1);
  });
  it("ER_LEADS_SHEET_ID unset → ER leg skipped with a warning; an empty ER read is a warning; a bad floor aborts the ER leg", async () => {
    master.mockResolvedValue([]);
    delete process.env.ER_LEADS_SHEET_ID;
    let r = await syncSourcingSheet(async () => {}, undefined, { dryRun: true });
    expect(r.sheets[1]).toMatchObject({ configured: false, warning: expect.stringMatching(/ER_LEADS_SHEET_ID not set/) });
    expect(erSheet).not.toHaveBeenCalled();
    process.env.ER_LEADS_SHEET_ID = "er-id";
    erSheet.mockResolvedValue({ rawRows: 0, rows: [] });
    r = await syncSourcingSheet(async () => {}, undefined, { dryRun: true });
    expect(r.sheets[1].warning).toMatch(/0 rows/);
    process.env.ER_LEADS_MIN_DATE = "10/20/2026";
    r = await syncSourcingSheet(async () => {}, undefined, { dryRun: true });
    expect(r.sheets[1].error).toMatch(/ER_LEADS_MIN_DATE must be YYYY-MM-DD/);
  });
  it("an insert that leaves no row counts as failed for its leg, and gets no added_at", async () => {
    master.mockResolvedValue([]);
    erSheet.mockResolvedValue({ rawRows: 1, rows: [er({})] });
    const r = await syncSourcingSheet(async () => { insertedNow = []; });
    expect(r.sheets[1]).toMatchObject({ inserted: 0, failed: 1 });
    expect(sqls.some((q) => q.sql.includes("SET added_at"))).toBe(false);
  });
});
