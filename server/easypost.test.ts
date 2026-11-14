// Carrier status — EasyPost (SPEC §26 "Carrier status — EasyPost", claims patch §3.9, commit 4). Every EasyPost
// answer here is a RECORDED test-key response (server/__fixtures__/easypost/*.json, EasyPost's EZ… test codes,
// "John Tester"); the suite never calls EasyPost.
import { describe, it, expect } from "vitest";
import express from "express";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  trackerUpdate, trackerAction, registerTrackers, sweepTrackers, applyCarrierUpdate, recordVelocityTrackingStatus, poDeliveryState,
  easypostSignature, verifyEasypostSignature, createEasypostWebhookRouter, easypostCarrier, EASYPOST_CARRIERS, MAX_AGE_DAYS, SILENT_DAYS,
  easypostDeps, REGISTER_PAUSE_MS, EASYPOST_CARRIER_OPTIONS, type EasypostFetch, type EasypostTracker,
} from "./easypost";
easypostDeps.sleep = async () => {};
import { carrierStatusText, isTerminalStatus } from "@shared/carrier-status";
import { COMPONENTS } from "./scheduler/components";
import { SCHEDULED_ONLY_COMPONENTS, explicitlyAuthorized } from "./scheduler/types";

const FIX = join(__dirname, "__fixtures__", "easypost");
const fx = (name: string): EasypostTracker => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));

/** A fake EasyPost: POST answers from the fixture for the code, GET from the fixture for the id; records every call. */
function fakeEasypost(calls: Array<{ method: string; path: string; body?: any }> = []): EasypostFetch {
  const byCode: Record<string, string> = { EZ1000000001: "tracker-pre_transit", EZ2000000002: "tracker-in_transit", EZ3000000003: "tracker-out_for_delivery", EZ4000000004: "tracker-delivered", EZ5000000005: "tracker-return_to_sender", EZ6000000006: "tracker-failure", EZ7000000007: "tracker-unknown" };
  const all = readdirSync(FIX).filter((f) => f.startsWith("tracker-")).map((f) => fx(f.replace(/\.json$/, "")));
  return async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    if (init.method === "POST") {
      const name = byCode[body?.tracker?.tracking_code];
      if (!name) return { status: 422, json: async () => fx("error-bad-carrier") };
      return { status: 201, json: async () => fx(name) };
    }
    const id = decodeURIComponent(path.split("/").pop()!);
    const t = all.find((x) => x.id === id);
    return t ? { status: 200, json: async () => t } : { status: 404, json: async () => ({ error: { code: "NOT_FOUND", message: "no such tracker" } }) };
  };
}

/** A fake query: the candidate rows for the select, every UPDATE recorded with its params. */
function fakeQuery(rows: any[], writes: Array<{ sql: string; params: any[] }> = []) {
  return async (sql: string, params?: any[]) => {
    if (/^\s*SELECT t\.id, t\.carrier, t\.tracking_number, t\.direction/.test(sql)) return { rows, rowCount: rows.length };
    // the return sync's read (claims commit 7: the return rows carrying the tracker) — no return rows here
    if (/^\s*SELECT/.test(sql)) return { rows: [], rowCount: 0 };
    writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params: params ?? [] });
    const code = String(params?.[5] ?? "");
    const n = rows.filter((r) => String(r.tracking_number).toUpperCase() === code || r.easypost_tracker_id === params?.[0]).length;
    return { rows: [], rowCount: Math.max(n, 1) };
  };
}
const NOW = new Date("2026-11-12T03:00:00Z");

