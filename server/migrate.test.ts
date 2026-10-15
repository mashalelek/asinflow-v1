import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  runMigrations, migrationStatus, discoverMigrations, parseMigrationFile, setMigrateLogger, sha256,
  MigrationError, LAST_MANUAL_MIGRATION, BASELINE_VERSION, ADVISORY_LOCK_KEY,
} from "./migrate";

// SPEC §24 migration runner. Postgres is simulated by a query shim with
// enough transaction semantics to prove rollback: INSERTs inside BEGIN go to
// a buffer that COMMIT promotes and ROLLBACK discards. Migration SQL that
// contains the word FAIL throws, like a real syntax/constraint error would.

interface Ledger { version: number; filename: string; applied_at: Date; checksum: string }

function makePool(opts: { hasAsins: boolean; ledger?: Ledger[]; ledgerExists?: boolean }) {
  const ledger: Ledger[] = [...(opts.ledger ?? [])];
  let ledgerExists = opts.ledgerExists ?? (opts.ledger != null);
  let inTx = false;
  let buffer: Ledger[] = [];
  const executed: string[] = [];   // every SQL text, in order
  let released = 0;
  const client = {
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      executed.push(s);
      if (s.startsWith("SELECT pg_advisory_lock") || s.startsWith("SELECT pg_advisory_unlock")) return { rows: [], rowCount: 1 };
      if (s.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) { ledgerExists = true; return { rows: [], rowCount: 0 }; }
      if (s.startsWith("SELECT to_regclass('public.asins')")) return { rows: [{ present: opts.hasAsins }], rowCount: 1 };
      if (s.startsWith("SELECT to_regclass('public.schema_migrations')")) return { rows: [{ present: ledgerExists }], rowCount: 1 };
      if (s.startsWith("SELECT version, filename, applied_at, checksum FROM schema_migrations")) {
        return { rows: [...ledger].sort((a, b) => a.version - b.version), rowCount: ledger.length };
      }
      if (s === "BEGIN") { inTx = true; buffer = []; return { rows: [], rowCount: 0 }; }
      if (s === "COMMIT") { ledger.push(...buffer); buffer = []; inTx = false; return { rows: [], rowCount: 0 }; }
      if (s === "ROLLBACK") { buffer = []; inTx = false; return { rows: [], rowCount: 0 }; }
      if (s.startsWith("INSERT INTO schema_migrations")) {
        const row = { version: params[0], filename: params[1], checksum: params[2], applied_at: new Date() };
        (inTx ? buffer : ledger).push(row);
        return { rows: [], rowCount: 1 };
      }
      if (/\bFAIL\b/.test(s)) throw new Error(`syntax error at or near "FAIL"`);
      return { rows: [], rowCount: 0 }; // migration / baseline SQL
    },
    release() { released++; },
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, executed, ledger, get released() { return released; } };
}

