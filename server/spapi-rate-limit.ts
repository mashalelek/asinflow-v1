// Per-operation token-bucket pacing for SP-API calls.
//
// Amazon meters every SP-API operation with a token bucket: tokens refill at
// a fixed rate up to a burst cap, each call spends one, an empty bucket
// answers 429 QuotaExceeded. Before this module, callers sent requests at
// whatever concurrency they liked and treated the resulting 429s as generic
// errors to retry with guessed delays — the price refresh fired ~3.3 rps
// into a 1 rps bucket and spent hours in backoff. This module is the single
// choke point that makes 429s rare by construction: every request is queued
// per operation and released only when a token is available.
//
// Design (SPEC §11 "SP-API rate limiting"):
//   - One bucket per OPERATION, keyed by matching the request path against
//     the table below. Rates are Amazon's published defaults (post-2022
//     throttling adjustments). Unknown paths pass through unpaced but are
//     logged once so the table can be extended.
//   - FIFO release within a bucket: a request waits for the next token, so
//     bursts are honored and steady state is exactly the published rate.
//   - Self-correcting: the `x-amzn-RateLimit-Limit` response header, when
//     present, overrides the table's rate for that bucket (Amazon's own
//     recommendation). A 429 empties the bucket and the request is retried
//     transparently up to MAX_429_RETRIES times, each after a full refill
//     interval with a growing penalty — never a fixed 2s/4s/8s guess.
//   - Every request carries a timeout (set in spapi-auth.ts) so one hung
//     socket can never freeze a multi-hour job (the old client had none).
//
// Deliberately dependency-free (no server/index.ts import) so any module can
// use it without pulling in Express boot — same constraint as spapi-auth.ts.

export interface BucketSpec {
  /** Token refill rate, requests per second. */
  rate: number;
  /** Bucket capacity (Amazon's "burst"). */
  burst: number;
}

/** Path patterns → published limits. First match wins; order matters. */
const OPERATION_TABLE: { key: string; test: RegExp; spec: BucketSpec }[] = [
  // Product Pricing v0
  // 0.10 → 0.09 (2026-09-07): the first full run absorbed 6 throttles in 116
  // calls — an over-optimistic clock. ~1 min slower per full run, 0 throttled
  // by construction.
  { key: "pricing.itemOffersBatch", test: /^\/batches\/products\/pricing\/v0\/itemOffers$/, spec: { rate: 0.09, burst: 1 } },
  { key: "pricing.listingOffersBatch", test: /^\/batches\/products\/pricing\/v0\/listingOffers$/, spec: { rate: 0.5, burst: 1 } },
  { key: "pricing.itemOffers", test: /^\/products\/pricing\/v0\/items\/[^/]+\/offers$/, spec: { rate: 1, burst: 2 } },
  { key: "pricing.listingOffers", test: /^\/products\/pricing\/v0\/listings\/[^/]+\/offers$/, spec: { rate: 1, burst: 2 } },
  { key: "pricing.competitivePrice", test: /^\/products\/pricing\/v0\/competitivePrice$/, spec: { rate: 0.5, burst: 1 } },
  { key: "pricing.price", test: /^\/products\/pricing\/v0\/price$/, spec: { rate: 0.5, burst: 1 } },
  // Product Fees v0
  { key: "fees.estimateForAsin", test: /^\/products\/fees\/v0\/items\/[^/]+\/feesEstimate$/, spec: { rate: 1, burst: 2 } },
  { key: "fees.estimateBatch", test: /^\/products\/fees\/v0\/feesEstimate$/, spec: { rate: 0.5, burst: 1 } },
  // Catalog Items 2022-04-01
  { key: "catalog.getItem", test: /^\/catalog\/2022-04-01\/items\/[^/]+$/, spec: { rate: 2, burst: 2 } },
  { key: "catalog.search", test: /^\/catalog\/2022-04-01\/items$/, spec: { rate: 2, burst: 2 } },
  // Listings 2021-08-01
  { key: "listings.restrictions", test: /^\/listings\/2021-08-01\/restrictions$/, spec: { rate: 5, burst: 10 } },
  { key: "listings.items", test: /^\/listings\/2021-08-01\/items\/[^/]+(\/[^/]+)?$/, spec: { rate: 5, burst: 10 } },
  // FBA Inventory v1
  { key: "inventory.summaries", test: /^\/fba\/inventory\/v1\/summaries$/, spec: { rate: 2, burst: 2 } },
  // FBA Inbound Eligibility v1
  { key: "eligibility.preview", test: /^\/fba\/inbound\/v1\/eligibility\/itemPreview$/, spec: { rate: 1, burst: 1 } },
  // Reports 2021-06-30
  { key: "reports.getDocument", test: /^\/reports\/2021-06-30\/documents\/[^/]+$/, spec: { rate: 0.0167, burst: 15 } },
  { key: "reports.getReport", test: /^\/reports\/2021-06-30\/reports\/[^/]+$/, spec: { rate: 2, burst: 15 } },
  { key: "reports.createReport", test: /^\/reports\/2021-06-30\/reports$/, spec: { rate: 0.0167, burst: 15 } },
];

const MAX_429_RETRIES = 3;
/** Extra headroom so a burst never lands a hair early on Amazon's clock. */
const SAFETY_FACTOR = 0.95;

interface Bucket {
  key: string;
  rate: number;
  /** The table-seeded rate (× SAFETY_FACTOR) — the ceiling for header adjustment. */
  seededRate: number;
  burst: number;
  tokens: number;
  lastRefill: number;
  /** Serializes dispatch so waiters are released FIFO. */
  chain: Promise<void>;
  /** Consecutive 429s seen; resets on a clean response. */
  penalty: number;
  /** Diagnostics for the run report / logs. */
  stats: { sent: number; throttled: number; adjusted: boolean };
}

