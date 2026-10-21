// The /api request log never carries a response body (2026-10-21).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { requestLogLine } from "./request-log";

const ASINS_BODY = { rows: [{ asin: "B000000001", cogs: 12.34, buy_link: "https://www.example-supplier.com/item/1", notes: "secret note" }], total: 1 };

describe("requestLogLine", () => {
  it("a success logs method, path, status and duration — nothing from the body", () => {
    const line = requestLogLine("GET", "/api/asins", 200, 41, ASINS_BODY);
    expect(line).toBe("GET /api/asins 200 in 41ms");
    expect(line).not.toMatch(/B000000001|12\.34|example-supplier|secret/);
  });
  it("a failure keeps error and message strings only, truncated; other fields never", () => {
    expect(requestLogLine("POST", "/api/listing-hygiene/release", 409, 7, { error: "already_released", message: "job #123's held deletes were already released (job #136, done)", job: { id: 136, params: { x: 1 } } }))
      .toBe("POST /api/listing-hygiene/release 409 in 7ms :: already_released: job #123's held deletes were already released (job #136, done)");
    expect(requestLogLine("GET", "/api/asins", 500, 3, { ...ASINS_BODY, message: "boom" })).toBe("GET /api/asins 500 in 3ms :: boom");
    const long = requestLogLine("GET", "/api/x", 500, 1, { message: "y".repeat(1000) });
    expect(long.length).toBeLessThan(400);
    expect(long.endsWith("…")).toBe(true);
  });
  it("a failure without error / message strings logs no body", () => {
    expect(requestLogLine("GET", "/api/x", 404, 2, ASINS_BODY)).toBe("GET /api/x 404 in 2ms");
    expect(requestLogLine("GET", "/api/x", 500, 2, undefined)).toBe("GET /api/x 500 in 2ms");
  });
  it("index.ts logs through requestLogLine and never stringifies the captured body", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(src).toMatch(/log\(requestLogLine\(req\.method, path, res\.statusCode, Date\.now\(\) - start, capturedJsonResponse\)\)/);
    expect(src).not.toMatch(/JSON\.stringify\(capturedJsonResponse\)/);
  });
});
