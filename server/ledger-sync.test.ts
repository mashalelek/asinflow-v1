// Listing hygiene, component 23 (SPEC §11): the Inventory Ledger.
import { describe, it, expect } from "vitest";
import {
  parseQuotedTsv, parseLedgerReport, foldLastStocked, ledgerChunks, nightlyWindow, mergeCoverage,
  fetchLedgerReport, applyLedgerChunk, LEDGER_QUOTA_MAX_WAITS, LEDGER_QUOTA_WAIT_MS, type LedgerDeps,
} from "./ledger-sync";
import { ledger, ledgerComponentDeps, ledgerWindowFor } from "./scheduler/components/23-ledger";
import { ComponentError, type ComponentContext } from "./scheduler/types";

const HEADER = ["Date", "FNSKU", "ASIN", "MSKU", "Title", "Disposition", "Starting Warehouse Balance", "In Transit Between Warehouses", "Receipts", "Customer Shipments", "Customer Returns", "Vendor Returns", "Warehouse Transfer In/Out", "Found", "Lost", "Damaged", "Disposed", "Other Events", "Ending Warehouse Balance", "Unknown Events", "Location", "Store"];
const q = (v: string) => `"${v}"`;
const line = (date: string, msku: string, disp: string, ending: number, title = "T") =>
  [q(date), q("X0"), q("B0"), q(msku), q(title), q(disp), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q("0"), q(String(ending)), q("0"), q("US"), ""].join("\t");
const report = (lines: string[]) => [HEADER.map(q).join("\t"), ...lines].join("\r\n") + "\r\n";
// Verbatim from the 2026-10-18 spike: Amazon leaves the title's quote unescaped.
const TUBIGRIP = `"10/02/2026"\t"X004THN7SN"\t"B003XCR7TO"\t"IY-9P1I-IR4D"\t"Tubigrip Size D Tubular Bandage 10M Box Beige (3x32.81')""\t"SELLABLE"\t"1"\t"0"\t"0"\t"0"\t"0"\t"0"\t"0"\t"0"\t"0"\t"0"\t"0"\t"-1"\t"0"\t"0"\t"US"\t`;

describe("parseQuotedTsv / parseLedgerReport", () => {
  it("reads Amazon's unescaped title quote as part of the title (split-on-tab and strict RFC 4180 both misread it)", () => {
    const rows = parseQuotedTsv(report([TUBIGRIP]));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(22);
    expect(rows[1][4]).toBe("Tubigrip Size D Tubular Bandage 10M Box Beige (3x32.81')\"");
    expect(rows[1][5]).toBe("SELLABLE");
    expect(parseLedgerReport(report([TUBIGRIP]))[0]).toEqual({ date: "2026-10-02", msku: "IY-9P1I-IR4D", disposition: "SELLABLE", ending: 0 });
  });
  it("an escaped quote and an embedded tab inside a quoted field", () => {
    expect(parseQuotedTsv(`"a ""b"" c"\t"x\ty"\n`)).toEqual([[`a "b" c`, "x\ty"]]);
  });
  it("a row with the wrong field count fails the chunk — never silently dropped", () => {
    expect(() => parseLedgerReport(report([`"10/02/2026"\t"X0"`]))).toThrow(/fields, header has 22/);
  });
  it("an empty report is zero rows", () => {
    expect(parseLedgerReport("")).toEqual([]);
    expect(parseLedgerReport(HEADER.map(q).join("\t") + "\r\n")).toEqual([]);
  });
});

describe("foldLastStocked", () => {
  it("Σ ending balance over ALL dispositions: a damaged-only day counts as stocked", () => {
    const rows = parseLedgerReport(report([
      line("10/01/2026", "A", "SELLABLE", 2), line("10/05/2026", "A", "SELLABLE", 0), line("10/05/2026", "A", "DEFECTIVE", 1),
      line("10/06/2026", "A", "SELLABLE", 0),
      line("09/20/2026", "B", "SELLABLE", 0),
    ]));
    const f = foldLastStocked(rows);
    expect(f.get("A")).toBe("2026-10-05");
    expect(f.get("B")).toBeNull();
  });
});

