// Aura cost sync — AF DB → Aura, one-directional. See SPEC §11 "Aura cost sync".
//
// THIS FILE IS DRY-RUN ONLY for now: it reads Aura (GET) + AF DB (read-only) and
// computes a diff. It does NOT POST to Aura and writes nothing to AF's DB.
//
// Express-free (imports ./db + axios, never ./index) so it runs from a script
// without booting the server.

import axios from "axios";
import { query as defaultQuery } from "./db";

const AURA_BASE = "https://api.goaura.com";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type AuraGet = (endpoint: string, params?: Record<string, any>) => Promise<any>;

// ── Aura client (local to this module for now) ───────────────────────────────

function auraAuth(): { username: string; password: string } {
  const key = process.env.AURA_API_KEY;
  if (!key) {
    throw new Error(
      "AURA_API_KEY is not set — Aura cost sync requires it (HTTP Basic: API key as username, empty password).",
    );
  }
  return { username: key, password: "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry on 429 (respect Retry-After, else exponential backoff). Any other error
// propagates (e.g. a rejected `limit` param → caller's fallback).
const realAuraGet: AuraGet = async (endpoint, params) => {
  let backoff = 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await axios.get(`${AURA_BASE}${endpoint}`, { auth: auraAuth(), params, timeout: 30000 });
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 429 && attempt < 5) {
        const retryAfter = Number(err?.response?.headers?.["retry-after"]);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff);
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Aura GET exhausted 429 retries");
};

export interface AuraListing {
  id: string;
  sku: string;
  status: string;
  repricing: boolean;
  cost: number | null;      // integer cents, or null
  currency: string;         // e.g. "usd" — REQUIRED alongside cost on write
  platform: string;
  current_price: number | null;
}

// Stripe-style pagination: loop on starting_after=<last id> until has_more=false.
// Tries limit=100 to cut call count; falls back to default page size if the API
// rejects the param. Returns amazon-platform listings only (filtered after
// pagination so the cursor is never skewed).
export async function listAllListings(get: AuraGet = realAuraGet): Promise<AuraListing[]> {
  const all: AuraListing[] = [];
  let startingAfter: string | undefined;
  let useLimit = true;

  while (true) {
    const params: Record<string, any> = {};
    if (useLimit) params.limit = 100;
    if (startingAfter) { params.starting_after = startingAfter; await sleep(350); } // gentle pacing between pages

    let data: any;
    try {
      data = await get("/listings", params);
    } catch (err: any) {
      if (useLimit) { useLimit = false; continue; } // limit param rejected → retry without it
      throw err;
    }

    const batch: AuraListing[] = data?.data ?? [];
    all.push(...batch);
    if (!data?.has_more || batch.length === 0) break;
    startingAfter = batch[batch.length - 1].id;
  }

  return all.filter((l) => l.platform === "amazon");
}

// ── Cost resolution (single read-only query, keyed by SKU) ───────────────────

interface CostResolution {
  asins: string[];              // distinct ASINs this SKU maps to (>1 ⇒ ambiguous)
  actual_cogs: number | null;
  prep_override: number | null;
}

export async function resolveCostsBySku(skus: string[], q: QueryLike = defaultQuery as any): Promise<Map<string, CostResolution>> {
  const map = new Map<string, CostResolution>();
  if (skus.length === 0) return map;
  const { rows } = await q(
    `SELECT s.sku, a.asin, e.actual_cogs, e.prep_override
       FROM asin_skus s
       JOIN asins a ON a.id = s.asin_id
       LEFT JOIN asin_estimates e ON e.asin = a.asin
      WHERE s.sku = ANY($1::text[])`,
    [skus],
  );
  for (const r of rows) {
    const num = (v: any) => (v == null ? null : Number(v));
    const cur = map.get(r.sku);
    if (!cur) {
      map.set(r.sku, { asins: [r.asin], actual_cogs: num(r.actual_cogs), prep_override: num(r.prep_override) });
    } else if (!cur.asins.includes(r.asin)) {
      cur.asins.push(r.asin); // same SKU → another ASIN ⇒ ambiguous
    }
  }
  return map;
}

// ── Dry-run diff ─────────────────────────────────────────────────────────────

export type Verdict = "PUSH" | "UNCHANGED" | "SKIP:unmapped_sku" | "SKIP:ambiguous_sku" | "SKIP:null_cogs" | "SKIP:zero_cost";

export interface DryRunRow {
  id: string;                    // Aura listing id (for POST /listings/:id)
  currency: string;              // required alongside cost on the write
  sku: string;
  asin: string | null;
  auraStatus: string;
  repricing: boolean;
  currentAuraCost: number | null; // cents
  computedCost: number | null;    // cents
  verdict: Verdict;
  noPoPrep: boolean;              // prep_override was NULL → treated as $0
}

export interface DryRunSummary {
  totalListings: number;
  perVerdict: Record<Verdict, number>;
  perStatus: Record<string, number>;
  noPoPrepCount: number;
}

export async function buildAuraDryRun(
  deps: { get?: AuraGet; query?: QueryLike; asinFilter?: Set<string> } = {},
): Promise<{ rows: DryRunRow[]; summary: DryRunSummary; notInAura?: string[] }> {
  const listings = await listAllListings(deps.get ?? realAuraGet);
  const skus = Array.from(new Set(listings.map((l) => l.sku).filter(Boolean)));
  const resolved = await resolveCostsBySku(skus, deps.query ?? (defaultQuery as any));

  const allRows: DryRunRow[] = listings.map((l) => {
    const base = { id: l.id, currency: l.currency, sku: l.sku, auraStatus: l.status, repricing: !!l.repricing, currentAuraCost: l.cost ?? null };
    const r = resolved.get(l.sku);

    if (!r) return { ...base, asin: null, computedCost: null, verdict: "SKIP:unmapped_sku", noPoPrep: false };
    if (r.asins.length > 1) return { ...base, asin: r.asins.join(","), computedCost: null, verdict: "SKIP:ambiguous_sku", noPoPrep: false };

    const asin = r.asins[0];
    if (r.actual_cogs == null) return { ...base, asin, computedCost: null, verdict: "SKIP:null_cogs", noPoPrep: false };

    const noPoPrep = r.prep_override == null;
    const prep = r.prep_override ?? 0;
    const computedCost = Math.round((r.actual_cogs + prep) * 100); // integer cents
    // Fail-closed: Aura rejects cost=0, and a zero computed cost signals dirty
    // AF data (zero COGS), not a real cost — never POST it.
    if (computedCost <= 0) return { ...base, asin, computedCost, verdict: "SKIP:zero_cost", noPoPrep };
    const verdict: Verdict = l.cost === computedCost ? "UNCHANGED" : "PUSH";
    return { ...base, asin, computedCost, verdict, noPoPrep };
  });

  // Selection filter — applied AFTER SKU→ASIN mapping: keep only listings that
  // resolve to a filtered ASIN. Everything else is ignored entirely (NOT counted
  // as skipped). Enumeration above still walked ALL Aura listings (there is no
  // per-SKU Aura query). notInAura = filtered ASINs no Aura listing resolved to.
  let rows = allRows;
  let notInAura: string[] | undefined;
  if (deps.asinFilter) {
    const filter = deps.asinFilter;
    const asinsOf = (row: DryRunRow) => (row.asin == null ? [] : row.asin.split(",")); // ambiguous = "A,B"
    rows = allRows.filter((row) => asinsOf(row).some((a) => filter.has(a)));
    const matched = new Set<string>();
    for (const row of allRows) for (const a of asinsOf(row)) if (filter.has(a)) matched.add(a);
    notInAura = Array.from(filter).filter((a) => !matched.has(a));
  }

  const perVerdict: Record<Verdict, number> = {
    PUSH: 0, UNCHANGED: 0, "SKIP:unmapped_sku": 0, "SKIP:ambiguous_sku": 0, "SKIP:null_cogs": 0, "SKIP:zero_cost": 0,
  };
  const perStatus: Record<string, number> = {};
  let noPoPrepCount = 0;
  for (const row of rows) {
    perVerdict[row.verdict]++;
    perStatus[row.auraStatus] = (perStatus[row.auraStatus] ?? 0) + 1;
    if (row.noPoPrep) noPoPrepCount++;
  }

  return { rows, summary: { totalListings: rows.length, perVerdict, perStatus, noPoPrepCount }, notInAura };
}

// Cents → "$X.XX" (or "—" for null), for the dry-run table.
export const fmtCost = (cents: number | null): string => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);

