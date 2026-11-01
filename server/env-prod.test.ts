// The production database URL lives in .env.production.local and is read ONLY
// by scripts run with --prod (script/env.ts). The server — dev or production
// build — never reads DATABASE_URL_PROD or that file (Maria, 2026-11-01).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("production DB URL stays out of the server", () => {
  it("no file under server/, shared/ or client/ names DATABASE_URL_PROD or .env.production.local", () => {
    const offenders: string[] = [];
    for (const dir of ["server", "shared", "client/src"]) {
      for (const f of walk(path.join(ROOT, dir))) {
        if (f.endsWith("env-prod.test.ts")) continue;
        const src = fs.readFileSync(f, "utf8");
        if (/DATABASE_URL_PROD|\.env\.production\.local/.test(src)) offenders.push(path.relative(ROOT, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it(".gitignore ignores .env*.local", () => {
    const lines = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain(".env*.local");
  });

  it("every script that reads DATABASE_URL loads script/env.ts, not dotenv/config directly", () => {
    const dir = path.join(ROOT, "script");
    const wrong: string[] = [];
    for (const e of fs.readdirSync(dir)) {
      if (!e.endsWith(".ts") || e === "env.ts") continue;
      const src = fs.readFileSync(path.join(dir, e), "utf8");
      if (!/DATABASE_URL/.test(src)) continue;
      if (/from ["']dotenv\/config["']|import ["']dotenv\/config["']/.test(src) || !/import ["']\.\/env["']/.test(src)) wrong.push(`script/${e}`);
    }
    // Scripts that take DATABASE_URL purely from the shell (no dotenv at all)
    // are listed here on purpose: they cannot reach production without the
    // caller exporting the URL by hand, which is the point of --prod.
    expect(wrong.filter((f) => /dotenv/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });
});
