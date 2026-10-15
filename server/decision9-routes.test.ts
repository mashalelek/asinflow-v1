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

describe("Add to SC preview probes gating live through the queue", () => {
  const route = () => between(routes(), 'app.post("/api/offer-add/preview"', 'app.post("/api/offer-add/submit"');

  it("enqueues a component-8 job for exactly the request's ASINs and awaits it BEFORE loading submit rows", () => {
    const r = route();
    const probe = r.indexOf("runJobAndWait(");
    const rows = r.indexOf("await loadSubmitRows(asins)");
    expect(probe).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(probe);
    const call = r.slice(probe, probe + 300);
    expect(call).toMatch(/components: \[8\]/);
    expect(call).toMatch(/scopeAsins: asins/);
    expect(call).toMatch(/trigger: "manual"/);
    expect(call).toMatch(/includeDaily: false/);
  });

  it("a failed probe is the preview's error — no preview on stale gating", () => {
    const r = route();
    const block = between(r, "runJobAndWait(", "await loadSubmitRows(asins)");
    expect(block).toMatch(/throw new Error\(`Gating probe failed — preview not shown/);
    expect(block).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it("streams with heartbeats so a wait behind a running pass survives the proxy", () => {
    const r = route();
    expect(r).toMatch(/await respondLongSync\(res, async \(\) => \{/);
    expect(r).not.toMatch(/res\.json\(\{\s*preFilter/);
    expect(r).toMatch(/gatingJobId/);
  });

  it("refuses when no runner is started — a job nobody runs would wait an hour", () => {
    expect(route()).toMatch(/if \(!isRunnerActive\(\)\)[^\n]*503/);
  });

  it("does not call getEligibility itself", () => {
    expect(route()).not.toMatch(/getEligibility\(/);
  });
});

describe("Push to Aura reads the PO sheet for its selection first", () => {
  const route = () => between(routes(), 'app.post("/api/sync/aura/push"', 'app.get("/api/export/velocity-upload"');

  it("goes through runAuraSyncChain with the selection — no direct pushAuraCosts", () => {
    const r = route();
    expect(r).toMatch(/runAuraSyncChain\(\{ asinFilter, requestedBy/);
    expect(r).not.toMatch(/pushAuraCosts\(/);
    expect(routes()).not.toMatch(/import \{ pushAuraCosts \}/);
  });

  it("is gated like the chain (sheet credentials, sheet id, Aura key) and on the runner", () => {
    const r = route();
    expect(r).toMatch(/GOOGLE_CREDENTIALS_PATH/);
    expect(r).toMatch(/GOOGLE_SHEET_ID/);
    expect(r).toMatch(/AURA_API_KEY/);
    expect(r).toMatch(/isRunnerActive\(\)/);
  });

  it("keeps the response shape the toolbar toast reads, plus the PO read result", () => {
    const r = route();
    expect(r).toMatch(/return \{ pushed: r\.aura\.pushed, unchanged: r\.aura\.unchanged, failed: r\.aura\.failed, skipped, notInAura: r\.aura\.notInAura, poSync: r\.poSync \}/);
  });

  it("the full chain route passes who asked", () => {
    const r = between(routes(), 'app.post("/api/sync/aura"', 'app.post("/api/sync/aura/push"');
    expect(r).toMatch(/runAuraSyncChain\(\{ requestedBy: req\.session\?\.userId \?\? null \}\)/);
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
    expect(repo).toMatch(/scope_asins, components, status/);
    expect(repo).toMatch(/INSERT INTO jobs \(kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, requested_by\)/);
  });
});

describe("the client", () => {
  it("preview reads the NDJSON stream; the dialog says what it is waiting on", () => {
    const home = readFileSync(join(__dirname, "..", "client", "src", "pages", "home.tsx"), "utf8");
    expect(home).toMatch(/fetchLongSync\("\/api\/offer-add\/preview", \{ asins: asinsToPreview \}\)/);
    const dialog = readFileSync(join(__dirname, "..", "client", "src", "components", "offer-add-preview-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/Probing gating live/);
  });
});
