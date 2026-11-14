// Carrier status — EasyPost (SPEC §26 "Carrier status — EasyPost"; claims patch §3.9 / §4.7, commit 4,
// Maria 2026-11-07 / 2026-11-11). AF reads tracking numbers from emails; EasyPost tracks them:
//   register   every inbound / return row on an OPEN PO (closed_at IS NULL — any age; a closed PO's rows are never
//              registered, Maria 2026-11-12) whose carrier EasyPost tracks (UPS, USPS, FedEx, DHL, Amazon) →
//              POST /v2/trackers {tracking_code, carrier, is_return}. Idempotent: a re-POST of the same code
//              returns the same tracker (recorded: tracker-in_transit-repost.json), and the id is stored on every
//              row carrying the number (split rows share one tracker). Hourly (component 31); a row already
//              delivered is never registered. GLS, OnTrac, LaserShip, OTHER: skipped with the reason (Velocity's
//              tracking_status is their fallback, recorded by the push pass).
//   webhook    POST /webhooks/easypost — public, no session; every event must carry EasyPost's HMAC-SHA256 signature
//              over the raw body (X-Hmac-Signature: hmac-sha256-hex=…, secret EASYPOST_WEBHOOK_SECRET); unsigned or
//              wrong → 401 and nothing stored. tracker.updated → the tracker's status, est_delivery_date, latest
//              scan, delivered_at.
//   sweep      daily (component 32): trackers silent for 3 days are re-read (GET /v2/trackers/:id) as a backstop
//              for a missed webhook; stops once delivered or 60 days after registration.
//   readers    carrier_status / est_delivery_at / last_scan_at / delivered_at per row on the PO's Tracking tab;
//              poDeliveryState() is the helper D8 (missing) and §3.1 (never_received) read in commit 5.
// Keys: EASYPOST_API_KEY (production; locally EASYPOST_TEST_API_KEY is the fallback — a test key only accepts
// EasyPost's EZ… test codes), EASYPOST_WEBHOOK_SECRET. Without a key the components skip with a note; nothing
// here ever calls EasyPost from a test (the suite uses the recorded responses under __fixtures__/easypost).
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { QueryLike } from "./scheduler/types";
import { EASYPOST_STATUSES, type EasypostStatus } from "@shared/carrier-status";
import { applyReturnTracker } from "./claim-returns";

const BASE_URL = "https://api.easypost.com/v2";
/** The sweep stops this long after registration (§3.9; Maria 2026-11-12: the rule is open POs, not shipment age). */
export const MAX_AGE_DAYS = 60;
/** The sweep re-reads a tracker AF has not heard about for this long. */
export const SILENT_DAYS = 3;
/** Trackers created per hourly pass at most: the backlog (227 on production, 2026-11-12) spreads over a few passes instead of one burst. */
export const REGISTER_CAP = 60;
/** Pause between POSTs — the first production pass fired 227 in 25 s and EasyPost rate-limited the account after 7. */
export const REGISTER_PAUSE_MS = 750;
/** Test seam. */
export const easypostDeps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

/**
 * AF carrier → the EasyPost carrier strings to try, in order (null = omit `carrier`, EasyPost auto-detects). A POST that
 * answers CREDENTIALS_NOT_FOUND or CARRIER_CODE_MISMATCH moves to the next option, and the option that worked is kept
 * for the rest of the pass. Absent = EasyPost does not track it for AF.
 *   FedEx: Maria's account has EasyPost's managed FedEx ("FedEx Wallet"), not her own FedEx account — `FedEx` is the
 *   user-owned account and answered CREDENTIALS_NOT_FOUND on every row (2026-11-12); `FedExDefault` is the managed one.
 *   DHL: AF's DHL rows are DHL eCommerce numbers as often as Express (one CARRIER_CODE_MISMATCH 2026-11-12) — auto-detect.
 */
export const EASYPOST_CARRIER_OPTIONS: Readonly<Record<string, ReadonlyArray<string | null>>> = {
  UPS: ["UPS"], USPS: ["USPS"], FEDEX: ["FedExDefault", null], DHL: [null, "DHLExpress"], AMAZON: ["AmazonMws", null],
};
/** The carriers EasyPost tracks for AF, with the first option each (the tests pin them). */
export const EASYPOST_CARRIERS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(EASYPOST_CARRIER_OPTIONS).map(([k, v]) => [k, v[0] ?? "auto"]));
export const easypostCarrier = (afCarrier: string): string | null => EASYPOST_CARRIERS[String(afCarrier ?? "").toUpperCase()] ?? null;
const RETRY_NEXT_OPTION = new Set(["CREDENTIALS_NOT_FOUND", "TRACKER.CARRIER_CODE_MISMATCH"]);

