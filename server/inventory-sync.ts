import { spApiGet } from "./spapi";
import { query } from "./db";
import { log } from "./index";

const MARKETPLACE_ID = "ATVPDKIKX0DER";

interface SkuData {
  sku: string;
  fulfillable: number; // used to pick the "active" SKU
  seenOrder: number;   // later = more recent
}

interface AsinAgg {
  asinId: string;
  available_fba: number;
  reserved: number;
  inbound_shipped: number;
  inbound_receiving: number;
  skuData: SkuData[];
}


export async function syncInventory(
  asinFilter?: ReadonlySet<string>,
): Promise<{ synced: number; skipped: number; primaryBootstrapped: number }> {
  let primaryBootstrapped = 0;
  // Build a map from asin VARCHAR → asins.id UUID for active ASINs.
  // When asinFilter is supplied, restrict to that subset — the SP-API call
  // itself is paginated/global, so the filter applies to which rows we
  // accept into the map and therefore write to the DB.
  const sql = asinFilter && asinFilter.size > 0
    // Explicit selection: exactly those ASINs, archived included (SPEC 14).
    ? `SELECT id, asin FROM asins WHERE asin = ANY($1::text[])`
    : `SELECT id, asin FROM asins WHERE status IN ('active', 'parked')`; // cron scope: decision 5, 2026-09-07
  const params = asinFilter && asinFilter.size > 0 ? [Array.from(asinFilter)] : undefined;
  const asinRows = await query(sql, params);
  const asinIdMap = new Map<string, string>();
  for (const row of asinRows.rows) {
    asinIdMap.set(row.asin, row.id);
  }

  // Aggregate all SKUs per ASIN across all pages
  const asinAgg = new Map<string, AsinAgg>();
  let skipped = 0;
  let skuSeenCounter = 0;
  let nextToken: string | undefined;

  do {
    const params: Record<string, any> = {
      details: "true",
      granularityType: "Marketplace",
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,
    };
    if (nextToken) params.nextToken = nextToken;

    const data = await spApiGet("/fba/inventory/v1/summaries", params);
    const summaries: any[] = data?.payload?.inventorySummaries ?? [];
    nextToken = data?.pagination?.nextToken;

    for (const item of summaries) {
      const asin: string = item.asin;
      const asinId = asinIdMap.get(asin);
      if (!asinId) {
        skipped++;
        continue;
      }

      const details = item.inventoryDetails ?? {};
      const available_fba = details.fulfillableQuantity ?? 0;
      const reserved = details.reservedQuantity?.totalReservedQuantity ?? 0;
      const inbound_shipped = details.inboundShippedQuantity ?? 0;
      const inbound_receiving =
        (details.inboundReceivingQuantity ?? 0) + (details.inboundWorkingQuantity ?? 0);
      const sku: string = item.sellerSku ?? "";

      const existing = asinAgg.get(asin);
      if (existing) {
        existing.available_fba += available_fba;
        existing.reserved += reserved;
        existing.inbound_shipped += inbound_shipped;
        existing.inbound_receiving += inbound_receiving;
        if (sku && !existing.skuData.some((s) => s.sku === sku)) {
          existing.skuData.push({ sku, fulfillable: available_fba, seenOrder: skuSeenCounter++ });
        }
      } else {
        asinAgg.set(asin, {
          asinId,
          available_fba,
          reserved,
          inbound_shipped,
          inbound_receiving,
          skuData: sku ? [{ sku, fulfillable: available_fba, seenOrder: skuSeenCounter++ }] : [],
        });
      }
    }

    if (nextToken) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  } while (nextToken);

  // Now insert one aggregated snapshot per ASIN
  let synced = 0;
  for (const [asin, agg] of Array.from(asinAgg.entries())) {
    // Get ordered_qty from asin_estimates
    const estRow = await query(`SELECT ordered_qty FROM asin_estimates WHERE asin = $1`, [asin]);
    const ordered_qty = estRow.rows[0]?.ordered_qty != null
      ? parseInt(estRow.rows[0].ordered_qty) || 0
      : 0;

    await query(
      `INSERT INTO inventory_snapshots (asin_id, available_fba, reserved, inbound_shipped, inbound_receiving, ordered_qty, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [agg.asinId, agg.available_fba, agg.reserved, agg.inbound_shipped, agg.inbound_receiving, ordered_qty]
    );

    // Pick primary SKU: exclude amzn.gr.* SKUs, prefer highest inventory, then most recently seen
    const isAmznGr = (sku: string) => sku.toLowerCase().startsWith("amzn.gr.");
    const realSkus = agg.skuData.filter((s) => !isAmznGr(s.sku));
    const sorted = (realSkus.length > 0 ? realSkus : agg.skuData)
      .sort((a, b) => b.fulfillable - a.fulfillable || b.seenOrder - a.seenOrder);
    const primarySku = sorted[0]?.sku ?? null;

    // Primary ownership: the live-offer SKU (set by the Add-Offer path) is
    // authoritative. inventory-sync's fulfillable-count pick is BOOTSTRAP-ONLY —
    // it may set primary_sku / is_primary only when the ASIN has no primary at
    // all. If a primary already exists (primary_sku set OR any is_primary row),
    // do NOT recompute or demote — leave both fields untouched.
    const primaryCheck = await query(
      `SELECT (a.primary_sku IS NOT NULL
               OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary = TRUE)) AS has_primary
       FROM asins a WHERE a.id = $1`,
      [agg.asinId]
    );
    const hasPrimary = primaryCheck.rows[0]?.has_primary === true;

    // primary_sku only on bootstrap. (in_catalog retired 2026-10-15,
    // migration 052 — nothing read it.)
    if (!hasPrimary && primarySku) {
      await query(`UPDATE asins SET primary_sku = $2 WHERE id = $1`, [agg.asinId, primarySku]);
      primaryBootstrapped++;
    }

    // Store all SKUs in asin_skus. On bootstrap, set is_primary by the
    // heuristic (never amzn.gr.*). When a primary already exists, still track
    // newly-seen SKUs (as non-primary) but never overwrite existing is_primary.
    for (const sd of agg.skuData) {
      if (hasPrimary) {
        await query(
          `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, FALSE)
           ON CONFLICT (asin_id, sku) DO NOTHING`,
          [agg.asinId, sd.sku]
        );
      } else {
        const isPrimary = sd.sku === primarySku && !isAmznGr(sd.sku);
        await query(
          `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, $3)
           ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
          [agg.asinId, sd.sku, isPrimary]
        );
      }
    }

    synced++;
  }

  log(`Inventory sync complete: ${synced} ASINs synced (aggregated from ${Array.from(asinAgg.values()).reduce((s, a) => s + a.skuData.length, 0)} SKUs), ${skipped} skipped`, "inventory-sync");

  // Fold in the live-offer check AFTER inventory writes: this run may have
  // created/left ASINs with has_live_offer IS NULL (new SKUs) or a stale FALSE
  // (offer created after the last check — nothing else rechecks a FALSE).
  // The live-offer rider was REMOVED 2026-09-06 (SPEC §11 Refresh job):
  // the Refresh `listings` stage reconciles ALL flag states including TRUE,
  // subsuming the notLiveOnly re-probe entirely.
  return { synced, skipped, primaryBootstrapped };
}
