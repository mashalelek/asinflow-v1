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
  const isBundle = String(o.sold_as ?? "").toLowerCase() === "bundle";
  if (isBundle && Array.isArray(o.bundle_children) && o.bundle_children.length > 0) {
    const nums = Array.from(new Set(
      o.bundle_children.map((c: any) => String(c?.order_number ?? "").trim()).filter((x) => x !== ""),
    ));
    if (nums.length > 0) return nums.map((orderNumber) => ({ orderNumber, asin }));
  }
  // §11 Part C.1 (2026-09-21): an UNIDENTIFIED bundle parent (no children to
  // derive from) gets a key unique to its own order_id — never ("", asin),
  // which collapsed every shipped bundle of one ASIN into a single union slot
  // (both B0GNHTYGPF parents → one, reporting quantity 2 instead of 20). The
  // synthetic form also cannot collide with any sheet key, which is correct:
  // an unhydrated parent must match no sheet group.
  if (isBundle) {
    const oid = String((o as any).order_id ?? "").trim();
    if (oid !== "") return [{ orderNumber: `__velocity_order_id:${oid}`, asin }];
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

// Create ONE bundle order — multipart/form-data POST /inbound with
// bulk=false (2026-09-03, decoded from a dashboard capture). JSON is NOT
// accepted on the single-order POST (docs-wrong #7: two JSON attempts 400'd
// "Quantity must be a valid number." with quantity present — their validator
// reads form fields only); dates go as YYYY-MM-DD (capture: 2026-09-02), not
// our sheet's M/D/YYYY. Every scalar is a string; blanks are EMPTY STRINGS
// PRESENT — including top-level order_number/retailer (parent-null contract)
// and unit_cost/list_price (cost privacy preserved as empty-not-omitted).
// bundle_items is a JSON.stringify'd array of FULL order-shaped children
// mirroring the capture verbatim. If the API rejects or drops per-child
// fields, callers STOP and report — no PUT improvisation.

// M/D/YYYY (sheet) → YYYY-MM-DD (capture contract). Fail-closed on garbage.
export function mdyToIso(mdy: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) throw new Error(`createBundleOrder: unparseable date ${JSON.stringify(mdy)} — expected M/D/YYYY`);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export async function createBundleOrder(rec: {
  asin: string; amazon_sku: string; item_name: string;
  units_per_pack: number; quantity: number; date: string;
  bundle_items: Array<{ item_name: string; quantity: number; order_number: string; retailer: string; date: string }>;
}): Promise<any> {
  const children = rec.bundle_items.map((c) => ({
    item_name: c.item_name,
    quantity: String(c.quantity),
    order_number: c.order_number,
    retailer: c.retailer,
    date: mdyToIso(c.date),
    asin: "",
    amazon_sku: "",
    size: "",
    brand_sku: "",
    color: "",
    unit_cost: "",
    list_price: "",
    client_notes: "",
    upc: "",
    fulfillment_type: "-- select an option --", // capture-verbatim child placeholder
    sold_as: "individual",
    units_per_pack: "",
    trackings: [],
    bundle_items: [],
    shipping_labels: [],
    transparency_files: [],
  }));

  const form = new FormData();
  const fields: Record<string, string> = {
    bulk: "false",
    date: mdyToIso(rec.date),
    retailer: "",          // parent-null contract — empty string PRESENT
    order_number: "",      // parent-null contract — empty string PRESENT
    item_name: rec.item_name,
    quantity: String(rec.quantity),
    asin: rec.asin,
    amazon_sku: rec.amazon_sku,
    fulfillment_type: "fba",
    sold_as: "bundle",
    units_per_pack: String(rec.units_per_pack),
    size: "",
    color: "",
    brand_sku: "",
    upc: "",
    client_notes: "",
    unit_cost: "",         // cost privacy — empty, never a value
    list_price: "",        // cost privacy — empty, never a value
    bundle_items: JSON.stringify(children),
    trackings: JSON.stringify([]),
    shipping_labels: JSON.stringify([]),
    transparency_files: JSON.stringify([]),
    tracking_numbers: JSON.stringify([]),
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const res = await velocityFetch("/inbound", { method: "POST", body: form });
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
  return orders.map((o: any) => {
    const isBundle = String(o.sold_as ?? "").toLowerCase() === "bundle";
    return {
      order_id: String(o.order_id ?? ""),
      order_number: String(o.order_number ?? ""),
      asin: String(o.asin ?? "").toUpperCase(),
      date: String(o.date ?? ""),
      sold_as: String(o.sold_as ?? ""),
      status: "shipped",
      item_name: o.item_name,
      // §11 Part C.1 (2026-09-21): for a BUNDLE the quantity is the parent's
      // `quantity` — the bundle TOTAL, constant across its shipment rows —
      // never `quantity_shipped`, which is the per-shipment part and made
      // c0835a42 (2+6+2+10) report 2 instead of 20. Flat orders keep
      // quantity_shipped (unchanged, never quantity-audited).
      quantity: isBundle
        ? (o.quantity != null ? Number(o.quantity) : undefined)
        : (o.quantity_shipped != null ? Number(o.quantity_shipped) : undefined),
      // Carried for the Part D unplaced fallback + the mapping UI.
      units_per_pack: o.units_per_pack,
      amazon_sku: o.amazon_sku,
      created_at: o.created_at,
      __shipment_id: shipmentId,
    };
  });
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
// Shipped-bundle identity gap (2026-09-02, SPEC §11): shipment details omit
// bundle_children (LIST endpoints alone serialize them — docs-wrong #6), so
// shipment-leg bundle pseudo-rows hydrate their children IN-BATCH by order_id
// from the inbound/inventory legs. A bundle visible only as a child-less
// shipment row (fully shipped) stays child-less and is surfaced via
// unidentifiedShippedBundles() — the plan suppresses its ASIN's creates.
// §11 Part C.1 (2026-09-21): a bundle that shipped in parts has one shipment
// row PER shipment, all carrying the same parent order_id (c0835a42: four
// rows across four shipments). Collapse them to ONE pseudo-order per parent
// before the union, keeping every shipment id for the mapping UI. Flat-order
// rows pass through untouched (one order can legitimately appear in several
// shipments and is never quantity-audited).
export function collapseBundleShipmentRows(rows: VelocityInboundOrder[]): VelocityInboundOrder[] {
  const out: VelocityInboundOrder[] = [];
  const byParent = new Map<string, VelocityInboundOrder>();
  for (const o of rows) {
    if (String(o.sold_as ?? "").toLowerCase() !== "bundle") { out.push(o); continue; }
    const oid = String((o as any).order_id ?? "").trim();
    if (oid === "") { out.push(o); continue; }
    const existing = byParent.get(oid);
    if (!existing) {
      const ids = [(o as any).__shipment_id].filter(Boolean);
      const row = { ...o, __shipment_ids: ids } as VelocityInboundOrder;
      byParent.set(oid, row);
      out.push(row);
      continue;
    }
    // Same parent seen again: accumulate shipment ids + shipped units. The
    // bundle total (quantity) is identical on every row, so it is NOT summed.
    const ids = ((existing as any).__shipment_ids ?? []) as string[];
    if ((o as any).__shipment_id) ids.push((o as any).__shipment_id);
    (existing as any).__shipment_ids = ids;
  }
  return out;
}

export function hydrateShipmentBundles(
  shipmentOrders: VelocityInboundOrder[],
  listOrders: VelocityInboundOrder[],
): VelocityInboundOrder[] {
  const childrenById = new Map<string, any[]>();
  for (const o of listOrders) {
    if (String(o.sold_as ?? "").toLowerCase() === "bundle" && Array.isArray(o.bundle_children) && o.bundle_children.length > 0) {
      childrenById.set(String(o.order_id), o.bundle_children);
    }
  }
  return shipmentOrders.map((o) => {
    if (String(o.sold_as ?? "").toLowerCase() !== "bundle") return o;
    if (Array.isArray(o.bundle_children) && o.bundle_children.length > 0) return o;
    const kids = childrenById.get(String(o.order_id));
    return kids ? { ...o, bundle_children: kids } : o;
  });
}

// Fully-shipped bundles whose child keys are unrecoverable — the fail-closed
// suppression input (SPEC §11 "Shipped-bundle identity gap").
export function unidentifiedShippedBundles(orders: KnownVelocityOrder[]): KnownVelocityOrder[] {
  return orders.filter((o) =>
    o.lifecycleSource === "shipment" &&
    String(o.sold_as ?? "").toLowerCase() === "bundle" &&
    !(Array.isArray(o.bundle_children) && o.bundle_children.length > 0),
  );
}

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
  const collapsed = collapseBundleShipmentRows(shipmentOrders);
  const hydrated = hydrateShipmentBundles(collapsed, [...inbound, ...inventory]);
  return unionKnownOrders(inbound, inventory, hydrated);
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