export function easypostKey(): string | null {
  return process.env.EASYPOST_API_KEY || process.env.EASYPOST_TEST_API_KEY || null;
}
export const easypostMode = (): "production" | "test" | "off" => (process.env.EASYPOST_API_KEY ? "production" : process.env.EASYPOST_TEST_API_KEY ? "test" : "off");

// ── The API ──────────────────────────────────────────────────────────────────
export interface EasypostTrackingDetail { datetime?: string | null; status?: string | null; message?: string | null }
export interface EasypostTracker {
  id: string; status: string; tracking_code: string; carrier?: string | null; is_return?: boolean | null;
  est_delivery_date?: string | null; tracking_details?: EasypostTrackingDetail[] | null; updated_at?: string | null;
}
export type EasypostFetch = (path: string, init: { method: "GET" | "POST"; body?: string }) => Promise<{ status: number; json: () => Promise<any> }>;

export class EasypostError extends Error {
  constructor(public status: number, public code: string | null, message: string) { super(message); }
}

/** The one HTTP wrapper: Basic auth with the key as the user name, JSON in and out; non-2xx → EasypostError with the API's code. */
export const realEasypostFetch: EasypostFetch = async (path, init) => {
  const key = easypostKey();
  if (!key) throw new EasypostError(0, "no_key", "EASYPOST_API_KEY not set");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "Content-Type": "application/json" },
    body: init.body,
  });
  return { status: res.status, json: () => res.json() };
};

