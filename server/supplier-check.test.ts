// Supplier verification (SPEC §11 "Supplier verification", Maria 2026-11-05).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCheckText, searchResultSources, runSupplierCheck, storedCheck, SupplierCheckSchema, RECHECK_AFTER_DAYS } from "./supplier-check";
import { AI, estimateCost } from "./config/ai";

const answer = { verdict: "looks_legit", legitimate: "yes", usBased: "yes", domainAge: "registered 2004", findings: ["A+ on BBB since 2010", "4.6 on Trustpilot over 2,000 reviews", "Ships from Ohio"], sources: [{ title: "BBB", url: "https://www.bbb.org/x" }] };
function fakeDb() {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  let row: any = null;
  const q = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (/INSERT INTO po_prefill_log/.test(sql)) return { rows: [{ id: 7 }] };
    if (/INSERT INTO suppliers/.test(sql)) { row = { verified_at: params![1], verdict: params![2], findings: JSON.parse(params![3]), sources: JSON.parse(params![4]) }; return { rows: [] }; }
    if (/FROM suppliers WHERE supplier/.test(sql)) return { rows: row ? [row] : [] };
    throw new Error(sql);
  };
  return { q: q as any, calls, get row() { return row; } };
}
const call = (text: string, extra: any = {}) => async () => ({ text, content: [], input_tokens: 9000, output_tokens: 600, web_searches: 3, ...extra });

