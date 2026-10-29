import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Importing server/index.ts boots the server: migrations, Express on PORT and
// the job runner. A script that reached it through any server module ran a
// second runner against its DATABASE_URL (script/relist.ts against
// production, 2026-10-29: it never got the runner lock, and the runner's
// retries kept the finished script alive). Server modules log through ./log.
describe("no server module imports the entry module", () => {
  const importsIndex = /from\s+["']\.\/index["']/;
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts");

  it("no server/*.ts outside index.ts imports ./index", () => {
    const bad = files.filter((f) => importsIndex.test(readFileSync(join(__dirname, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
