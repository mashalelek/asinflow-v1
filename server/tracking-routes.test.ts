// PO tracking routes: Move to PO / add by hand (SPEC §26, patch commit 6).
import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

const pushCalls: any[] = [];
vi.mock("./tracking-push", () => ({ pushTracking: vi.fn(async (o: any) => { pushCalls.push(o.poId); return { pushed: 1 }; }) }));
vi.mock("./gmail-client", () => ({ gmailClient: () => ({}) }));
import { createTrackingRouter, suggestPos } from "./tracking-routes";
import { HEADER_FIELDS } from "./po-edit";

const PO_A = "11111111-1111-4111-8111-111111111111";
const PO_B = "22222222-2222-4222-8222-222222222222";
let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; pushCalls.length = 0; });

async function serve(opts: { moveRows?: number; insertRows?: number } = {}) {
  const sqls: Array<{ sql: string; params: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    sqls.push({ sql, params: params ?? [] });
    if (sql.startsWith("SELECT id, supplier") && sql.includes("FROM purchase_orders")) return { rows: [{ id: params![0], supplier: "macys.com", order_id: "4798028553" }], rowCount: 1 };
    if (sql.includes("UPDATE po_tracking SET reassigned_from_po_id")) return { rows: Array.from({ length: opts.moveRows ?? 1 }, () => ({ id: 7 })), rowCount: opts.moveRows ?? 1 };
    if (sql.includes("INSERT INTO po_tracking")) return { rows: Array.from({ length: opts.insertRows ?? 1 }, () => ({ id: 8 })), rowCount: opts.insertRows ?? 1 };
    return { rows: [], rowCount: 0 };
  };
  const app = express();
  app.use(express.json());
  app.use(createTrackingRouter({ query: query as any }));
  const server = app.listen(0);
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, b: any) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { post, sqls };
}

describe("Move to PO… (§10)", () => {
  it("records where it came from, marks it manual (the sync never moves it back), and routes / pushes the NEW PO", async () => {
    const s = await serve();
    const r = await s.post("/api/tracking/7/move", { po_id: PO_B });
    expect(r.status).toBe(200);
    const up = s.sqls.find((x) => x.sql.includes("reassigned_from_po_id"))!;
    expect(up.sql).toMatch(/reassigned_from_po_id = COALESCE\(po_id, reassigned_from_po_id\), reassigned_at = NOW\(\), source = 'manual'/);
    expect(up.params).toEqual([7, PO_B, "macys.com"]);
    expect(pushCalls).toEqual([PO_B]);
  });
  it("a row already on that PO / a placeholder → 409, nothing pushed", async () => {
    const s = await serve({ moveRows: 0 });
    expect((await s.post("/api/tracking/7/move", { po_id: PO_B })).status).toBe(409);
    expect(pushCalls).toEqual([]);
  });
});

describe("Add tracking by hand", () => {
  it("inserts a manual, matched row and routes / pushes the PO; a known number → 409", async () => {
    let s = await serve();
    expect((await s.post(`/api/pos/${PO_A}/tracking`, { carrier: "ups", tracking_number: "1ze3652c0344289436" })).status).toBe(200);
    const ins = s.sqls.find((x) => x.sql.includes("INSERT INTO po_tracking"))!;
    expect(ins.params.slice(0, 3)).toEqual([PO_A, "UPS", "1ZE3652C0344289436"]);
    expect(ins.sql).toMatch(/'manual', 'manual', 'matched'/);
    expect(pushCalls).toEqual([PO_A]);
    s = await serve({ insertRows: 0 });
    expect((await s.post(`/api/pos/${PO_A}/tracking`, { carrier: "UPS", tracking_number: "1ZE3652C0344289436" })).status).toBe(409);
  });
  it("validates carrier and number", async () => {
    const s = await serve();
    expect((await s.post(`/api/pos/${PO_A}/tracking`, { carrier: "PONY", tracking_number: "1ZE3652C0344289436" })).status).toBe(400);
    expect((await s.post(`/api/pos/${PO_A}/tracking`, { carrier: "UPS", tracking_number: "x" })).status).toBe(400);
  });
});

describe("ships_to on the PO header", () => {
  it("velocity | home only", () => {
    expect(HEADER_FIELDS.ships_to("home")).toEqual({ ok: true, value: "home" });
    expect(HEADER_FIELDS.ships_to("warehouse")).toMatchObject({ ok: false });
  });
});

describe("unmatched queue suggestions (2026-10-22)", () => {
  const pos = [
    { id: "p-rhode", supplier: "rhode.com", order_id: "8547348" },
    { id: "p-a", supplier: "a.com", order_id: "55555" }, { id: "p-b", supplier: "b.com", order_id: "55555_2" },
  ];
  it("digits-only hits across suppliers (a mapped sender's no_po: rhodeskin.com → rhode.com's PO); several kept for one-click choice; none without an order #", () => {
    expect(suggestPos({ retailer_order_id: "8547348", supplier_guess: "rhodeskin.com" }, pos)).toEqual([{ po_id: "p-rhode", order_id: "8547348", supplier: "rhode.com" }]);
    expect(suggestPos({ retailer_order_id: "55555", supplier_guess: null }, pos).map((x) => x.po_id)).toEqual(["p-a", "p-b"]);
    expect(suggestPos({ retailer_order_id: null, supplier_guess: "a.com" }, pos)).toEqual([]);
  });
});
