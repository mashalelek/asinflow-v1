import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Scheduler decision 9 (2026-10-13), commit 4 of the scheduler patch:
//   Add to SC probes gating LIVE for its selection (component 8 as a
//   one-component job, awaited) — it does not trust the daily value;
//   Push to Aura reads the PO sheet for its selection first (component 9,
//   same shape) — the same dependency the chain has.
// Structural pins on routes.ts: the two routes go through the queue and
// nothing in them calls SP-API or the sheet directly.

const routes = () => readFileSync(join(__dirname, "routes.ts"), "utf8");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from); const b = s.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`anchors not found: ${from} .. ${to}`);
  return s.slice(a, b);
};

describe("Add to SC preview probes gating live INLINE (amended 2026-10-16 — no jobs row)", () => {
  const route = () => between(routes(), 'app.post("/api/offer-add/preview"', 'app.post("/api/offer-add/submit"');

  it("calls the shared writer for exactly the request's ASINs BEFORE loading submit rows", () => {
    const r = route();
    const probe = r.indexOf("await probeGatingForAsins(");
    const rows = r.indexOf("await loadSubmitRows(asins)");
    expect(probe).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(probe);
    expect(r.slice(probe, probe + 200)).toMatch(/asins\.map\(\(a\) => String\(a\)\.trim\(\)\.toUpperCase\(\)\)/);
  });

  it("enqueues nothing and does not gate on the runner — the queue is not involved", () => {
    const r = route();
    expect(r).not.toMatch(/runJobAndWait|enqueueJob|components: \[8\]|isRunnerActive/);
    expect(routes()).not.toMatch(/components: \[8\]/);
  });

  it("still streams with heartbeats and reports the probe in notes.gating", () => {
    const r = route();
    expect(r).toMatch(/await respondLongSync\(res, async \(\) => \{/);
    expect(r).toMatch(/notes: \{[\s\S]*gating: `Probed live for the selection just now/);
    expect(r).toMatch(/gatingErrors/);
  });

  it("does not call getEligibility itself", () => {
    expect(route()).not.toMatch(/getEligibility\(/);
  });
});

describe("Push to Aura reads the PO sheet for its selection first — INLINE, off the queue (2026-10-16)", () => {
  const route = () => between(routes(), 'app.post("/api/sync/aura/push"', 'app.get("/api/export/velocity-upload"');

  it("goes through runAuraSyncChain with the selection — no direct pushAuraCosts, no job", () => {
    const r = route();
    expect(r).toMatch(/runAuraSyncChain\(\{ asinFilter \}\)/);
    expect(r).not.toMatch(/pushAuraCosts\(|runJobAndWait|enqueueJob|isRunnerActive/);
    expect(routes()).not.toMatch(/import \{ pushAuraCosts \}|runJobAndWait|components: \[9\]/);
  });

  it("is gated by the Aura key only — the cost read is the AF PO tables since po-af-owned §2.4 (2026-10-18)", () => {
    const r = route();
    expect(r).not.toMatch(/GOOGLE_CREDENTIALS_PATH/);
    expect(r).not.toMatch(/GOOGLE_SHEET_ID/);
    expect(r).toMatch(/AURA_API_KEY/);
  });

  it("keeps the response shape the toolbar toast reads, plus the PO read result", () => {
    const r = route();
    expect(r).toMatch(/return \{ pushed: r\.aura\.pushed, unchanged: r\.aura\.unchanged, failed: r\.aura\.failed, skipped, notInAura: r\.aura\.notInAura, poSync: r\.poSync \}/);
  });

  it("the full chain route is the same function without a selection", () => {
    const r = between(routes(), 'app.post("/api/sync/aura"', 'app.post("/api/sync/aura/push"');
    expect(r).toMatch(/runAuraSyncChain\(\)/);
  });
});

describe("migration 053 adds jobs.components", () => {
  const file = join(__dirname, "..", "database", "migrations", "053_jobs_components.sql");
  it("exists and adds the column with a comment, nothing else", () => {
    expect(existsSync(file)).toBe(true);
    const s = readFileSync(file, "utf8");
    expect(s).toMatch(/ALTER TABLE jobs ADD COLUMN components INTEGER\[\];/);
    expect(s).toMatch(/COMMENT ON COLUMN jobs\.components/);
    expect(s).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m);
    expect(s).not.toMatch(/DROP|DELETE|UPDATE /);
  });
  it("the repo reads and writes it", () => {
    const repo = readFileSync(join(__dirname, "scheduler", "jobs-repo.ts"), "utf8");
    expect(repo).toMatch(/scope_asins, components, params, status/);
    expect(repo).toMatch(/INSERT INTO jobs \(kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, params, requested_by\)/);
  });
});

describe("the client", () => {
  it("preview reads the NDJSON stream; the dialog says what it is waiting on", () => {
    const home = readFileSync(join(__dirname, "..", "client", "src", "pages", "home.tsx"), "utf8");
    expect(home).toMatch(/fetchLongSync\("\/api\/offer-add\/preview", \{ asins: asinsToPreview \}\)/);
    const dialog = readFileSync(join(__dirname, "..", "client", "src", "components", "offer-add-preview-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/Checking gating live/);
  });
});