// ── Live push ────────────────────────────────────────────────────────────────
//
// Aura update: params are FORM/QUERY params (a JSON body is silently ignored →
// documented no-op 2xx), and `currency` is REQUIRED alongside `cost`. We set
// ONLY currency + cost — never minimum_price / maximum_price / strategy /
// repricing / manual_price. The POST response IS the updated listing object, so
// we verify response.cost === sent cents (a 2xx whose cost didn't change is a
// FAILURE, not a success).
//
// Primary variant: query params, no body. If that 4xx's, retry once as a
// form-urlencoded body (Aura's docs are ambiguous between the two). One 429
// retry per attempt; network error / non-2xx recorded, batch never aborts.

async function postVariant(
  kind: "query" | "form", id: string, cost: number, currency: string,
): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: any;
    try {
      if (kind === "query") {
        res = await axios.post(`${AURA_BASE}/listings/${id}`, undefined, {
          auth: auraAuth(), params: { currency, cost }, timeout: 30000, validateStatus: () => true,
        });
      } else {
        const body = new URLSearchParams({ currency: String(currency), cost: String(cost) }).toString();
        res = await axios.post(`${AURA_BASE}/listings/${id}`, body, {
          auth: auraAuth(), headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 30000, validateStatus: () => true,
        });
      }
    } catch (err: any) {
      return { status: 0, body: err?.message ?? "network error (no HTTP response)" };
    }
    if (res.status === 429 && attempt === 0) {
      const ra = Number(res.headers?.["retry-after"]);
      await sleep(ra > 0 ? ra * 1000 : 1500);
      continue;
    }
    return { status: res.status, body: res.data };
  }
  return { status: 429, body: "429 after single retry" };
}