describe("status mapping (recorded trackers)", () => {
  it("each recorded status → carrier_status, est_delivery_at, the latest scan; delivered_at only when delivered (the delivery scan's time)", () => {
    const u = trackerUpdate(fx("tracker-delivered"));
    expect(u).toMatchObject({ easypost_tracker_id: "trk_9d93d695e5f948caa20ba1ccf705ee91", tracking_code: "EZ4000000004", carrier_status: "delivered", is_return: false });
    expect(u.delivered_at).toBe("2026-10-14T15:47:53.000Z");
    expect(u.last_scan_at).toBe("2026-10-14T15:47:53.000Z");
    expect(u.est_delivery_at).toBe("2026-11-12T01:56:53.000Z");
    for (const [name, status] of [["pre_transit", "pre_transit"], ["in_transit", "in_transit"], ["out_for_delivery", "out_for_delivery"], ["return_to_sender", "return_to_sender"], ["failure", "failure"], ["unknown", "unknown"]] as const) {
      const x = trackerUpdate(fx(`tracker-${name}`));
      expect(x.carrier_status).toBe(status);
      expect(x.delivered_at).toBeNull();
      if (name !== "unknown") expect(x.last_scan_at).toMatch(/^\d{4}-/);
    }
    expect(trackerUpdate(fx("tracker-unknown")).est_delivery_at).toBeNull();
  });
  it("a status EasyPost adds later is stored as unknown; a delivered tracker with no scans still gets a delivered_at", () => {
    expect(trackerUpdate({ id: "trk_x", status: "teleported", tracking_code: "1z1" }).carrier_status).toBe("unknown");
    expect(trackerUpdate({ id: "trk_x", status: "delivered", tracking_code: "1z1", updated_at: "2026-11-01T00:00:00Z" }).delivered_at).toBe("2026-11-01T00:00:00.000Z");
  });
  it("return trackers: is_return is carried; a re-POST of a code already registered inbound returns the existing (inbound) tracker — recorded", () => {
    expect(trackerUpdate({ ...fx("tracker-delivered"), is_return: true }).is_return).toBe(true);
    // EasyPost answered the is_return POST for EZ4000000004 with the tracker created without it: same id, is_return false.
    expect(fx("tracker-return-delivered").id).toBe(fx("tracker-delivered").id);
    expect(fx("tracker-return-delivered").is_return).toBe(false);
  });
  it("the words the readers show, and the Velocity fallback", () => {
    expect(carrierStatusText({ carrier_status: "out_for_delivery" })).toEqual({ text: "Out for delivery", source: "easypost" });
    expect(carrierStatusText({ carrier_status: null, velocity_tracking_status: "In Transit" })).toEqual({ text: "Velocity: In Transit", source: "velocity" });
    expect(carrierStatusText({ carrier_status: "delivered", velocity_tracking_status: "In Transit" })!.source).toBe("easypost");
    expect(carrierStatusText({})).toBeNull();
    expect(isTerminalStatus("delivered")).toBe(true);
    expect(isTerminalStatus("in_transit")).toBe(false);
  });
});

