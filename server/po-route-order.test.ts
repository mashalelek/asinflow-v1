import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// GET /api/pos/:id is registered before the fixed GET /api/pos/<word> paths
// (/api/pos/unmatched, and the New PO form's /api/pos/asin-lookup). Found
// 2026-10-18: "unmatched" reached the detail handler and 500'd on the uuid
// cast, so the Unmatched panel never loaded. The detail handler now hands
// any non-UUID id on with next().
describe("PO detail route does not swallow fixed /api/pos/<word> paths", () => {
  const src = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  const i = src.indexOf('app.get("/api/pos/:id", async (req: Request, res: Response, next: NextFunction) => {');
  it("the :id handler takes next and passes a non-UUID id on before touching the DB", () => {
    expect(i).toBeGreaterThan(0);
    const head = src.slice(i, src.indexOf("const poRes = await query", i));
    expect(head).toMatch(/if \(!\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i\.test\(id\)\) \{ next\(\); return; \}/);
  });
  it("the fixed paths it would shadow are registered after it", () => {
    for (const p of ['app.get("/api/pos/unmatched"']) expect(src.indexOf(p)).toBeGreaterThan(i);
  });
});
