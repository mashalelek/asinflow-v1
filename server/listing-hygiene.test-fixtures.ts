// Shared fakes for the listing-hygiene tests (not a test file itself).
import { BUCKET_FIELDS } from "./sku-fba-inventory";
import { hygieneDeps } from "./listing-hygiene-run";
import type { SkuFacts } from "./listing-hygiene";
import type { ComponentContext, JobRow } from "./scheduler/types";

export const PASS = new Date("2026-10-19T13:00:00Z");
const zero = () => Object.fromEntries(BUCKET_FIELDS.map((f) => [f, 0])) as any;
export function facts(p: Partial<SkuFacts> = {}, inv: Record<string, number> = {}): SkuFacts {
  return {
    sku: "ABC-DEF-001", asin: "B000000001", asins: ["B000000001"],
    listing: { checkedAt: new Date("2026-10-19T13:20:00Z"), createdAt: new Date("2026-03-01T00:00:00Z"), offerEndAt: null },
    inventory: { ...zero(), ...inv, observedAt: new Date("2026-10-19T13:05:00Z"), lastNonzeroAt: null },
    pendingSubmission: false, actionPending: false, ledgerLastStocked: null,
    pipeline: { on_order: 0, at_prep: 0 }, velocityOnHand: 0, ...p,
  };
}

interface World {
  run15?: { error: string | null; finished_at: Date; started_at: Date } | null;
  run16?: { error: string | null; finished_at: Date; started_at: Date } | null;
  rows: any[];
  breaker?: number;
  held?: any[];
  /** Dead ASINs whose SKUs have an SC listing (hygiene scope, 2026-10-24). */
  deadWithListing?: string[];
}
export function fakeQuery(w: World) {
  const inserts: any[][] = [];
  const updates: any[][] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("FROM refresh_runs")) {
      const r = params?.[0] === "15_inventory" ? w.run15 : params?.[0] === "16_live_offer" ? w.run16 : null;
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (sql.includes("a.status = 'dead'")) return { rows: (w.deadWithListing ?? []).map((asin) => ({ asin })), rowCount: (w.deadWithListing ?? []).length };
    if (sql.includes("FROM asin_skus s JOIN asins a")) {
      // loadSkuFacts by ASIN: only the rows of the ASINs asked for (the scope).
      const rows = sql.includes("a.asin = ANY") ? w.rows.filter((r) => (params?.[0] ?? []).includes(r.asin)) : w.rows;
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM settings WHERE key")) return { rows: w.breaker == null ? [] : [{ value: w.breaker }], rowCount: 1 };
    if (sql.includes("INSERT INTO listing_actions")) { inserts.push(params!); return { rows: [], rowCount: 1 }; }
    if (sql.includes("FROM listing_actions") && sql.includes("status = 'held'")) return { rows: w.held ?? [], rowCount: (w.held ?? []).length };
    if (sql.includes("UPDATE listing_actions")) { updates.push(params!); return { rows: [], rowCount: 1 }; }
    if (sql.includes("po_asins")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { query, inserts, updates };
}
export function dbRow(sku: string, inv: Record<string, number> = {}, listing: Partial<{ created: string | null; end: string | null; checked: string }> = {}) {
  return {
    asin: "B000000001", sku,
    listing_created_at: listing.created === undefined ? "2026-03-01T00:00:00Z" : listing.created,
    offer_end_at: listing.end ?? null, listing_checked_at: listing.checked ?? "2026-10-19T13:20:00Z",
    ...zero(), ...inv, observed_at: "2026-10-19T13:05:00Z", last_nonzero_at: null, has_inventory: true,
    last_stocked_date: null, newest_submission: "live", action_pending: false,
  };
}
export const okRun = { error: null, started_at: PASS, finished_at: new Date("2026-10-19T13:40:00Z") };
export function fakeSc(listing: Record<string, { end: string | null } | "404">, inventory: Record<string, Record<string, number>> = {}) {
  const patches: any[] = [];
  const deletes: string[] = [];
  let velocityCalls = 0;
  hygieneDeps.sc = {
    get: async (endpoint: string, params?: any) => {
      if (endpoint.startsWith("/fba/inventory")) {
        const skus = String(params.sellerSkus).split(",");
        return { payload: { inventorySummaries: skus.filter((s) => inventory[s]).map((s) => ({ asin: "B000000001", sellerSku: s, inventoryDetails: { fulfillableQuantity: inventory[s].fulfillable ?? 0 } })) } };
      }
      const sku = decodeURIComponent(endpoint.split("/").pop()!);
      const st = listing[sku] ?? { end: null };
      if (st === "404") { const e: any = new Error("404"); e.response = { status: 404 }; throw e; }
      return {
        summaries: [{ marketplaceId: "ATVPDKIKX0DER", productType: "PRODUCT_X", createdDate: "2026-03-01T00:00:00Z", status: ["DISCOVERABLE"] }],
        attributes: { purchasable_offer: [{ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD", end_at: { value: st.end } }] },
      };
    },
    patch: async (endpoint: string, body: any) => { patches.push({ endpoint, body }); return { status: "ACCEPTED", submissionId: `sub-${patches.length}` }; },
    del: async (endpoint: string) => { deletes.push(endpoint); return { status: "ACCEPTED", submissionId: `del-${deletes.length}` }; },
    velocity: async () => { velocityCalls++; return []; },
  };
  return { patches, deletes, velocity: () => velocityCalls };
}
export function ctxOf(query: any, params: any = null, trigger: JobRow["trigger"] = "scheduled"): ComponentContext {
  return {
    job: { id: 42, trigger, params } as any, query, log: () => {}, sellerId: "SELLER", asins: [], scopeAsins: ["B000000001"],
    checkpoint: async () => {}, setProgress: async () => {}, cache: new Map(),
  } as unknown as ComponentContext;
}
