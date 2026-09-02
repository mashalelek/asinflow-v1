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
  // Bundles (SPEC §11, 2026-08-31): parent rows carry order_number null and
  // nest their components here; each child is order-like with its own
  // order_number/retailer and a bundle_order_id pointing at the parent.
  bundle_children?: any[];
  [key: string]: any;
}

// Child-derived match key (SPEC §11 Bundles): a bundle's identity for dedup /
// reconciliation is bundle_children[].order_number × parent asin — the
// parent's own order_number is null by observation (manual B0GNHTYGPF).
// Non-bundles (and bundles with no usable child order numbers) fall back to
// the flat (order_number, asin) key.
export function matchKeysForOrder(
  o: Pick<VelocityInboundOrder, "order_number" | "asin" | "sold_as" | "bundle_children">,
): Array<{ orderNumber: string; asin: string }> {
  const asin = String(o.asin ?? "");
  if (String(o.sold_as ?? "").toLowerCase() === "bundle" && Array.isArray(o.bundle_children) && o.bundle_children.length > 0) {
    const nums = Array.from(new Set(
      o.bundle_children.map((c: any) => String(c?.order_number ?? "").trim()).filter((x) => x !== ""),
    ));
    if (nums.length > 0) return nums.map((orderNumber) => ({ orderNumber, asin }));
  }
  return [{ orderNumber: String(o.order_number ?? ""), asin }];
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
  // Tripwire (2026-09-02): the metadata field must exist and be finite — a
  // silent fallback here once meant single-page coverage would pass unnoticed.
  const total = body.data?.results?.total_results;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error(`Velocity /inbound metadata missing data.results.total_results — refusing partial coverage (got ${JSON.stringify(total)})`);
  }
  return {
    orders: body.data?.orders ?? [],
    totalResults: total,
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
  let reported = -1;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { orders, totalResults } = await listInboundOrders({ limit: PAGE, offset: page * PAGE });
    reported = totalResults;
    all.push(...orders);
    if (all.length >= totalResults || orders.length === 0) break;
  }
  // Fail-closed both ways (2026-09-02): fetched ≠ reported total → loud
  // failure. No plan or dedup ever runs on partial coverage.
  if (all.length !== reported) {
    throw new Error(`Velocity /inbound coverage incomplete: fetched ${all.length} of ${reported} — refusing to classify`);
  }
  return all;
}