let dir = "";
let baseline = "";
const logs: string[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-migrate-"));
  baseline = path.join(dir, "schema_baseline_test.sql");
  fs.writeFileSync(baseline, "-- baseline\nCREATE TABLE public.asins (id int);\n");
  fs.writeFileSync(path.join(dir, "001_first.sql"), "ALTER TABLE asins ADD COLUMN a int;\n");
  fs.writeFileSync(path.join(dir, "050_last_manual.sql"), "ALTER TABLE asins ADD COLUMN b int;\n");
  fs.writeFileSync(path.join(dir, "051_seed.sql"), "-- seed marker only\n");
  logs.length = 0;
  setMigrateLogger((m) => { logs.push(m); });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const run = (pool: any) => runMigrations(pool, { dir, baselinePath: baseline, now: () => 0 });

describe("discovery", () => {
  it("sorts by numeric prefix, parses opt-out and own-transaction flags", () => {
    fs.writeFileSync(path.join(dir, "010_x.sql"), "-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY i ON asins(a);\n");
    fs.writeFileSync(path.join(dir, "009_y.sql"), "BEGIN;\nSELECT 1;\nCOMMIT;\n");
    const files = discoverMigrations(dir);
    expect(files.map((f) => f.version)).toEqual([1, 9, 10, 50, 51]);
    expect(files.find((f) => f.version === 10)!.noTransaction).toBe(true);
    expect(files.find((f) => f.version === 9)!.managesTransaction).toBe(true);
    expect(files.find((f) => f.version === 1)!.managesTransaction).toBe(false);
    expect(parseMigrationFile("007_z.sql", "x").checksum).toBe(sha256("x"));
  });

  it("refuses duplicate prefixes before touching the database", async () => {
    fs.writeFileSync(path.join(dir, "051_other.sql"), "SELECT 1;\n");
    const { pool } = makePool({ hasAsins: true });
    await expect(run(pool)).rejects.toThrow(/duplicate migration prefix 051: 051_other\.sql and 051_seed\.sql/);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("first run on an EXISTING database (ledger empty, asins present)", () => {
  it("seeds baseline + files <= 050 without executing them, then applies 051", async () => {
    const { pool, executed, ledger } = makePool({ hasAsins: true });
    const r = await run(pool);
    expect(r.freshDatabase).toBe(false);
    expect(r.seeded).toBe(3);
    expect(r.appliedNow).toEqual(["051_seed.sql"]);
    expect(r.applied).toBe(4);
    expect(r.pending).toBe(0);
    expect(ledger.map((l) => l.version)).toEqual([BASELINE_VERSION, 1, 50, 51]);
    // Nothing from the baseline or the seeded files was executed.
    expect(executed.some((s) => s.includes("CREATE TABLE public.asins"))).toBe(false);
    expect(executed.some((s) => s.includes("ADD COLUMN a"))).toBe(false);
    expect(logs.some((l) => /seeding 3 rows/.test(l))).toBe(true);
    expect(logs.some((l) => l === "ledger: 3 applied, 1 pending")).toBe(true);
    expect(logs.some((l) => /^051_seed\.sql applied in \d+ ms$/.test(l))).toBe(true);
    expect(LAST_MANUAL_MIGRATION).toBe(50);
  });
});

describe("first run on an EMPTY database (no asins)", () => {
  it("applies the baseline in a transaction, records 0 + files <= 050, then applies 051", async () => {
    const { pool, executed, ledger } = makePool({ hasAsins: false });
    const r = await run(pool);
    expect(r.freshDatabase).toBe(true);
    expect(r.applied).toBe(4);
    expect(ledger.map((l) => l.version)).toEqual([0, 1, 50, 51]);
    const i = executed.findIndex((s) => s.includes("CREATE TABLE public.asins"));
    expect(i).toBeGreaterThan(-1);
    expect(executed[i - 1]).toBe("BEGIN");
    // the seeded files are NOT executed on a fresh database either — the baseline contains them
    expect(executed.some((s) => s.includes("ADD COLUMN a"))).toBe(false);
    expect(logs.some((l) => /applying baseline/.test(l))).toBe(true);
  });
});

describe("steady state and failure modes", () => {
  const seededLedger = (): Ledger[] => [
    { version: 0, filename: "schema_baseline_test.sql", checksum: "x", applied_at: new Date() },
    { version: 1, filename: "001_first.sql", checksum: sha256("ALTER TABLE asins ADD COLUMN a int;\n"), applied_at: new Date() },
    { version: 50, filename: "050_last_manual.sql", checksum: sha256("ALTER TABLE asins ADD COLUMN b int;\n"), applied_at: new Date() },
    { version: 51, filename: "051_seed.sql", checksum: sha256("-- seed marker only\n"), applied_at: new Date() },
  ];

  it("second run: nothing pending, nothing executed, 'schema current'", async () => {
    const { pool, executed } = makePool({ hasAsins: true, ledger: seededLedger() });
    const r = await run(pool);
    expect(r.applied).toBe(4);
    expect(r.appliedNow).toEqual([]);
    expect(executed.filter((s) => s === "BEGIN")).toHaveLength(0);
    expect(logs).toContain("schema current");
  });

  it("a failing file rolls back, records nothing, throws MigrationError, and still unlocks + releases", async () => {
    fs.writeFileSync(path.join(dir, "052_bad.sql"), "ALTER TABLE asins ADD COLUMN c int;\nFAIL;\n");
    const m = makePool({ hasAsins: true, ledger: seededLedger() });
    await expect(run(m.pool)).rejects.toMatchObject({ filename: "052_bad.sql" });
    await expect(run(m.pool)).rejects.toBeInstanceOf(MigrationError);
    expect(m.ledger.map((l) => l.version)).toEqual([0, 1, 50, 51]);
    const lastCtl = m.executed.filter((s) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(s)).pop();
    expect(lastCtl).toBe("ROLLBACK");
    expect(m.executed[m.executed.length - 2]).toMatch(/pg_advisory_unlock/);
    expect(m.executed[m.executed.length - 1]).toBe("RESET ALL");
    expect(m.released).toBe(2);
  });

  it("a file with its own BEGIN/COMMIT is refused unless it opts out", async () => {
    fs.writeFileSync(path.join(dir, "052_owntx.sql"), "BEGIN;\nALTER TABLE asins ADD COLUMN c int;\nCOMMIT;\n");
    const m = makePool({ hasAsins: true, ledger: seededLedger() });
    await expect(run(m.pool)).rejects.toThrow(/contains its own BEGIN\/COMMIT.*no-transaction/);
    expect(m.ledger.map((l) => l.version)).toEqual([0, 1, 50, 51]);
  });

  it("`-- migrate: no-transaction` applies outside BEGIN/COMMIT and is recorded", async () => {
    fs.writeFileSync(path.join(dir, "052_concurrent.sql"), "-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY i ON asins(a);\n");
    const m = makePool({ hasAsins: true, ledger: seededLedger() });
    const r = await run(m.pool);
    expect(r.appliedNow).toEqual(["052_concurrent.sql"]);
    const i = m.executed.findIndex((s) => s.includes("CREATE INDEX CONCURRENTLY"));
    expect(m.executed[i - 1]).not.toBe("BEGIN");
    expect(m.executed[i + 1]).toMatch(/^INSERT INTO schema_migrations/);
    expect(m.ledger.map((l) => l.version)).toEqual([0, 1, 50, 51, 52]);
  });

  it("a checksum mismatch warns and never re-runs", async () => {
    const led = seededLedger();
    led[3].checksum = "stale";
    const m = makePool({ hasAsins: true, ledger: led });
    const r = await run(m.pool);
    expect(r.checksumMismatches).toEqual(["051_seed.sql"]);
    expect(r.appliedNow).toEqual([]);
    expect(logs.some((l) => /WARNING: 051_seed\.sql changed on disk/.test(l))).toBe(true);
  });

  it("takes the advisory lock first and releases it last", async () => {
    const m = makePool({ hasAsins: true, ledger: seededLedger() });
    await run(m.pool);
    expect(m.executed[0]).toBe(`SELECT pg_advisory_lock($1)`);
    expect(m.executed[m.executed.length - 2]).toBe(`SELECT pg_advisory_unlock($1)`);
    expect(m.executed[m.executed.length - 1]).toBe("RESET ALL"); // pooled client handed back clean
    expect(ADVISORY_LOCK_KEY).toBe(7342001);
    expect(m.released).toBe(1);
  });
});

describe("migrationStatus (read-only)", () => {
  it("reports a missing ledger as never run with every file pending", async () => {
    const m = makePool({ hasAsins: true, ledgerExists: false });
    const s = await migrationStatus(m.pool, { dir, baselinePath: baseline });
    expect(s.ledgerExists).toBe(false);
    expect(s.pending).toEqual(["001_first.sql", "050_last_manual.sql", "051_seed.sql"]);
    expect(m.executed.some((s2) => /CREATE TABLE|pg_advisory_lock|INSERT/.test(s2))).toBe(false);
  });

  it("reports applied vs pending vs mismatched", async () => {
    fs.writeFileSync(path.join(dir, "052_new.sql"), "SELECT 1;\n");
    const led: Ledger[] = [
      { version: 0, filename: "schema_baseline_test.sql", checksum: "x", applied_at: new Date() },
      { version: 1, filename: "001_first.sql", checksum: "drifted", applied_at: new Date() },
      { version: 50, filename: "050_last_manual.sql", checksum: sha256("ALTER TABLE asins ADD COLUMN b int;\n"), applied_at: new Date() },
      { version: 51, filename: "051_seed.sql", checksum: sha256("-- seed marker only\n"), applied_at: new Date() },
    ];
    const m = makePool({ hasAsins: true, ledger: led });
    const s = await migrationStatus(m.pool, { dir, baselinePath: baseline });
    expect(s.ledgerExists).toBe(true);
    expect(s.applied.map((a) => a.version)).toEqual([0, 1, 50, 51]);
    expect(s.applied.every((a) => a.onDisk)).toBe(true);
    expect(s.pending).toEqual(["052_new.sql"]);
    expect(s.checksumMismatches).toEqual(["001_first.sql"]);
  });
});

describe("wiring", () => {
  it("index.ts runs migrations before ensureExtensionTables and exits on failure; migrate.ts never imports ./index", () => {
    const src = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
    const a = src.indexOf("await runMigrations(pool)");
    const b = src.indexOf("await ensureExtensionTables()");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(src.slice(a, b)).toMatch(/process\.exit\(1\)/);
    const m = fs.readFileSync(path.join(__dirname, "migrate.ts"), "utf8");
    expect(m).not.toMatch(/from\s+["']\.\/index["']/);
  });

  it("real repo: 051 exists, is comment-only, and no file above 050 manages its own transaction", () => {
    const real = discoverMigrations(path.join(__dirname, "..", "database", "migrations"));
    const f051 = real.find((f) => f.version === 51)!;
    expect(f051.filename).toBe("051_seed_schema_migrations.sql");
    expect(f051.sql.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("--"))).toBe(true);
    expect(real.filter((f) => f.version > LAST_MANUAL_MIGRATION && f.managesTransaction && !f.noTransaction)).toEqual([]);
    expect(fs.existsSync(path.join(__dirname, "..", "database", "schema_baseline_2026-10-15.sql"))).toBe(true);
  });
});