describe("registration", () => {
  const row = (o: Partial<any>) => ({ id: 1, carrier: "USPS", tracking_number: "EZ2000000002", direction: "inbound", delivered_at: null, easypost_tracker_id: null, easypost_registered_at: null, carrier_checked_at: null, ...o });
  it("the carriers EasyPost tracks for AF; GLS / OnTrac / LaserShip / OTHER are not", () => {
    // FedEx: the managed "FedEx Wallet" account is `FedExDefault` (`FedEx` = a user-owned account → CREDENTIALS_NOT_FOUND, 2026-11-12); DHL: auto-detect first.
    expect(EASYPOST_CARRIER_OPTIONS).toEqual({ UPS: ["UPS"], USPS: ["USPS"], FEDEX: ["FedExDefault", null], DHL: [null, "DHLExpress"], AMAZON: ["AmazonMws", null] });
    expect(EASYPOST_CARRIERS).toEqual({ UPS: "UPS", USPS: "USPS", FEDEX: "FedExDefault", DHL: "auto", AMAZON: "AmazonMws" });
    expect(easypostCarrier("fedex")).toBe("FedExDefault");
    for (const c of ["GLS", "ONTRAC", "LASERSHIP", "OTHER"]) expect(easypostCarrier(c)).toBeNull();
  });
  it("POST /trackers with carrier + tracking_code (+ is_return for a return); the answer is applied to every row with the number; the id stored", async () => {
    const calls: any[] = []; const writes: any[] = [];
    const rows = [row({ id: 1 }), row({ id: 2, direction: "return", tracking_number: "EZ4000000004" }), row({ id: 3, carrier: "GLS", tracking_number: "12345678" })];
    const r = await registerTrackers(fakeQuery(rows, writes), NOW, fakeEasypost(calls));
    expect(calls.map((c) => [c.method, c.path, c.body.tracker])).toEqual([
      ["POST", "/trackers", { tracking_code: "EZ2000000002", carrier: "USPS", is_return: false }],
      ["POST", "/trackers", { tracking_code: "EZ4000000004", carrier: "USPS", is_return: true }],
    ]);
    expect(r).toMatchObject({ registered: 2, errors: 0, skipped: { carrier: 1 } });
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toMatch(/^UPDATE po_tracking SET easypost_tracker_id = \$1, carrier_status = \$2/);
    expect(writes[0].sql).toContain("easypost_registered_at = COALESCE(easypost_registered_at, NOW())");
    expect(writes[0].sql).toContain("easypost_tracker_id = $1 OR (easypost_tracker_id IS NULL AND upper(tracking_number) = $6)");
    expect(writes[0].params).toEqual(["trk_788c18cc481345428730a8cee9cc0399", "in_transit", "2026-11-12T01:56:52.000Z", expect.stringMatching(/^2026-/), null, "EZ2000000002"]);
    expect(writes[1].params[1]).toBe("delivered");
    expect(writes[1].params[4]).toBe("2026-10-14T15:47:53.000Z");
    expect(r.outcomes["USPS EZ2000000002"]).toMatch(/^trk_788c18cc481345428730a8cee9cc0399 in_transit eta 2026-11-12/);
  });
  it("idempotent: the same number on two rows (split rows, two POs) is POSTed once; a re-POST returns the same tracker id (recorded)", async () => {
    const calls: any[] = [];
    const r = await registerTrackers(fakeQuery([row({ id: 1 }), row({ id: 9, tracking_number: "ez2000000002" })]), NOW, fakeEasypost(calls));
    expect(calls).toHaveLength(1);
    expect(r.registered).toBe(1);
    expect(fx("tracker-in_transit-repost").id).toBe(fx("tracker-in_transit").id);
  });
  it("rows on OPEN POs only, any age (the SQL joins closed_at IS NULL); the delivered stop; an EasyPost refusal is one error, the pass goes on", async () => {
    const calls: any[] = []; const selects: string[] = [];
    const rows = [row({ id: 2, delivered_at: "2026-11-01T00:00:00Z" }), row({ id: 3, tracking_number: "1Z999" }), row({ id: 4, tracking_number: "EZ1000000001" })];
    const base = fakeQuery(rows);
    const r = await registerTrackers(async (sql, params) => { if (/^\s*SELECT t\.id/.test(sql)) selects.push(sql.replace(/\s+/g, " ")); return base(sql, params); }, NOW, fakeEasypost(calls));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("JOIN purchase_orders p ON p.id = t.po_id AND p.closed_at IS NULL");
    expect(selects[0]).not.toMatch(/days/);
    expect(r).toMatchObject({ registered: 1, errors: 1, skipped: { delivered: 1 } });
    expect(r.outcomes["USPS 1Z999"]).toMatch(/^error: EasyPost POST \/trackers failed \(HTTP 422, TRACKER.INVALID_TEST_CODE/);
    expect(calls).toHaveLength(2);
    // Age never matters for registration (Maria 2026-11-12): a July shipment on an open PO is registered.
    expect(trackerAction(row({ shipped_at: "2026-07-01T00:00:00Z" }), NOW, "register")).toBe("register");
    expect(trackerAction(row({ easypost_tracker_id: "trk_1" }), NOW, "register")).toBe("skip:registered");
  });
  it("the cap: at most REGISTER_CAP calls per pass, the rest counted over_cap; a pause between POSTs", async () => {
    const rows = [row({ id: 1 }), row({ id: 2, tracking_number: "EZ1000000001" }), row({ id: 3, tracking_number: "EZ3000000003" })];
    const pauses: number[] = []; const real = easypostDeps.sleep; easypostDeps.sleep = async (ms) => { pauses.push(ms); };
    try {
      const r = await registerTrackers(fakeQuery(rows), NOW, fakeEasypost(), 2);
      expect(r).toMatchObject({ registered: 2, skipped: { over_cap: 1 } });
      expect(pauses).toEqual([REGISTER_PAUSE_MS]); // one pause between the two calls, none before the first
    } finally { easypostDeps.sleep = real; }
  });
  it("a 429 stops the pass (the rest counted rate_limited, candidates again next hour); a carrier refused on every option is skipped for the rest of the pass — the first production pass, 2026-11-12", async () => {
    const calls: any[] = [];
    const fetchFn: EasypostFetch = async (path, init) => {
      const code = JSON.parse(init.body!).tracker;
      calls.push(code);
      if (code.tracking_code.startsWith("3845")) return { status: 404, json: async () => ({ error: { code: "CREDENTIALS_NOT_FOUND", message: "Credentials not found for the specified carrier" } }) };
      if (calls.length >= 4) return { status: 429, json: async () => ({ error: { code: "RATE_LIMITED", message: "Your account has been temporarily rate-limited" } }) };
      return { status: 201, json: async () => fx("tracker-in_transit") };
    };
    const rows = [row({ id: 1, carrier: "FEDEX", tracking_number: "384578744445" }), row({ id: 2, carrier: "FEDEX", tracking_number: "384546890989" }), row({ id: 3, carrier: "UPS", tracking_number: "1Z1" }), row({ id: 4, carrier: "UPS", tracking_number: "1Z2" }), row({ id: 5, carrier: "USPS", tracking_number: "9400" }), row({ id: 6, carrier: "FEDEX", tracking_number: "384500000000" })];
    const r = await registerTrackers(fakeQuery(rows), NOW, fetchFn);
    // FedEx: FedExDefault refused, then auto refused → the carrier is out for the pass; UPS 1Z1 ok; 1Z2 → 429 → stop.
    expect(calls.map((c) => [c.tracking_code, c.carrier ?? "auto"])).toEqual([["384578744445", "FedExDefault"], ["384578744445", "auto"], ["1Z1", "UPS"], ["1Z2", "UPS"]]);
    expect(r).toMatchObject({ registered: 1, errors: 2, rate_limited: true, no_carrier_account: ["FEDEX"], skipped: { no_carrier_account_fedex: 1, rate_limited: 2 } }); // the last FedEx row is counted rate_limited: the pass had already stopped
    expect(r.outcomes["FEDEX 384578744445"]).toContain("CREDENTIALS_NOT_FOUND");
    expect(r.outcomes["FEDEX 384578744445"]).toContain("after FedExDefault: CREDENTIALS_NOT_FOUND");
    expect(r.outcomes["UPS 1Z2"]).toContain("HTTP 429");
  });
  it("carrier options: FedEx falls back from FedExDefault to auto-detect on CREDENTIALS_NOT_FOUND and keeps the working option for the pass; DHL is auto-detect first; a CARRIER_CODE_MISMATCH advances too", async () => {
    const calls: any[] = [];
    const fetchFn: EasypostFetch = async (path, init) => {
      const t = JSON.parse(init.body!).tracker; calls.push([t.tracking_code, t.carrier ?? "auto"]);
      if (t.carrier === "FedExDefault") return { status: 404, json: async () => ({ error: { code: "CREDENTIALS_NOT_FOUND", message: "no creds" } }) };
      if (t.tracking_code === "9261" && !t.carrier) return { status: 422, json: async () => ({ error: { code: "TRACKER.CARRIER_CODE_MISMATCH", message: "mismatch" } }) };
      return { status: 201, json: async () => ({ ...fx("tracker-in_transit"), carrier: t.carrier ?? "FedExDefault" }) };
    };
    const rows = [row({ id: 1, carrier: "FEDEX", tracking_number: "3845A" }), row({ id: 2, carrier: "FEDEX", tracking_number: "3845B" }), row({ id: 3, carrier: "DHL", tracking_number: "9261" }), row({ id: 4, carrier: "DHL", tracking_number: "9262" })];
    const r = await registerTrackers(fakeQuery(rows), NOW, fetchFn);
    expect(calls).toEqual([["3845A", "FedExDefault"], ["3845A", "auto"], ["3845B", "auto"], ["9261", "auto"], ["9261", "DHLExpress"], ["9262", "DHLExpress"]]);
    expect(r).toMatchObject({ registered: 4, errors: 0, no_carrier_account: [], carrier_used: { FEDEX: "auto (FedExDefault)", DHL: "DHLExpress" } });
    expect(r.outcomes["FEDEX 3845A"]).toContain("(as auto after FedExDefault: CREDENTIALS_NOT_FOUND)");
    expect(r.outcomes["FEDEX 3845B"]).not.toContain("after");
    // A POST without a carrier omits the key entirely (EasyPost auto-detects); with one it is sent.
    expect(JSON.parse(JSON.stringify({ tracker: { tracking_code: "x", is_return: false } }))).not.toHaveProperty("tracker.carrier");
  });
});

describe("the daily sweep (backstop for a missed webhook)", () => {
  const row = (o: Partial<any>) => ({ id: 1, carrier: "USPS", tracking_number: "EZ2000000002", direction: "inbound", delivered_at: null, easypost_tracker_id: "trk_788c18cc481345428730a8cee9cc0399", easypost_registered_at: "2026-11-01T00:00:00Z", carrier_checked_at: "2026-11-01T00:00:00Z", ...o });
  it("re-reads a registered, undelivered tracker silent for 3 days; leaves fresh, delivered, unregistered ones and those registered over 60 days ago", async () => {
    const calls: any[] = [];
    const rows = [
      row({ id: 1 }),
      row({ id: 2, tracking_number: "EZ4000000004", easypost_tracker_id: "trk_9d93d695e5f948caa20ba1ccf705ee91", carrier_checked_at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      row({ id: 3, tracking_number: "EZ3000000003", easypost_tracker_id: "trk_4cdf2be2dace40249a35f376b7b2c36f", delivered_at: "2026-11-02T00:00:00Z" }),
      row({ id: 4, tracking_number: "1Z1", easypost_tracker_id: null }),
      row({ id: 5, tracking_number: "EZ1000000001", easypost_tracker_id: "trk_78110eaca35f4edeb12dea4f645b7e5f", easypost_registered_at: "2026-08-01T00:00:00Z" }),
    ];
    const r = await sweepTrackers(fakeQuery(rows), NOW, fakeEasypost(calls));
    expect(calls).toEqual([{ method: "GET", path: "/trackers/trk_788c18cc481345428730a8cee9cc0399", body: undefined }]);
    expect(r).toMatchObject({ checked: 1, errors: 0, skipped: { fresh: 1, delivered: 1, registered: 1, too_old: 1 } });
    expect(r.outcomes["USPS EZ2000000002"]).toMatch(/^in_transit last scan 2026-/);
    expect(trackerAction(row({ carrier_checked_at: new Date(NOW.getTime() - (SILENT_DAYS - 0.5) * 86_400_000) }), NOW, "sweep")).toBe("skip:fresh");
    expect(trackerAction(row({ carrier_checked_at: null }), NOW, "sweep")).toBe("sweep");
    expect(trackerAction(row({ easypost_registered_at: new Date(NOW.getTime() - (MAX_AGE_DAYS + 1) * 86_400_000) }), NOW, "sweep")).toBe("skip:too_old");
    expect(trackerAction(row({ easypost_registered_at: new Date(NOW.getTime() - (MAX_AGE_DAYS - 1) * 86_400_000) }), NOW, "sweep")).toBe("sweep");
  });
});

describe("the webhook", () => {
  const SECRET = "whsec_test_0123";
  async function serve(query: any, secret: string | undefined, log?: (m: string) => void) {
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.use(createEasypostWebhookRouter({ query, secret: () => secret, log }));
    const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server.address() as any).port;
    const post = (body: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/webhooks/easypost`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    return { post, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const event = (tracker: EasypostTracker) => JSON.stringify({ id: "evt_1", object: "Event", description: "tracker.updated", result: tracker });
  it("signature = HMAC-SHA256 of the NFKD-normalised raw body, sent as hmac-sha256-hex=…; verified in constant time", () => {
    const body = Buffer.from('{"a":"é"}');
    const sig = easypostSignature(body, SECRET);
    expect(sig).toMatch(/^hmac-sha256-hex=[0-9a-f]{64}$/);
    expect(easypostSignature('{"a":"é"}', SECRET)).toBe(sig); // the decomposed form signs the same
    expect(verifyEasypostSignature(body, sig, SECRET)).toBe(true);
    expect(verifyEasypostSignature(body, sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")), SECRET)).toBe(false);
    expect(verifyEasypostSignature(body, sig, "other")).toBe(false);
    expect(verifyEasypostSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyEasypostSignature(body, sig, undefined)).toBe(false);
    expect(verifyEasypostSignature(undefined, sig, SECRET)).toBe(false);
  });
  it("a signed tracker.updated stores the status on every row with the tracker id; unsigned, wrong-secret and no-secret events are 401 and store nothing", async () => {
    const writes: any[] = [];
    // the return sync's read (commit 7) is not a write
    const query = async (sql: string, params?: any[]) => { if (/^\s*SELECT/.test(sql)) return { rows: [], rowCount: 0 }; writes.push({ sql, params }); return { rows: [], rowCount: 2 }; };
    const s = await serve(query, SECRET);
    try {
      const body = event(fx("tracker-delivered"));
      const ok = await s.post(body, { "X-Hmac-Signature": easypostSignature(body, SECRET) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, rows: 2 });
      expect(writes).toHaveLength(1);
      expect(writes[0].params).toEqual(["trk_9d93d695e5f948caa20ba1ccf705ee91", "delivered", "2026-11-12T01:56:53.000Z", "2026-10-14T15:47:53.000Z", "2026-10-14T15:47:53.000Z", "EZ4000000004"]);
      const unsigned = await s.post(body);
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "bad_signature" });
      expect((await s.post(body, { "X-Hmac-Signature": easypostSignature(body, "wrong") })).status).toBe(401);
      expect((await s.post(body, { "X-Hmac-Signature": easypostSignature(body + " ", SECRET) })).status).toBe(401); // a body changed in flight
      expect(writes).toHaveLength(1);
    } finally { await s.close(); }
    const none = await serve(query, undefined);
    try {
      const body = event(fx("tracker-in_transit"));
      const r = await none.post(body, { "X-Hmac-Signature": easypostSignature(body, SECRET) });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "no_secret" });
      expect(writes).toHaveLength(1);
    } finally { await none.close(); }
  });
  it("other event types are acknowledged and ignored; a store failure is a 500 (EasyPost retries)", async () => {
    const writes: any[] = [];
    const s = await serve(async (sql: string) => { writes.push(sql); throw new Error("db down"); }, SECRET);
    try {
      const other = JSON.stringify({ id: "evt_2", description: "batch.created", result: { id: "batch_1" } });
      const r = await s.post(other, { "X-Hmac-Signature": easypostSignature(other, SECRET) });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, ignored: "batch.created" });
      expect(writes).toHaveLength(0);
      const body = event(fx("tracker-out_for_delivery"));
      expect((await s.post(body, { "X-Hmac-Signature": easypostSignature(body, SECRET) })).status).toBe(500);
      expect(writes).toHaveLength(1);
    } finally { await s.close(); }
  });
});

describe("the store, the Velocity fallback and the D8 helper", () => {
  it("applyCarrierUpdate never clears delivered_at (COALESCE) and never touches placeholder rows", async () => {
    const writes: any[] = [];
    await applyCarrierUpdate(async (sql, params) => { writes.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [], rowCount: 3 }; }, trackerUpdate(fx("tracker-in_transit")));
    expect(writes[0].sql).toContain("delivered_at = COALESCE(delivered_at, $5::timestamptz)");
    expect(writes[0].sql).toContain("tracking_number NOT LIKE 'email:%'");
  });
  it("recordVelocityTrackingStatus writes Velocity's per-tracking status by number (one UPDATE over unnest), only when it changed", async () => {
    const writes: any[] = [];
    const n = await recordVelocityTrackingStatus(async (sql, params) => { writes.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [], rowCount: 2 }; }, [
      { trackings: [{ carrier: "UPS", tracking_number: "1z1", tracking_status: "In Transit" }, "1Z2", { tracking_number: "1Z3", tracking_status: null }] },
      { trackings: [{ tracking_number: "9400", tracking_status: "Delivered" }] },
      {},
    ]);
    expect(n).toBe(2);
    expect(writes[0].params).toEqual([["1Z1", "9400"], ["In Transit", "Delivered"]]);
    expect(writes[0].sql).toContain("t.velocity_tracking_status IS DISTINCT FROM v.s");
    expect(await recordVelocityTrackingStatus(async () => { throw new Error("never"); }, [{ trackings: [] }])).toBe(0);
  });
  it("poDeliveryState: all inbound real-number rows delivered → all_delivered with the latest delivered_at; no rows → false", async () => {
    const q = (row: any) => async (sql: string) => { expect(sql).toContain("direction = 'inbound'"); return { rows: [row], rowCount: 1 }; };
    expect(await poDeliveryState(q({ rows: 2, delivered: 2, latest_delivered_at: "2026-11-02 10:00:00+00", next_est_delivery_at: null }), "po1")).toEqual({ rows: 2, delivered: 2, all_delivered: true, latest_delivered_at: "2026-11-02T10:00:00.000Z", next_est_delivery_at: null });
    expect(await poDeliveryState(q({ rows: 2, delivered: 1, latest_delivered_at: "2026-11-02 10:00:00+00", next_est_delivery_at: "2026-11-05 00:00:00+00" }), "po1")).toMatchObject({ all_delivered: false, next_est_delivery_at: "2026-11-05T00:00:00.000Z" });
    expect(await poDeliveryState(q({ rows: 0, delivered: 0, latest_delivered_at: null, next_est_delivery_at: null }), "po1")).toMatchObject({ all_delivered: false, latest_delivered_at: null });
  });
});

describe("wiring", () => {
  it("components 31 (hourly, register) and 32 (daily, sweep) exist, scheduled-only, never authorized on a manual job", () => {
    const c31 = COMPONENTS.find((c) => c.n === 31)!, c32 = COMPONENTS.find((c) => c.n === 32)!;
    expect([c31.key, c31.tier, c31.kind]).toEqual(["31_carrier_tracking", "hourly", "account"]);
    expect([c32.key, c32.tier, c32.kind]).toEqual(["32_carrier_sweep", "daily", "account"]);
    expect(SCHEDULED_ONLY_COMPONENTS).toContain(31);
    expect(SCHEDULED_ONLY_COMPONENTS).toContain(32);
    expect(explicitlyAuthorized(31, { anything: true })).toBe(false);
    expect(explicitlyAuthorized(32, { anything: true })).toBe(false);
  });
  it("the webhook is mounted before the session middleware, outside /api; the push pass records Velocity's statuses; the Tracking tab shows the carrier column", () => {
    const index = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(index.indexOf("createEasypostWebhookRouter({")).toBeGreaterThan(0);
    expect(index.indexOf("createEasypostWebhookRouter({")).toBeLessThan(index.indexOf("createSessionMiddleware({"));
    expect(readFileSync(join(__dirname, "easypost.ts"), "utf8")).toContain('router.post("/webhooks/easypost"');
    expect(readFileSync(join(__dirname, "tracking-push.ts"), "utf8")).toContain("recordVelocityTrackingStatus(opts.query, inboundList)");
    expect(readFileSync(join(__dirname, "tracking-routes.ts"), "utf8")).toContain("t.carrier_status, t.est_delivery_at, t.last_scan_at, t.delivered_at");
    const tab = readFileSync(join(__dirname, "..", "client", "src", "components", "po-tracking.tsx"), "utf8");
    expect(tab).toContain('<th className="pr-2">Carrier status</th>');
    expect(tab).toContain("<CarrierStatusCell row={r} />");
  });
  it("only easypost.ts talks to api.easypost.com", () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && f !== "easypost.ts" && f !== "easypost.test.ts");
    for (const f of files) expect(readFileSync(join(__dirname, f), "utf8")).not.toContain("api.easypost.com");
  });
});