// Returns the final attempt's result + which variant produced it.
async function auraPostCost(
  id: string, cost: number, currency: string,
): Promise<{ status: number; body: any; variant: "query" | "form" }> {
  const q = await postVariant("query", id, cost, currency);
  if (q.status >= 200 && q.status < 300) return { ...q, variant: "query" };
  if (q.status >= 400 && q.status < 500) {
    const f = await postVariant("form", id, cost, currency); // fallback once
    return { ...f, variant: "form" };
  }
  return { ...q, variant: "query" };
}

export interface PushFailure {
  id: string; sku: string; asin: string | null; sentCost: number;
  status: number; variant: "query" | "form"; respCost: number | null; body: any;
}
export interface PushReadback { id: string; sku: string; sent: number; stored: number | string | null; match: boolean; }
export interface PushResult {
  attempted: number; pushed: number; failed: number;
  skipped: number;   // non-PUSH verdicts (SKIP:* + UNCHANGED)
  remaining: number; // PUSH rows beyond --limit, not attempted this run
  variantsUsed: Record<string, number>; // which write variant succeeded
  dryRunSummary: DryRunSummary;         // per-verdict / per-status breakdown
  notInAura?: string[];                 // (filtered runs only) selected ASINs no Aura listing matched
  failures: PushFailure[];
  readback: PushReadback[]; // belt-and-suspenders list re-fetch of ≤5 pushed
}

// Push computed costs for PUSH-verdict rows only. `limit` caps attempts.
// Sequential with 250ms spacing. Persistence is verified from the POST response
// object per row; a final list re-fetch of ≤5 SKUs is a belt-and-suspenders check.
export async function pushAuraCosts(
  opts: { limit: number | "all"; get?: AuraGet; query?: QueryLike; asinFilter?: Set<string> },
): Promise<PushResult> {
  const get = opts.get ?? realAuraGet;
  const { rows, summary: dryRunSummary, notInAura } = await buildAuraDryRun({ get, query: opts.query, asinFilter: opts.asinFilter });

  const pushRows = rows.filter((r) => r.verdict === "PUSH");
  const skipped = rows.length - pushRows.length; // SKIP:* + UNCHANGED
  const toPush = opts.limit === "all" ? pushRows : pushRows.slice(0, opts.limit);
  const remaining = pushRows.length - toPush.length;

  const failures: PushFailure[] = [];
  const pushedRows: DryRunRow[] = [];
  const variantsUsed: Record<string, number> = {};

  for (let i = 0; i < toPush.length; i++) {
    const r = toPush[i];
    if (i > 0) await sleep(250);
    const { status, body, variant } = await auraPostCost(r.id, r.computedCost!, r.currency);
    // The response IS the updated listing. Persisted only if response.cost matches.
    const respCost = (body && typeof body === "object") ? ((body.cost ?? body?.data?.cost) ?? null) : null;
    const ok = status >= 200 && status < 300 && respCost === r.computedCost;
    if (ok) {
      pushedRows.push(r);
      variantsUsed[variant] = (variantsUsed[variant] ?? 0) + 1;
    } else {
      failures.push({ id: r.id, sku: r.sku, asin: r.asin, sentCost: r.computedCost!, status, variant, respCost, body });
    }
  }

  // Belt-and-suspenders: one list re-fetch, compare ≤5 pushed SKUs' stored cost.
  const readback: PushReadback[] = [];
  if (pushedRows.length > 0) {
    const all = await listAllListings(get);
    const byId = new Map(all.map((l) => [l.id, l]));
    for (const r of pushedRows.slice(0, 5)) {
      const l = byId.get(r.id);
      const stored = l ? (l.cost ?? null) : "NOT IN LIST";
      readback.push({ id: r.id, sku: r.sku, sent: r.computedCost!, stored, match: typeof stored === "number" && stored === r.computedCost });
    }
  }

  return { attempted: toPush.length, pushed: pushedRows.length, failed: failures.length, skipped, remaining, variantsUsed, dryRunSummary, notInAura, failures, readback };
}