const buckets = new Map<string, Bucket>();
const warnedUnknown = new Set<string>();

function slog(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [sp-api-limit] ${msg}`);
}

/** Strip query string and any host prefix so matching works on the path. */
export function operationKeyFor(path: string): string | null {
  const p = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  for (const op of OPERATION_TABLE) if (op.test.test(p)) return op.key;
  return null;
}

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    const spec = OPERATION_TABLE.find((o) => o.key === key)!.spec;
    b = {
      key,
      rate: spec.rate * SAFETY_FACTOR,
      seededRate: spec.rate * SAFETY_FACTOR,
      burst: spec.burst,
      tokens: spec.burst,
      lastRefill: Date.now(),
      chain: Promise.resolve(),
      penalty: 0,
      stats: { sent: 0, throttled: 0, adjusted: false },
    };
    buckets.set(key, b);
  }
  return b;
}

function refill(b: Bucket, now: number) {
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(b.burst, b.tokens + elapsed * b.rate);
    b.lastRefill = now;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait (FIFO) until this bucket can spend one token, then spend it. */
async function acquire(b: Bucket): Promise<void> {
  const turn = b.chain.then(async () => {
    refill(b, Date.now());
    if (b.tokens < 1) {
      const waitMs = Math.ceil(((1 - b.tokens) / b.rate) * 1000);
      await sleep(waitMs);
      refill(b, Date.now());
    }
    b.tokens -= 1;
  });
  // Keep the chain alive even if a waiter is rejected upstream.
  b.chain = turn.catch(() => {});
  return turn;
}

/** Apply Amazon's advertised limit for this operation when it differs. */
function applyHeaderLimit(b: Bucket, headers: Record<string, any> | undefined) {
  const raw = headers?.["x-amzn-ratelimit-limit"];
  const advertised = raw != null ? parseFloat(String(raw)) : NaN;
  if (!isFinite(advertised) || advertised <= 0) return;
  // Downward-only (2026-09-07): the header may only SLOW a bucket, never
  // raise it above its seeded rate. itemOffersBatch is seeded 0.09 exactly
  // because Amazon's advertised 0.1 (→ 0.095 after safety factor) draws
  // steady-state 429s — the first post-seed full run still took 4 of them
  // after one header response re-raised the rate to 0.095.
  const target = Math.min(advertised * SAFETY_FACTOR, b.seededRate);
  if (Math.abs(target - b.rate) / b.rate > 0.01) {
    slog(`${b.key}: rate adjusted ${b.rate.toFixed(4)} → ${target.toFixed(4)} rps (x-amzn-RateLimit-Limit=${advertised})`);
    b.rate = target;
    b.stats.adjusted = true;
  }
}

export function isThrottleError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429) return true;
  const code = err?.response?.data?.errors?.[0]?.code;
  return typeof code === "string" && /QuotaExceeded/i.test(code);
}

/**
 * Run `send` under the bucket for `path`. `send` must perform exactly one
 * HTTP request and return the axios-style response (we read `.headers`).
 * 429s are retried here, transparently, so callers see either a response
 * or a non-throttle error (or the final 429 after MAX_429_RETRIES).
 */
export async function withRateLimit<T extends { headers?: any }>(
  path: string,
  send: () => Promise<T>,
): Promise<T> {
  const key = operationKeyFor(path);
  if (!key) {
    const p = path.split("?")[0];
    if (!warnedUnknown.has(p)) {
      warnedUnknown.add(p);
      slog(`no rate table entry for ${p} — sending unpaced (add it to OPERATION_TABLE)`);
    }
    return send();
  }
  const b = getBucket(key);

  for (let attempt = 0; ; attempt++) {
    await acquire(b);
    try {
      const res = await send();
      b.stats.sent++;
      b.penalty = 0;
      applyHeaderLimit(b, res?.headers);
      return res;
    } catch (err: any) {
      if (!isThrottleError(err)) throw err;
      b.stats.throttled++;
      b.penalty++;
      // Amazon's bucket is empty; ours was optimistic. Drain and wait a full
      // refill interval (× a penalty that grows with consecutive 429s).
      b.tokens = 0;
      b.lastRefill = Date.now();
      applyHeaderLimit(b, err?.response?.headers);
      if (attempt >= MAX_429_RETRIES) throw err;
      const waitMs = Math.ceil((1000 / b.rate) * Math.min(b.penalty, 4));
      slog(`${b.key}: 429 (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}) — pausing ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

/** Snapshot of per-bucket counters, for run reports and diagnostics. */
export function rateLimitStats(): Record<string, { rate: number; sent: number; throttled: number; adjusted: boolean }> {
  const out: Record<string, any> = {};
  for (const b of Array.from(buckets.values())) out[b.key] = { rate: b.rate, ...b.stats };
  return out;
}

/** Per-run view (2026-09-07): counters are process-lifetime, so job reports
 * snapshot at run start and report the DELTA — "0 throttled" then means
 * this run, not history. Buckets untouched during the run are omitted. */
export function rateLimitStatsSince(
  baseline: ReturnType<typeof rateLimitStats>,
): ReturnType<typeof rateLimitStats> {
  const now = rateLimitStats();
  const out: Record<string, any> = {};
  for (const [key, s] of Object.entries(now)) {
    const b = baseline[key];
    const sent = s.sent - (b?.sent ?? 0);
    const throttled = s.throttled - (b?.throttled ?? 0);
    if (sent > 0 || throttled > 0) out[key] = { rate: s.rate, sent, throttled, adjusted: s.adjusted };
  }
  return out;
}

/** Test hook: forget all buckets (fresh limits, fresh counters). */
export function _resetRateLimitsForTests() {
  buckets.clear();
  warnedUnknown.clear();
}
