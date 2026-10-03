import { describe, it, expect } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";

// express.json body limit (2026-09-07): the 100 KB default 413'd a
// 1,962-row Bulk Calc "Create list" POST (~527 KB) before the route ran,
// and the error surfaced behind the still-open Save-list dialog. The fix
// is limit: "10mb" in server/index.ts. Two guards here:
//   1. the config regression check — index.ts still declares the 10mb limit
//   2. a live round-trip — a >100 KB /api/bulk-lists-shaped body passes
//      express.json at 10mb (and the same body 413s at the default, proving
//      this test detects the limit's removal).

function bigBody(): string {
  // ~500 KB: 1,962 rows with URLs + notes, like the real upload.
  const asins = Array.from({ length: 1962 }, (_, i) => ({
    asin: `B0TEST${String(i).padStart(4, "0")}`,
    buyLink: `https://supplier.example.com/products/item-${i}?variant=${i}`,
    notes: `imported row ${i} — substitution candidate, check pack size`,
  }));
  return JSON.stringify({ name: "big list", sourceFilename: "big.csv", asins });
}

async function postJson(server: Server, body: string): Promise<number> {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bulk-lists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return res.status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("express.json limit — Bulk Calc Create list 413", () => {
  it("server/index.ts declares the 10mb limit", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(src).toMatch(/express\.json\(\{[^}]*limit:\s*"10mb"/);
  });

  it(">100 KB /api/bulk-lists body passes at 10mb", async () => {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.post("/api/bulk-lists", (req, res) => res.json({ rows: req.body.asins.length }));
    const body = bigBody();
    expect(body.length).toBeGreaterThan(100 * 1024);
    expect(await postJson(createServer(app), body)).toBe(200);
  });

  it("control: the same body 413s at express.json's default limit", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/bulk-lists", (_req, res) => res.json({ ok: true }));
    expect(await postJson(createServer(app), bigBody())).toBe(413);
  });
});