async function call(fetchFn: EasypostFetch, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<any> {
  const res = await fetchFn(path, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (res.status < 200 || res.status >= 300) {
    throw new EasypostError(res.status, body?.error?.code ?? null, `EasyPost ${init.method} ${path} failed (HTTP ${res.status}${body?.error?.code ? `, ${body.error.code}` : ""}${body?.error?.message ? `: ${body.error.message}` : ""})`);
  }
  return body;
}

export const createTracker = (fetchFn: EasypostFetch, t: { tracking_code: string; carrier: string | null; is_return: boolean }): Promise<EasypostTracker> =>
  call(fetchFn, "/trackers", { method: "POST", body: JSON.stringify({ tracker: t.carrier ? t : { tracking_code: t.tracking_code, is_return: t.is_return } }) });
export const getTracker = (fetchFn: EasypostFetch, id: string): Promise<EasypostTracker> => call(fetchFn, `/trackers/${encodeURIComponent(id)}`, { method: "GET" });

// ── Pure: what a tracker says, in AF's columns ───────────────────────────────
export interface CarrierUpdate {
  easypost_tracker_id: string;
  tracking_code: string;
  carrier_status: EasypostStatus;
  est_delivery_at: string | null;
  last_scan_at: string | null;
  delivered_at: string | null;
  is_return: boolean;
}
const iso = (s: unknown): string | null => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** The columns a tracker maps to. delivered_at = the delivery scan's datetime (the latest scan when none says delivered). */
export function trackerUpdate(t: EasypostTracker): CarrierUpdate {
  const status = (EASYPOST_STATUSES as readonly string[]).includes(String(t.status)) ? (t.status as EasypostStatus) : "unknown";
  const scans = (t.tracking_details ?? []).map((d) => ({ at: iso(d.datetime), status: String(d.status ?? "") })).filter((d) => d.at);
  const last = scans.reduce<string | null>((m, d) => (m == null || d.at! > m ? d.at! : m), null);
  const deliveredScan = scans.filter((d) => d.status === "delivered").reduce<string | null>((m, d) => (m == null || d.at! > m ? d.at! : m), null);
  return {
    easypost_tracker_id: String(t.id), tracking_code: String(t.tracking_code ?? "").toUpperCase(), carrier_status: status,
    est_delivery_at: iso(t.est_delivery_date), last_scan_at: last,
    delivered_at: status === "delivered" ? deliveredScan ?? last ?? iso(t.updated_at) ?? new Date().toISOString() : null,
    is_return: Boolean(t.is_return),
  };
}

export interface TrackingCandidate { id: number; carrier: string; tracking_number: string; direction: string; delivered_at?: string | Date | null; easypost_tracker_id?: string | null; easypost_registered_at?: string | Date | null; carrier_checked_at?: string | Date | null }
export type TrackerAction = "register" | "sweep" | "skip:delivered" | "skip:too_old" | "skip:carrier" | "skip:fresh" | "skip:registered";
const days = (from: string | Date, to: Date): number => (to.getTime() - new Date(from).getTime()) / 86_400_000;

/** Pure: what the hourly / daily pass does with a row — the carrier gate, the delivered stop, the 60-days-after-registration stop, the 3-day silence. */
export function trackerAction(row: TrackingCandidate, now: Date, pass: "register" | "sweep"): TrackerAction {
  if (row.delivered_at) return "skip:delivered";
  if (!easypostCarrier(row.carrier)) return "skip:carrier";
  if (pass === "register") return row.easypost_tracker_id ? "skip:registered" : "register";
  if (!row.easypost_tracker_id) return "skip:registered";
  if (row.easypost_registered_at && days(row.easypost_registered_at, now) > MAX_AGE_DAYS) return "skip:too_old";
  return row.carrier_checked_at && days(row.carrier_checked_at, now) < SILENT_DAYS ? "skip:fresh" : "sweep";
}

// ── Store ────────────────────────────────────────────────────────────────────
/**
 * Every inbound row carrying the number (any PO, split rows) takes the tracker's state; the id is stored where it was missing.
 * A RETURN row (claims commit 7) reads only the scans after its label — with the tracker given, applyReturnTracker writes those
 * rows and moves the claim's Shipped / Delivered (claim-returns.ts); a return may share the inbound number (§3.9), so the
 * generic write never touches direction = 'return'.
 */
export async function applyCarrierUpdate(query: QueryLike, u: CarrierUpdate, tracker?: EasypostTracker): Promise<number> {
  const r = await query(
    `UPDATE po_tracking SET easypost_tracker_id = $1, carrier_status = $2, est_delivery_at = $3, last_scan_at = $4,
            delivered_at = COALESCE(delivered_at, $5::timestamptz), carrier_checked_at = NOW(), updated_at = NOW(),
            easypost_registered_at = COALESCE(easypost_registered_at, NOW())
      WHERE tracking_number NOT LIKE 'email:%' AND direction <> 'return'
        AND (easypost_tracker_id = $1 OR (easypost_tracker_id IS NULL AND upper(tracking_number) = $6))`,
    [u.easypost_tracker_id, u.carrier_status, u.est_delivery_at, u.last_scan_at, u.delivered_at, u.tracking_code],
  );
  let n = r.rowCount ?? 0;
  if (tracker) n += (await applyReturnTracker(query, tracker)).rows;
  return n;
}

/** Rows on OPEN POs only (closed_at IS NULL): a closed PO's rows are never registered or swept; unmatched queue rows have no PO. */
const CANDIDATES_SQL = `SELECT t.id, t.carrier, t.tracking_number, t.direction, t.delivered_at, t.easypost_tracker_id, t.easypost_registered_at, t.carrier_checked_at
                          FROM po_tracking t JOIN purchase_orders p ON p.id = t.po_id AND p.closed_at IS NULL
                         WHERE t.tracking_number NOT LIKE 'email:%' AND t.delivered_at IS NULL AND t.split_of IS NULL
                         ORDER BY COALESCE(t.shipped_at, t.created_at) DESC, t.id`;

export interface RegisterResult {
  registered: number; rows_updated: number; errors: number; skipped: Record<string, number>; outcomes: Record<string, string>;
  /** EasyPost answered 429: the pass stopped there; the rest waits for the next hour. */
  rate_limited: boolean;
  /** Carriers EasyPost refused on every option (CREDENTIALS_NOT_FOUND / CARRIER_CODE_MISMATCH) — skipped for the rest of the pass. */
  no_carrier_account: string[];
  /** The EasyPost carrier string that worked per AF carrier this pass ("auto" = omitted). */
  carrier_used: Record<string, string>;
}

/** Component 31: register every candidate row on an open PO (one tracker per distinct carrier + number), applying the POST's answer at once. */
export async function registerTrackers(query: QueryLike, now = new Date(), fetchFn: EasypostFetch = realEasypostFetch, cap = REGISTER_CAP): Promise<RegisterResult> {
  const r: RegisterResult = { registered: 0, rows_updated: 0, errors: 0, skipped: {}, outcomes: {}, rate_limited: false, no_carrier_account: [], carrier_used: {} };
  const rows = (await query(CANDIDATES_SQL)).rows as TrackingCandidate[];
  const seen = new Set<string>();
  const skip = (k: string) => { r.skipped[k] = (r.skipped[k] ?? 0) + 1; };
  /** Which option of EASYPOST_CARRIER_OPTIONS each AF carrier is on this pass (advances on a refused option). */
  const optionIndex: Record<string, number> = {};
  let calls = 0;
  for (const row of rows) {
    const a = trackerAction(row, now, "register");
    if (a !== "register") { skip(a.replace("skip:", "")); continue; }
    const key = `${row.carrier.toUpperCase()} ${row.tracking_number.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.rate_limited) { skip("rate_limited"); continue; }
    if (r.no_carrier_account.includes(row.carrier.toUpperCase())) { skip(`no_carrier_account_${row.carrier.toLowerCase()}`); continue; }
    if (calls >= cap) { skip("over_cap"); continue; }
    const af = row.carrier.toUpperCase();
    const options = EASYPOST_CARRIER_OPTIONS[af] ?? [];
    const tried: string[] = [];
    // The options in order; a refused option advances the carrier for the rest of the pass, so one probe per option per pass.
    for (let i = optionIndex[af] ?? 0; i < options.length; i++) {
      if (calls > 0) await easypostDeps.sleep(REGISTER_PAUSE_MS);
      calls++;
      const carrier = options[i];
      try {
        const t = await createTracker(fetchFn, { tracking_code: row.tracking_number, carrier, is_return: row.direction === "return" });
        const u = trackerUpdate(t);
        r.rows_updated += await applyCarrierUpdate(query, u, t);
        r.registered++;
        optionIndex[af] = i; r.carrier_used[af] = carrier ?? `auto (${t.carrier ?? "?"})`;
        r.outcomes[key] = `${u.easypost_tracker_id} ${u.carrier_status}${u.est_delivery_at ? ` eta ${u.est_delivery_at.slice(0, 10)}` : ""}${tried.length ? ` (as ${carrier ?? "auto"} after ${tried.join(", ")})` : ""}`;
        break;
      } catch (e: any) {
        const code = e instanceof EasypostError ? e.code : null;
        // 429: EasyPost rate-limited the account — stop here, the rest waits for the next pass (nothing is lost: unregistered rows stay candidates).
        if (e instanceof EasypostError && e.status === 429) { r.rate_limited = true; r.errors++; r.outcomes[key] = `error: ${e.message}`; break; }
        if (code && RETRY_NEXT_OPTION.has(code) && i + 1 < options.length) { tried.push(`${carrier ?? "auto"}: ${code}`); optionIndex[af] = i + 1; continue; }
        r.errors++;
        r.outcomes[key] = `error: ${e?.message ?? e}${tried.length ? ` (after ${tried.join("; ")})` : ""}`;
        // Every option refused: this carrier needs a carrier account on the EasyPost account — one error line, the carrier's other rows wait.
        if (code && RETRY_NEXT_OPTION.has(code)) r.no_carrier_account.push(af);
        break;
      }
    }
  }
  return r;
}

export interface SweepResult { checked: number; rows_updated: number; errors: number; skipped: Record<string, number>; outcomes: Record<string, string> }

/** Component 32: re-read every registered, undelivered tracker on an open PO AF has not heard about for SILENT_DAYS, until MAX_AGE_DAYS after registration. */
export async function sweepTrackers(query: QueryLike, now = new Date(), fetchFn: EasypostFetch = realEasypostFetch): Promise<SweepResult> {
  const r: SweepResult = { checked: 0, rows_updated: 0, errors: 0, skipped: {}, outcomes: {} };
  const rows = (await query(CANDIDATES_SQL)).rows as TrackingCandidate[];
  const seen = new Set<string>();
  for (const row of rows) {
    const a = trackerAction(row, now, "sweep");
    if (a !== "sweep") { r.skipped[a.replace("skip:", "")] = (r.skipped[a.replace("skip:", "")] ?? 0) + 1; continue; }
    const id = String(row.easypost_tracker_id);
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const t = await getTracker(fetchFn, id);
      const u = trackerUpdate(t);
      r.rows_updated += await applyCarrierUpdate(query, u, t);
      r.checked++;
      r.outcomes[`${row.carrier} ${row.tracking_number}`] = `${u.carrier_status}${u.last_scan_at ? ` last scan ${u.last_scan_at.slice(0, 10)}` : ""}`;
    } catch (e: any) {
      r.errors++;
      r.outcomes[`${row.carrier} ${row.tracking_number}`] = `error: ${e?.message ?? e}`;
    }
  }
  return r;
}

/** The push pass records Velocity's per-tracking status (the fallback the readers show when EasyPost has nothing). */
export async function recordVelocityTrackingStatus(query: QueryLike, orders: ReadonlyArray<{ trackings?: unknown }>): Promise<number> {
  const numbers: string[] = []; const statuses: string[] = [];
  for (const o of orders) {
    for (const t of Array.isArray(o.trackings) ? o.trackings : []) {
      if (!t || typeof t !== "object") continue;
      const n = String((t as any).tracking_number ?? "").trim().toUpperCase(); const s = String((t as any).tracking_status ?? "").trim();
      if (n && s) { numbers.push(n); statuses.push(s); }
    }
  }
  if (!numbers.length) return 0;
  const r = await query(
    `UPDATE po_tracking t SET velocity_tracking_status = v.s, updated_at = NOW()
       FROM unnest($1::text[], $2::text[]) AS v(n, s)
      WHERE upper(t.tracking_number) = v.n AND t.velocity_tracking_status IS DISTINCT FROM v.s`,
    [numbers, statuses],
  );
  return r.rowCount ?? 0;
}

// ── The helper D8 / §3.1 read (commit 5) ──────────────────────────────────────
export interface PoDeliveryState {
  /** Inbound, real-number rows on the PO (dismissed queue rows excluded). */
  rows: number;
  delivered: number;
  /** Every inbound row delivered (false when the PO has no tracking at all). */
  all_delivered: boolean;
  latest_delivered_at: string | null;
  /** The latest ETA among the undelivered rows, when EasyPost gave one. */
  next_est_delivery_at: string | null;
}
export async function poDeliveryState(query: QueryLike, poId: string): Promise<PoDeliveryState> {
  const r = (await query(
    `SELECT count(*)::int AS rows, count(delivered_at)::int AS delivered, max(delivered_at)::text AS latest_delivered_at,
            max(est_delivery_at) FILTER (WHERE delivered_at IS NULL)::text AS next_est_delivery_at
       FROM po_tracking WHERE po_id = $1 AND direction = 'inbound' AND tracking_number NOT LIKE 'email:%'`, [poId],
  )).rows[0] ?? { rows: 0, delivered: 0, latest_delivered_at: null, next_est_delivery_at: null };
  const rows = Number(r.rows ?? 0), delivered = Number(r.delivered ?? 0);
  return { rows, delivered, all_delivered: rows > 0 && delivered === rows, latest_delivered_at: r.latest_delivered_at ? new Date(r.latest_delivered_at).toISOString() : null, next_est_delivery_at: r.next_est_delivery_at ? new Date(r.next_est_delivery_at).toISOString() : null };
}

// ── Webhook ──────────────────────────────────────────────────────────────────
export const SIGNATURE_HEADER = "x-hmac-signature";
/** EasyPost signs the NFKD-normalised UTF-8 body with HMAC-SHA256 and sends `hmac-sha256-hex=<hex>`. */
export function easypostSignature(rawBody: Buffer | string, secret: string): string {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  return `hmac-sha256-hex=${createHmac("sha256", secret).update(Buffer.from(text.normalize("NFKD"), "utf8")).digest("hex")}`;
}
export function verifyEasypostSignature(rawBody: Buffer | string | undefined, header: string | undefined, secret: string | undefined): boolean {
  if (!rawBody || !header || !secret) return false;
  const expected = Buffer.from(easypostSignature(rawBody, secret));
  const got = Buffer.from(String(header).trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface WebhookDeps { query: QueryLike; secret?: () => string | undefined; log?: (m: string) => void }
/**
 * POST /webhooks/easypost — mounted BEFORE the session middleware (no /api prefix: requireAuth and the stale-page guard
 * never see it). 401 unless the signature verifies; then tracker.updated → applyCarrierUpdate; any other event is
 * acknowledged and ignored. Always 200 once verified, so EasyPost does not retry what AF has already read.
 */
export function createEasypostWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();
  const secret = deps.secret ?? (() => process.env.EASYPOST_WEBHOOK_SECRET);
  router.post("/webhooks/easypost", async (req: Request, res: Response) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    // "no_secret" vs "bad_signature": both 401, nothing stored — the word only says whether EASYPOST_WEBHOOK_SECRET is set on the server.
    if (!secret()) { res.status(401).json({ error: "no_secret" }); return; }
    if (!verifyEasypostSignature(raw, req.header(SIGNATURE_HEADER), secret())) { res.status(401).json({ error: "bad_signature" }); return; }
    const event = req.body ?? {};
    if (event.description !== "tracker.updated" || !event.result?.id) { res.json({ ok: true, ignored: event.description ?? null }); return; }
    try {
      const u = trackerUpdate(event.result as EasypostTracker);
      const rows = await applyCarrierUpdate(deps.query, u, event.result as EasypostTracker);
      deps.log?.(`easypost webhook: ${u.tracking_code} ${u.carrier_status} → ${rows} row(s)`);
      res.json({ ok: true, rows });
    } catch (e: any) {
      deps.log?.(`easypost webhook failed: ${e?.message ?? e}`);
      res.status(500).json({ error: "store_failed" });
    }
  });
  return router;
}