// Create ONE bundle order — JSON POST /inbound (SPEC §11 Bundles,
// 2026-08-31). The bulk CSV cannot carry bundle_items, so bundles post one
// order per call. Top-level order_number/retailer are OMITTED (parent-null by
// observation); per-child order_number/retailer/date ride inside
// bundle_items. unit_cost/list_price are NEVER sent (cost privacy). If the
// API rejects or drops per-child fields, callers STOP and report — no PUT
// improvisation (first-write protocol).
export async function createBundleOrder(rec: {
  asin: string; amazon_sku: string; item_name: string;
  units_per_pack: number; quantity: number; date: string;
  bundle_items: Array<{ item_name: string; quantity: number; order_number: string; retailer: string; date: string }>;
}): Promise<any> {
  const body = {
    date: rec.date,
    item_name: rec.item_name,
    quantity: rec.quantity,
    asin: rec.asin,
    amazon_sku: rec.amazon_sku,
    fulfillment_type: "fba",
    sold_as: "bundle",
    units_per_pack: rec.units_per_pack,
    bundle_items: rec.bundle_items.map((c) => ({
      item_name: c.item_name,
      quantity: c.quantity,
      order_number: c.order_number,
      retailer: c.retailer,
      date: c.date,
    })),
  };
  const res = await velocityFetch("/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.data ?? null;
}

// Update a single order — PUT /inbound/:order_id. Field casing is MIXED per
// docs (verified 2026-07-30): amazonSKU/orderNumber/itemName are camelCase,
// but sold_as and units_per_pack stay snake_case; quantity/date as-is.
// Velocity's PUT is FULL-REPLACE in practice: the first live PUT
// (2026-07-30) sent only {quantity} and the API nulled the omitted date
// ("null value in column \"date\" ... not-null constraint"). Callers must
// therefore echo the order's current values alongside the changed fields
// (see routes execute). fulfilledBy is deliberately not in the allowed set —
// never PUT it (immutable once shipped; we never change fulfillment channel
// from AF). cogs/listPrice are also excluded: cost privacy — pricing never
// leaves AF (they are null on our orders anyway).
// fulfilledBy note: with full-replace PUTs, omitting it nulls the NOT NULL
// fulfillment_type column — so it must be ECHOED with the order's current
// value. The rail's intent survives as: never SET fulfilledBy to a different
// value than the order already has (the audit is quantity-only, so no diff
// can ever carry it; routes echo current.fulfillment_type verbatim).
const PUT_ALLOWED_FIELDS = new Set([
  "quantity", "date", "sold_as", "units_per_pack", "amazonSKU",
  "retailer", "orderNumber", "itemName", "asin", "fulfilledBy",
  "trackingNumbers",
]);
export async function updateInboundOrder(orderId: string, fields: Record<string, any>): Promise<any> {
  const body: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!PUT_ALLOWED_FIELDS.has(k)) throw new Error(`updateInboundOrder: field ${JSON.stringify(k)} not in the allowed update set`);
    body[k] = v;
  }
  if (Object.keys(body).length === 0) throw new Error("updateInboundOrder: no fields to update");
  const res = await velocityFetch(`/inbound/${encodeURIComponent(orderId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.data ?? null;
}

// ── Complete-coverage order fetch (dedup blind-spot fix, diagnosed 2026-08-07) ──
//
// GET /inbound serves ONLY active inbound orders (all 51 probed rows were
// status "inbound"; status params are silently ignored). Orders that moved on
// live elsewhere: checked-in stock in GET /inventory (carries order_number/
// order_id/asin; statuses observed: "inventory", "inbound"), fully-shipped
// orders ONLY in GET /shipments/:id detail (orders[] carries order_number).
// The dedup/reconciliation match set must cover ALL of them — a completed
// order classified as CREATE would duplicate on send (near-miss: orders
// 129059664 + 100878, both already checked in/shipped, appeared as CREATEs).

export type OrderLifecycleSource = "inbound" | "inventory" | "shipment";

export interface KnownVelocityOrder extends VelocityInboundOrder {
  // Which endpoint this record came from. Precedence in the union:
  // inbound > inventory > shipment (richest, actionable-first). Shipment-
  // derived rows are pseudo-orders: status "shipped", quantity =
  // quantity_shipped (DIFFERENT semantics — never quantity-audit them).
  lifecycleSource: OrderLifecycleSource;
}

async function fetchAllInventoryOrders(): Promise<VelocityInboundOrder[]> {
  const PAGE = 200;
  const MAX_PAGES = 50;
  const all: VelocityInboundOrder[] = [];
  let reported = -1;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await velocityFetch(`/inventory?limit=${PAGE}&offset=${page * PAGE}`);
    const orders: VelocityInboundOrder[] = body.data?.orders ?? [];
    const total = body.data?.results?.total_results;
    // Tripwire (2026-09-02): no silent fallback — missing metadata throws.
    if (typeof total !== "number" || !Number.isFinite(total)) {
      throw new Error(`Velocity /inventory metadata missing data.results.total_results — refusing partial coverage (got ${JSON.stringify(total)})`);
    }
    reported = total;
    all.push(...orders);
    if (all.length >= total || orders.length === 0) break;
  }
  if (all.length !== reported) {
    throw new Error(`Velocity /inventory coverage incomplete: fetched ${all.length} of ${reported} — refusing to classify`);
  }
  return all;
}

// Fail-closed parser: a shipment detail without a well-formed orders array is
// AMBIGUOUS coverage — throw so the caller refuses to classify CREATEs,
// rather than silently shrinking the match set (the exact failure mode this
// module exists to prevent).
export function shipmentOrdersFrom(detailData: any, shipmentId: string): VelocityInboundOrder[] {
  const orders = detailData?.orders;
  if (!Array.isArray(orders)) {
    throw new Error(`Velocity shipment ${shipmentId}: detail response has no orders array — coverage ambiguous, refusing to classify`);
  }
  return orders.map((o: any) => ({
    order_id: String(o.order_id ?? ""),
    order_number: String(o.order_number ?? ""),
    asin: String(o.asin ?? "").toUpperCase(),
    date: String(o.date ?? ""),
    sold_as: String(o.sold_as ?? ""),
    status: "shipped",
    item_name: o.item_name,
    quantity: o.quantity_shipped != null ? Number(o.quantity_shipped) : undefined,
  }));
}

// Pure union by (order_number, asin), first-source-wins with the precedence
// inbound > inventory > shipment. Exported for tests.
export function unionKnownOrders(
  inbound: VelocityInboundOrder[],
  inventory: VelocityInboundOrder[],
  shipmentOrders: VelocityInboundOrder[],
): KnownVelocityOrder[] {
  const seen = new Set<string>();
  const out: KnownVelocityOrder[] = [];
  const add = (rows: VelocityInboundOrder[], source: OrderLifecycleSource) => {
    for (const o of rows) {
      // CHILD-DERIVED keys (2026-09-02): bundle parents carry order_number
      // null, so the old flat key collided every same-ASIN bundle on
      // ("", ASIN) and silently dropped all but the first — the 8/30
      // B0GNHTYGPF phantom-CREATE incident. An order is a cross-leg duplicate
      // only when ALL its derived keys are already seen.
      const keys = matchKeysForOrder(o).map(
        (k) => `${k.orderNumber.trim()}\u0000${k.asin.trim().toUpperCase()}`,
      );
      if (keys.every((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      out.push({ ...o, lifecycleSource: source });
    }
  };
  add(inbound, "inbound");
  add(inventory, "inventory");
  add(shipmentOrders, "shipment");
  return out;
}

// The complete match set: /inbound + /inventory + every /shipments/:id
// detail. FAIL-CLOSED: any leg throwing propagates — callers (the reconcile
// plan) must refuse to classify CREATEs on a partial set, never risk a
// duplicate. ~29 GETs at current volume; velocityFetch's 429-retry paces it.
export async function fetchAllKnownOrders(): Promise<KnownVelocityOrder[]> {
  const inbound = await fetchAllInboundOrders();
  const inventory = await fetchAllInventoryOrders();
  const shipList = await velocityFetch(`/shipments?limit=-1`);
  const shipments: any[] = shipList.data?.shipments ?? shipList.data ?? [];
  const shipmentOrders: VelocityInboundOrder[] = [];
  for (const sh of shipments) {
    const sid = String(sh.shipment_id ?? sh.id ?? "");
    if (!sid) throw new Error("Velocity /shipments row without shipment_id — coverage ambiguous, refusing to classify");
    const det = await velocityFetch(`/shipments/${encodeURIComponent(sid)}`);
    shipmentOrders.push(...shipmentOrdersFrom(det.data, sid));
  }
  return unionKnownOrders(inbound, inventory, shipmentOrders);
}

// Submit the bulk CSV — the exact serializeVelocityCsv output, unmodified.
// Returns the response `data` (order_id per docs; shape not further relied on
// — bulk mode has been observed returning an empty array).
export async function submitBulkCsv(csv: string): Promise<any> {
  const form = new FormData();
  form.append("bulk", "true");
  form.append("file", new Blob([csv], { type: "text/csv" }), "velocity-upload.csv");
  const body = await velocityFetch("/inbound", { method: "POST", body: form });
  return body.data ?? null;
}
