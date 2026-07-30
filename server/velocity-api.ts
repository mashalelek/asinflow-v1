// Velocity prep-service API client (phase 2 delivery — SPEC §11 "Velocity API
// delivery"). Docs: https://docs.velocityprepservices.com/
//
// Read side: listInboundOrders / fetchAllInboundOrders — the dedup source of
// truth (Velocity-as-truth, no local gatekeeper ledger).
// Write side: submitBulkCsv — POST /inbound multipart with bulk=true and the
// EXACT serializeVelocityCsv output attached as `file`. The per-order
// form-data path is deliberately NOT built: its required color/brand_sku/
// unit_cost/list_price fields are blank in our records; the CSV parser
// tolerates blanks, per-order validation is an unknown we don't need.

const BASE_URL = "https://api.velocityprepservices.com/api/v1";

// Minimal shape of an inbound order — only the fields we read. The API returns
// many more (fnsku, amazon_sku, quantities, search_tsv, ...); keep them via the
// index signature without depending on them.
export interface VelocityInboundOrder {
  order_id: string;
  order_number: string; // as-entered string, may be alphanumeric ("MW7400517")
  asin: string;         // uppercase
  date: string;         // zero-padded MM/DD/YYYY (Velocity normalizes on ingest
                        // — ours are unpadded M/D/YYYY; parse, never string-compare)
  sold_as: string;      // "individual" | "multi-pack" | "bundle"
  status: string;       // e.g. "inbound"
  item_name?: string;
  quantity?: number;
  [key: string]: any;
}

function getCreds(): { key: string; warehouseId: string } {
  const key = process.env.VELOCITY_API_KEY;
  const warehouseId = process.env.VELOCITY_WAREHOUSE_ID;
  if (!key) throw new Error("VELOCITY_API_KEY not set — add it to .env (Velocity dashboard → API keys)");
  if (!warehouseId) throw new Error("VELOCITY_WAREHOUSE_ID not set — add it to .env (GET /warehouses; warehouse 1 as of 2026-07)");
  return { key, warehouseId };
}

// Shared request wrapper. Failure contract (SPEC): any non-2xx OR body
// status !== "success" throws, with the API's `errors` array verbatim in the
// message. On 429: back off once (Retry-After if present, else 5s) and retry;
// a second 429 fails like any other error.
async function velocityFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const { key, warehouseId } = getCreds();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `ApiKey ${key}`,
      "X-Warehouse-Id": warehouseId,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 429 && attempt === 0) {
    const retryAfterS = Number(res.headers.get("retry-after")) || 5;
    await new Promise((r) => setTimeout(r, retryAfterS * 1000));
    return velocityFetch(path, init, 1);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON body — surfaced below via status */ }
  if (!res.ok || body?.status !== "success") {
    const errs = body?.errors != null ? ` | errors: ${JSON.stringify(body.errors)}` : "";
    const msg = body?.message ? ` | message: ${body.message}` : "";
    throw new Error(
      `Velocity ${init.method ?? "GET"} ${path} failed (HTTP ${res.status}, status=${body?.status ?? "non-JSON"})${msg}${errs}`,
    );
  }
  return body;
}

export interface ListInboundResult {
  orders: VelocityInboundOrder[];
  totalResults: number;
}

export async function listInboundOrders(
  opts: { limit?: number; offset?: number; sortKey?: string; sortOrder?: "asc" | "desc" } = {},
): Promise<ListInboundResult> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 200));
  params.set("offset", String(opts.offset ?? 0));
  if (opts.sortKey) params.set("sort_key", opts.sortKey);
  if (opts.sortOrder) params.set("sort_order", opts.sortOrder);
  const body = await velocityFetch(`/inbound?${params.toString()}`);
  return {
    orders: body.data?.orders ?? [],
    totalResults: body.data?.results?.total_results ?? 0,
  };
}

// Page through ALL inbound orders (limit=200 per page until total_results is
// covered). 44 orders as of 2026-07-30 — if this ever gets slow, revisit with
// a date filter (SPEC). Hard page cap guards against a pathological/looping
// pagination bug ever hammering the API.
export async function fetchAllInboundOrders(): Promise<VelocityInboundOrder[]> {
  const PAGE = 200;
  const MAX_PAGES = 50; // 10k orders — far beyond plausible volume
  const all: VelocityInboundOrder[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { orders, totalResults } = await listInboundOrders({ limit: PAGE, offset: page * PAGE });
    all.push(...orders);
    if (all.length >= totalResults || orders.length === 0) return all;
  }
  throw new Error(`Velocity pagination did not converge after ${MAX_PAGES} pages — aborting`);
}

// Submit the bulk CSV — the exact serializeVelocityCsv output, unmodified.
// Returns the response `data` (order_id per docs; shape not further relied on).
export async function submitBulkCsv(csv: string): Promise<any> {
  const form = new FormData();
  form.append("bulk", "true");
  form.append("file", new Blob([csv], { type: "text/csv" }), "velocity-upload.csv");
  const body = await velocityFetch("/inbound", { method: "POST", body: form });
  return body.data ?? null;
}