describe("windows", () => {
  it("18 months in 92-day chunks: six requests, contiguous, oldest first", () => {
    const c = ledgerChunks("2025-04-19", "2026-10-18");
    expect(c).toHaveLength(6);
    expect(c[0]).toEqual({ from: "2025-04-19", to: "2025-07-19" });
    expect(c[5].to).toBe("2026-10-18");
    for (let i = 1; i < c.length; i++) expect(new Date(c[i].from).getTime() - new Date(c[i - 1].to).getTime()).toBe(86_400_000);
  });
  it("nightly = the last 7 complete days (ET)", () => {
    expect(nightlyWindow(new Date("2026-10-19T04:10:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });
  it("params.ledger_window wins; otherwise nightly", () => {
    expect(ledgerWindowFor({ ledger_window: { from: "2025-04-19", to: "2026-10-18" } }, new Date()).source).toBe("params");
    expect(ledgerWindowFor({ ledger_window: { from: "bad" } }, new Date()).source).toBe("nightly");
  });
  it("coverage unions adjacent windows; a disjoint newer window replaces, an older one is ignored", () => {
    expect(mergeCoverage(null, { from: "2026-10-12", to: "2026-10-18" })).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(mergeCoverage({ from: "2025-04-19", to: "2026-10-17" }, { from: "2026-10-12", to: "2026-10-18" })).toEqual({ from: "2025-04-19", to: "2026-10-18" });
    expect(mergeCoverage({ from: "2025-04-19", to: "2025-07-19" }, { from: "2026-10-12", to: "2026-10-18" })).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(mergeCoverage({ from: "2026-10-12", to: "2026-10-18" }, { from: "2025-04-19", to: "2025-07-19" })).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });
});

function fakeDeps(script: { createErrors?: any[]; status?: string; text?: string }) {
  const posts: any[] = [];
  const sleeps: number[] = [];
  const errs = [...(script.createErrors ?? [])];
  const deps: LedgerDeps = {
    post: async (_e, body) => { posts.push(body); const e = errs.shift(); if (e) throw e; return { reportId: "R1" }; },
    get: async (e) => e.includes("/documents/") ? { url: "u" } : { processingStatus: script.status ?? "DONE", reportDocumentId: "D1" },
    download: async () => Buffer.from(script.text ?? report([])),
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { deps, posts, sleeps };
}
const quota = () => Object.assign(new Error("429"), { response: { status: 429, data: { errors: [{ code: "QuotaExceeded" }] } } });

describe("fetchLedgerReport", () => {
  it("QuotaExceeded waits and retries THE SAME chunk", async () => {
    const f = fakeDeps({ createErrors: [quota(), quota()] });
    await fetchLedgerReport({ from: "2025-04-19", to: "2025-07-19" }, f.deps);
    expect(f.posts).toHaveLength(3);
    expect(new Set(f.posts.map((p) => `${p.dataStartTime}|${p.dataEndTime}`)).size).toBe(1);
    expect(f.posts[0]).toMatchObject({ reportType: "GET_LEDGER_SUMMARY_VIEW_DATA", reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "DAILY" } });
    expect(f.sleeps.filter((s) => s === LEDGER_QUOTA_WAIT_MS)).toHaveLength(2);
  });
  it("past the wait cap it FAILS (the chunk is never skipped)", async () => {
    const f = fakeDeps({ createErrors: Array.from({ length: LEDGER_QUOTA_MAX_WAITS + 1 }, quota) });
    await expect(fetchLedgerReport({ from: "2025-04-19", to: "2025-07-19" }, f.deps)).rejects.toThrow(/never skipped|not skipped/);
  });
  it("a FATAL report fails", async () => {
    const f = fakeDeps({ status: "FATAL" });
    await expect(fetchLedgerReport({ from: "2026-10-12", to: "2026-10-18" }, f.deps)).rejects.toThrow(/FATAL/);
  });
});

function fakeDb(stocked: boolean) {
  const writes: string[] = [];
  const query = async (sql: string, _p?: any[]) => {
    if (sql.includes("AS stocked")) return { rows: [{ stocked }], rowCount: 1 };
    if (sql.startsWith("SELECT value FROM settings")) return { rows: [], rowCount: 0 };
    writes.push(sql);
    return { rows: [], rowCount: 1 };
  };
  return { writes, query };
}

describe("applyLedgerChunk — the empty-report tripwire", () => {
  it("zero rows while 15 saw stock in the window → inconclusive, NOTHING written", async () => {
    const db = fakeDb(true);
    const r = await applyLedgerChunk({ from: "2026-10-12", to: "2026-10-18" }, [], db.query);
    expect(r.status).toBe("inconclusive");
    expect(db.writes).toHaveLength(0);
  });
  it("zero rows with no stock in the window is a genuine empty report — coverage recorded", async () => {
    const db = fakeDb(false);
    const r = await applyLedgerChunk({ from: "2025-04-19", to: "2025-07-19" }, [], db.query);
    expect(r.status).toBe("written");
    expect(db.writes.some((s) => s.includes("INSERT INTO settings"))).toBe(true);
  });
  it("last_stocked_date and ledger_window_start only move in their direction (GREATEST / LEAST)", async () => {
    const db = fakeDb(false);
    await applyLedgerChunk({ from: "2026-10-12", to: "2026-10-18" }, [{ date: "2026-10-13", msku: "A", disposition: "SELLABLE", ending: 1 }], db.query);
    const up = db.writes.find((s) => s.includes("INSERT INTO sku_ledger_state"))!;
    expect(up).toMatch(/GREATEST\(t\.last_stocked_date, EXCLUDED\.last_stocked_date\)/);
    expect(up).toMatch(/LEAST\(t\.ledger_window_start, EXCLUDED\.ledger_window_start\)/);
  });
});

function ctxFor(params: any) {
  const progress: any[] = [];
  const db = fakeDb(true);
  const ctx = {
    job: { id: 5, params } as any, query: db.query as any, log: () => {}, sellerId: "S", asins: [], scopeAsins: [],
    checkpoint: async () => {}, setProgress: async (p: number, t: number, u: string) => { progress.push([p, t, u]); }, cache: new Map(),
  } as unknown as ComponentContext;
  return { ctx, progress, db };
}

describe("component 23", () => {
  it("nightly: an empty report while stocked is inconclusive — the pass is NOT failed, conclusive = 0, nothing written", async () => {
    const f = fakeDeps({ text: report([]) });
    Object.assign(ledgerComponentDeps, { ledger: f.deps, spacingMs: 0, now: () => new Date("2026-10-19T04:10:00Z") });
    const { ctx, db } = ctxFor(null);
    const r = await ledger.run(ctx);
    expect(r.counts.conclusive).toBe(0);
    expect(r.counts.inconclusive).toBe(1);
    expect(db.writes).toHaveLength(0);
  });
  it("nightly: a report error is recorded, not thrown", async () => {
    const f = fakeDeps({ status: "FATAL" });
    Object.assign(ledgerComponentDeps, { ledger: f.deps, spacingMs: 0, now: () => new Date("2026-10-19T04:10:00Z") });
    const r = await ledger.run(ctxFor(null).ctx);
    expect(r.counts).toMatchObject({ conclusive: 0, failed: 1 });
  });
  it("backfill: chunks are spaced, progress is in chunks, a failed chunk fails the job (ComponentError)", async () => {
    const f = fakeDeps({ status: "FATAL" });
    Object.assign(ledgerComponentDeps, { ledger: f.deps, spacingMs: 1234, now: () => new Date("2026-10-19T04:10:00Z") });
    const { ctx, progress } = ctxFor({ ledger_window: { from: "2025-04-19", to: "2026-10-18" } });
    await expect(ledger.run(ctx)).rejects.toBeInstanceOf(ComponentError);
    expect(progress[0]).toEqual([0, 6, "chunk"]);
  });
  it("backfill: every chunk written → conclusive, spacing between (not before) chunks", async () => {
    const f = fakeDeps({ text: report([line("10/01/2026", "A", "SELLABLE", 2)]) });
    Object.assign(ledgerComponentDeps, { ledger: f.deps, spacingMs: 1234, now: () => new Date("2026-10-19T04:10:00Z") });
    const { ctx } = ctxFor({ ledger_window: { from: "2025-04-19", to: "2026-10-18" } });
    const r = await ledger.run(ctx);
    expect(r.counts).toMatchObject({ chunks: 6, conclusive: 1, failed: 0 });
    expect(f.sleeps.filter((s) => s === 1234)).toHaveLength(5);
    expect(f.posts).toHaveLength(6);
  });
});
