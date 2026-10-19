// Per-SKU FBA buckets (listing hygiene, SPEC §11 component 15 / §14).
// Owner of `sku_fba_inventory`: component 15 only — syncInventory writes it
// when the component asks (`recordSkuBuckets`), never from the Sync Inventory
// button or any other caller.
//
// getInventorySummaries with details=true already returns every bucket per
// sellerSku (spike 2026-10-18, 2,277 rows / 46 pages). The table is written
// only after a COMPLETE paginated pull — syncInventory fetches every page
// before writing anything, and a failed page throws, so an incomplete pull
// writes nothing here. A SKU AF knows that is absent from a complete pull is
// written all-zero with observed_at = now: absence from a complete pull is
// conclusive.
import type { QueryLike } from "./scheduler/types";

export interface SkuBuckets {
  sku: string;
  asin: string;
  fnsku: string | null;
  fulfillable: number;
  inbound_working: number;
  inbound_shipped: number;
  inbound_receiving: number;
  reserved_customer: number;
  reserved_fc_transfer: number;
  reserved_fc_processing: number;
  unfulfillable: number;
  researching: number;
  future_supply: number;
}

export const BUCKET_FIELDS = [
  "fulfillable", "inbound_working", "inbound_shipped", "inbound_receiving",
  "reserved_customer", "reserved_fc_transfer", "reserved_fc_processing",
  "unfulfillable", "researching", "future_supply",
] as const;
export type BucketField = (typeof BUCKET_FIELDS)[number];

const int = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};

/** Pure: one getInventorySummaries row → its buckets; null when it carries no sellerSku. */
export function parseSkuBuckets(item: any): SkuBuckets | null {
  const sku = String(item?.sellerSku ?? "").trim();
  if (!sku) return null;
  const d = item?.inventoryDetails ?? {};
  const r = d.reservedQuantity ?? {};
  const fs = d.futureSupplyQuantity ?? {};
  return {
    sku,
    asin: String(item?.asin ?? "").trim().toUpperCase(),
    fnsku: item?.fnSku ? String(item.fnSku) : null,
    fulfillable: int(d.fulfillableQuantity),
    inbound_working: int(d.inboundWorkingQuantity),
    inbound_shipped: int(d.inboundShippedQuantity),
    inbound_receiving: int(d.inboundReceivingQuantity),
    reserved_customer: int(r.pendingCustomerOrderQuantity),
    reserved_fc_transfer: int(r.pendingTransshipmentQuantity),
    reserved_fc_processing: int(r.fcProcessingQuantity),
    unfulfillable: int(d.unfulfillableQuantity?.totalUnfulfillableQuantity),
    researching: int(d.researchingQuantity?.totalResearchingQuantity),
    // Pre-order supply is treated as Available (blocks close); expected 0.
    future_supply: int(fs.reservedFutureSupplyQuantity) + int(fs.futureSupplyBuyableQuantity),
  };
}

export const anyBucketNonzero = (b: Pick<SkuBuckets, BucketField>): boolean => BUCKET_FIELDS.some((f) => b[f] > 0);

/**
 * Pure: the rows to upsert for one complete pull — every observed SKU
 * (duplicates summed), plus an all-zero row for each known SKU the pull did
 * not name.
 */
export function planSkuInventoryRows(
  observed: SkuBuckets[],
  known: { sku: string; asin: string }[],
): { rows: SkuBuckets[]; zeroFilled: number } {
  const by = new Map<string, SkuBuckets>();
  for (const b of observed) {
    const prev = by.get(b.sku);
    if (!prev) { by.set(b.sku, { ...b }); continue; }
    for (const f of BUCKET_FIELDS) prev[f] += b[f];
  }
  let zeroFilled = 0;
  for (const k of known) {
    if (by.has(k.sku)) continue;
    by.set(k.sku, {
      sku: k.sku, asin: k.asin, fnsku: null,
      fulfillable: 0, inbound_working: 0, inbound_shipped: 0, inbound_receiving: 0,
      reserved_customer: 0, reserved_fc_transfer: 0, reserved_fc_processing: 0,
      unfulfillable: 0, researching: 0, future_supply: 0,
    });
    zeroFilled++;
  }
  return { rows: Array.from(by.values()), zeroFilled };
}

/** Write one complete pull. Returns how many rows were written and zero-filled. */
export async function writeSkuFbaInventory(
  observed: SkuBuckets[],
  jobId: number | null,
  query: QueryLike,
): Promise<{ rows: number; zeroFilled: number }> {
  const known = (await query(
    `SELECT s.sku, a.asin FROM asin_skus s JOIN asins a ON a.id = s.asin_id
     UNION
     SELECT sku, asin FROM sku_fba_inventory`,
  )).rows.map((r: any) => ({ sku: String(r.sku), asin: String(r.asin) }));
  const { rows, zeroFilled } = planSkuInventoryRows(observed, known);
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000);
    const c = <K extends keyof SkuBuckets>(k: K) => part.map((r) => r[k]);
    await query(
      `INSERT INTO sku_fba_inventory AS t (sku, asin, fnsku, fulfillable, inbound_working, inbound_shipped, inbound_receiving,
              reserved_customer, reserved_fc_transfer, reserved_fc_processing, unfulfillable, researching, future_supply,
              last_nonzero_at, observed_at, job_id)
       SELECT u.sku, u.asin, u.fnsku, u.f, u.iw, u.isd, u.ir, u.rc, u.rt, u.rp, u.uf, u.rs, u.fs,
              CASE WHEN u.f + u.iw + u.isd + u.ir + u.rc + u.rt + u.rp + u.uf + u.rs + u.fs > 0 THEN NOW() END,
              NOW(), $14::bigint
         FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[],
                     $10::int[], $11::int[], $12::int[], $13::int[])
              AS u(sku, asin, fnsku, f, iw, isd, ir, rc, rt, rp, uf, rs, fs)
       ON CONFLICT (sku) DO UPDATE SET
         asin = EXCLUDED.asin, fnsku = COALESCE(EXCLUDED.fnsku, t.fnsku),
         fulfillable = EXCLUDED.fulfillable, inbound_working = EXCLUDED.inbound_working,
         inbound_shipped = EXCLUDED.inbound_shipped, inbound_receiving = EXCLUDED.inbound_receiving,
         reserved_customer = EXCLUDED.reserved_customer, reserved_fc_transfer = EXCLUDED.reserved_fc_transfer,
         reserved_fc_processing = EXCLUDED.reserved_fc_processing, unfulfillable = EXCLUDED.unfulfillable,
         researching = EXCLUDED.researching, future_supply = EXCLUDED.future_supply,
         last_nonzero_at = COALESCE(EXCLUDED.last_nonzero_at, t.last_nonzero_at),
         observed_at = EXCLUDED.observed_at, job_id = EXCLUDED.job_id`,
      [c("sku"), c("asin"), c("fnsku"), c("fulfillable"), c("inbound_working"), c("inbound_shipped"), c("inbound_receiving"),
       c("reserved_customer"), c("reserved_fc_transfer"), c("reserved_fc_processing"), c("unfulfillable"), c("researching"),
       c("future_supply"), jobId],
    );
  }
  return { rows: rows.length, zeroFilled };
}