describe("reading the model's answer", () => {
  it("the first JSON object in the final text; anything else is null", () => {
    expect(parseCheckText(`Here it is:\n${JSON.stringify(answer)}\nDone.`)).toEqual(answer);
    expect(parseCheckText("no json")).toBeNull();
    expect(parseCheckText("{broken")).toBeNull();
  });
  it("verdict is one of three; 1–5 findings", () => {
    expect(SupplierCheckSchema.safeParse(answer).success).toBe(true);
    expect(SupplierCheckSchema.safeParse({ ...answer, verdict: "fine" }).success).toBe(false);
    expect(SupplierCheckSchema.safeParse({ ...answer, findings: [] }).success).toBe(false);
    expect(SupplierCheckSchema.safeParse({ ...answer, findings: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });
  it("the search results' pages, de-duplicated, are the sources when the model named none", () => {
    const content = [{ type: "server_tool_use" }, { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.example", title: "A" }, { type: "web_search_result", url: "https://a.example", title: "A" }, { type: "web_search_result", url: "https://b.example", title: null }] }, { type: "text", text: "x" }];
    expect(searchResultSources(content)).toEqual([{ title: "A", url: "https://a.example" }, { title: null, url: "https://b.example" }]);
  });
});

describe("one check", () => {
  const now = new Date("2026-11-05T15:00:00Z");
  it("stored on the supplier (verified_at, verdict, findings, sources) and logged as supplier_check with tokens + searches", async () => {
    const db = fakeDb();
    const r = await runSupplierCheck(db.q, "PerfectlyHealthy.com ", 2, { call: call(JSON.stringify(answer)) }, now);
    expect(r.ok).toBe(true);
    expect(db.row).toMatchObject({ verdict: "looks_legit", findings: { legitimate: "yes", usBased: "yes", domainAge: "registered 2004", points: answer.findings }, sources: answer.sources });
    expect(db.calls.find((c) => /INSERT INTO suppliers/.test(c.sql))!.params![0]).toBe("perfectlyhealthy.com");
    const log = db.calls.find((c) => /INSERT INTO po_prefill_log/.test(c.sql))!.params!;
    expect(log[1]).toBe("supplier_check");
    expect(log[7]).toBe(estimateCost(9000, 600, 3));
    expect(estimateCost(9000, 600, 3)).toBeCloseTo(0.0009 + 0.0003 + 3 * AI.webSearch.usdPerSearch, 5);
    if (r.ok) expect(r.check).toMatchObject({ supplier: "perfectlyhealthy.com", verdict: "looks_legit", verifiedAt: now.toISOString(), recheckSuggested: false });
  });
  it("an unreadable answer or an API error stores nothing, is still logged, and says why", async () => {
    for (const deps of [{ call: call("I could not find anything") }, { call: async () => { throw new Error("400 tool not supported"); } }]) {
      const db = fakeDb();
      const r = await runSupplierCheck(db.q, "x.com", null, deps as any, now);
      expect(r.ok).toBe(false);
      expect(db.calls.some((c) => /INSERT INTO suppliers/.test(c.sql))).toBe(false);
      expect(db.calls.filter((c) => /INSERT INTO po_prefill_log/.test(c.sql))).toHaveLength(1);
    }
  });
  it("the script's dry run makes the call and logs it, stores nothing", async () => {
    const db = fakeDb();
    const r = await runSupplierCheck(db.q, "x.com", null, { call: call(JSON.stringify(answer)) }, now, { store: false });
    expect(r.ok).toBe(true);
    expect(db.calls.some((c) => /INSERT INTO suppliers/.test(c.sql))).toBe(false);
  });
  it("a stored check older than 6 months suggests a re-check", async () => {
    const db = fakeDb();
    await runSupplierCheck(db.q, "x.com", null, { call: call(JSON.stringify(answer)) }, now);
    expect((await storedCheck(db.q, "x.com", new Date(now.getTime() + 30 * 86_400_000))).recheckSuggested).toBe(false);
    expect((await storedCheck(db.q, "x.com", new Date(now.getTime() + (RECHECK_AFTER_DAYS + 1) * 86_400_000))).recheckSuggested).toBe(true);
    expect(await storedCheck(fakeDb().q, "new.com")).toMatchObject({ verifiedAt: null, verdict: null, recheckSuggested: false });
  });
});

describe("wiring", () => {
  it("the call uses the web search tool from config/ai.ts (one call, max uses capped) through the one client", () => {
    const src = readFileSync(join(__dirname, "supplier-check.ts"), "utf8");
    expect(src).toMatch(/tools: \[\{ type: AI\.webSearch\.type, name: "web_search", max_uses: AI\.webSearch\.maxUses \}\]/);
    expect(src).toMatch(/anthropicClient\(\)\.messages\.create\(/);
    expect(src).not.toMatch(/new Anthropic\(/);
  });
  it("GET and POST /api/extension/supplier-check; POST answers 503 when AI is off; the route is on Capture PO's list only", () => {
    const routes = readFileSync(join(__dirname, "routes.ts"), "utf8");
    expect(routes).toMatch(/app\.get\("\/api\/extension\/supplier-check"/);
    const post = routes.slice(routes.indexOf('app.post("/api/extension/supplier-check"'));
    expect(post.slice(0, 400)).toMatch(/if \(!aiAvailable\(\)\) \{ res\.status\(503\)/);
    const list = JSON.parse(readFileSync(join(__dirname, "../chrome-extension/core/extension-routes.json"), "utf8"));
    expect(list["capture-po"]).toContain("/extension/supplier-check");
    expect(list.analyzer).not.toContain("/extension/supplier-check");
  });
  it("the panel runs it on click only and labels it an AI assessment, not a guarantee", () => {
    const src = readFileSync(join(__dirname, "../chrome-extension/capture-verify.js"), "utf8");
    expect(src.match(/SUPPLIER_CHECK_RUN/g)).toHaveLength(1);
    expect(src.slice(src.indexOf("SUPPLIER_CHECK_RUN") - 400, src.indexOf("SUPPLIER_CHECK_RUN"))).toMatch(/btn\.addEventListener\("click"/);
    expect(src).toMatch(/An AI assessment from a web search, not a guarantee\./);
  });
  it("migration 093 adds the four columns to suppliers", () => {
    const sql = readFileSync(join(__dirname, "../database/migrations/093_supplier_verification.sql"), "utf8");
    for (const c of ["verified_at timestamptz", "verdict text", "findings jsonb", "sources jsonb"]) expect(sql).toContain(`ADD COLUMN ${c}`);
  });
});
