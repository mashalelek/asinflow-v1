import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { staleBuildGuard, readServerBuildId, STALE_BUILD_MESSAGE } from "./stale-build-guard";
import { findRecentSameOnboarding, enqueueOnboardingJob } from "./scheduler/jobs-repo";

const CUR = "/assets/index-NEW12345.js";
function call(method: string, p: string, header?: string, serverId: string | null = CUR) {
  let status = 200, body: any = null, nexted = false;
  const req: any = { method, path: p, get: (h: string) => (h.toLowerCase() === "x-af-build" ? header : undefined) };
  const res: any = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } };
  staleBuildGuard(serverId)(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

describe("stale-page guard (2026-10-18)", () => {
  it("mutating requests without the current build id → 409 'AF was updated — reload this page'", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(call(m, "/analyze")).toMatchObject({ status: 409, nexted: false, body: { message: STALE_BUILD_MESSAGE, code: "STALE_BUILD" } });
      expect(call(m, "/jobs", "/assets/index-OLD99999.js")).toMatchObject({ status: 409, nexted: false });
      expect(call(m, "/pos/abc", CUR)).toMatchObject({ nexted: true });
    }
    expect(STALE_BUILD_MESSAGE).toBe("AF was updated — reload this page");
  });
  it("read-only requests keep working without a build id; auth and the Chrome extension's two mutating endpoints are exempt, the PO form's POST is not", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(call(m, "/asins")).toMatchObject({ nexted: true });
    expect(call("POST", "/auth/login")).toMatchObject({ nexted: true });
    expect(call("POST", "/import-asin")).toMatchObject({ nexted: true });
    expect(call("POST", "/pos/prefill")).toMatchObject({ nexted: true }); // Capture PO (2026-11-01: the production check hit the 409)
    expect(call("POST", "/pos")).toMatchObject({ status: 409 });
    expect(call("GET", "/pos/prefill/abc")).toMatchObject({ nexted: true });
  });
  it("no server build id (dev) → guard off", () => {
    expect(call("POST", "/analyze", undefined, null)).toMatchObject({ nexted: true });
  });
  it("the server's build id is the entry script its index.html names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-build-"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html><script type="module" crossorigin src="/assets/index-NEW12345.js"></script>`);
    expect(readServerBuildId(dir)).toBe(CUR);
    expect(readServerBuildId(path.join(dir, "missing"))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("mounted after requireAuth on /api", () => {
    const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src.indexOf('app.use("/api", staleBuildGuard(serverBuildId));')).toBeGreaterThan(src.indexOf('app.use("/api", requireAuth);'));
  });
});

describe("onboarding dedupe (2026-10-18)", () => {
  const fake = (rows: any[]) => { const calls: any[] = []; return { calls, q: async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: /FROM jobs\s+WHERE trigger = 'onboarding'/.test(sql) ? rows : [], rowCount: rows.length }; } }; };
  it("looks for the same ASIN set (sorted, upper-cased) queued in the last 10 minutes, any status", async () => {
    const f = fake([{ id: 64, status: "done", queued_at: new Date() }]);
    expect(await findRecentSameOnboarding(["b09hrdgw17", "B07K1N4K54", "B09HRDGW17"], f.q as any)).toMatchObject({ id: 64, status: "done" });
    expect(f.calls[0].params).toEqual([["B07K1N4K54", "B09HRDGW17"], 10]);
    expect(f.calls[0].sql).toMatch(/\(SELECT array_agg\(x ORDER BY x\) FROM unnest\(scope_asins\) x\) = \$1::text\[\]/);
    expect(f.calls[0].sql).toMatch(/queued_at > NOW\(\) - make_interval\(mins => \$2\)/);
  });
  it("a repeat is refused — no job inserted; a new set enqueues", async () => {
    const dup = fake([{ id: 64, status: "done", queued_at: new Date() }]);
    const r = await enqueueOnboardingJob(["B09HRDGW17"], {}, dup.q as any);
    expect(r).toMatchObject({ job: null, enqueued: [], covered: ["B09HRDGW17"], duplicateOf: 64 });
    expect(dup.calls.some((c: any) => /INSERT INTO jobs/.test(c.sql))).toBe(false);
  });
  it("the onboarding entry refuses before inserting anything and tells the page", () => {
    const src = fs.readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function onboardNewAsins("), src.indexOf("async function insertNewAsinRows("));
    expect(fn.indexOf("findRecentSameOnboarding")).toBeLessThan(fn.indexOf("await insertNewAsinRows("));
    expect(fn).toMatch(/type: "job_duplicate"/);
  });
});
