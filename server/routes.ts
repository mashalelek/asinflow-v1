import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { getPricing, getFees, getCatalogData, estimateFeeFallback, getEligibility, type EligibilityResult } from "./spapi";
import { log } from "./index";
import { type AsinInput, type AsinResult, type ColumnMapping, extractDomain } from "@shared/schema";
import pool, { query, isDbAvailable } from "./db";
import { syncInventory } from "./inventory-sync";
import { syncSalesData } from "./sales-sync";
import { syncSuppressionData } from "./suppression-sync";
import { fetchSheetData } from "./google-sheets";
import { refreshPrices } from "./price-sync";
import fs from "fs";

const TAG_COLORS = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16"];

function cleanBuyLink(raw: string): string | null {
  const first = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!first) return null;
  const qIdx = first.indexOf("?");
  return qIdx >= 0 ? first.substring(0, qIdx) : first;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function parseFileToRawRows(buffer: Buffer, filename: string): { headers: string[]; rows: Record<string, any>[] } {
  const ext = filename.toLowerCase().split(".").pop();
  let rows: Record<string, any>[] = [];

  if (ext === "csv") {
    const text = buffer.toString("utf-8");
    const result = Papa.parse(text, { header: true, skipEmptyLines: true });
    rows = result.data as Record<string, any>[];
  } else if (ext === "xlsx" || ext === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet);
  } else {
    throw new Error("Unsupported file format. Please upload a .csv or .xlsx file.");
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

const COLUMN_NAME_ALIASES: Record<string, string[]> = {
  asin: ["asin"],
  cogs: ["cogs", "cost", "cost of goods", "unit cost", "purchase price", "price paid", "buy cost"],
  buyLink: ["buy link", "buylink", "buy url", "buyurl", "link", "url", "supplier link", "source link", "source url"],
  prepCost: ["prep", "prep cost", "prepcost", "prep fee", "prepfee"],
  additionalFees: ["storage", "storage fee", "storagefee", "additional fees", "additionalfees", "additional fee", "extra fees", "misc", "misc fees", "other fees"],
  tags: ["tags", "tag"],
  notes: ["notes", "note", "comments", "comment"],
};

function matchColumnName(header: string, field: string): boolean {
  const normalized = header.toLowerCase().trim();
  const aliases = COLUMN_NAME_ALIASES[field];
  if (!aliases) return false;
  return aliases.includes(normalized);
}

function mapRowsToAsins(rows: Record<string, any>[], mapping: ColumnMapping): AsinInput[] {
  const asins: AsinInput[] = [];

  for (const row of rows) {
    if (!mapping.asin || !mapping.cogs) continue;

    const asinVal = row[mapping.asin];
    const cogsVal = row[mapping.cogs];

    if (asinVal === undefined || cogsVal === undefined) continue;

    const asin = String(asinVal).trim();
    const cogs = parseFloat(String(cogsVal));

    if (!asin || isNaN(cogs)) continue;

    let buyLink: string | null = null;
    let prepOverride: number | null = null;
    let storageOverride: number | null = null;

    if (mapping.buyLink && row[mapping.buyLink] !== undefined && row[mapping.buyLink] !== "") {
      buyLink = String(row[mapping.buyLink]).trim();
    }
    if (mapping.prepCost && row[mapping.prepCost] !== undefined && row[mapping.prepCost] !== "") {
      const p = parseFloat(String(row[mapping.prepCost]));
      if (!isNaN(p)) prepOverride = p;
    }
    if (mapping.additionalFees && row[mapping.additionalFees] !== undefined && row[mapping.additionalFees] !== "") {
      const s = parseFloat(String(row[mapping.additionalFees]));
      if (!isNaN(s)) storageOverride = s;
    }

    let tags: string[] | null = null;
    if (mapping.tags && row[mapping.tags] !== undefined && row[mapping.tags] !== "") {
      tags = String(row[mapping.tags]).split(",").map((t) => t.trim()).filter((t) => t.length > 0);
      if (tags.length === 0) tags = null;
    }

    let notes: string | null = null;
    if (mapping.notes && row[mapping.notes] !== undefined && row[mapping.notes] !== "") {
      notes = String(row[mapping.notes]).trim() || null;
    }

    asins.push({ asin, cogs, buyLink, prepOverride, storageOverride, tags, notes });
  }

  if (asins.length === 0) {
    throw new Error("No valid ASIN/COGS rows found in the file.");
  }

  return asins;
}

function parseFileToAsins(buffer: Buffer, filename: string): AsinInput[] {
  const { rows } = parseFileToRawRows(buffer, filename);

  if (rows.length === 0) {
    throw new Error("No data rows found in the file.");
  }

  const headers = Object.keys(rows[0]);
  const asinHeader = headers.find((h) => matchColumnName(h, "asin"));
  const cogsHeader = headers.find((h) => matchColumnName(h, "cogs"));
  const prepHeader = headers.find((h) => matchColumnName(h, "prepCost"));
  const storageHeader = headers.find((h) => matchColumnName(h, "additionalFees"));
  const buyLinkHeader = headers.find((h) => matchColumnName(h, "buyLink"));

  if (!asinHeader || !cogsHeader) {
    throw new Error('File must contain "ASIN" and "COGS" columns.');
  }

  const tagsHeader = headers.find((h) => matchColumnName(h, "tags"));
  const notesHeader = headers.find((h) => matchColumnName(h, "notes"));

  const mapping: ColumnMapping = {
    asin: asinHeader,
    cogs: cogsHeader,
    buyLink: buyLinkHeader ?? null,
    prepCost: prepHeader ?? null,
    additionalFees: storageHeader ?? null,
    tags: tagsHeader ?? null,
    notes: notesHeader ?? null,
  };

  return mapRowsToAsins(rows, mapping);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasValidFees(result: AsinResult): boolean {
  const fee = result.feesData.fbaFulfillmentFee;
  return fee != null && fee > 0;
}

function hasValidPricing(result: AsinResult): boolean {
  return (
    result.pricingData.lowestFbaPrice != null ||
    result.pricingData.buyBoxPrice != null ||
    result.pricingData.lowestPrice != null
  );
}

function hasValidBsr(result: AsinResult): boolean {
  return result.catalogData.bsrRank != null;
}

function needsRetry(result: AsinResult): { fees: boolean; pricing: boolean; catalog: boolean } {
  return {
    fees: !hasValidFees(result),
    pricing: !hasValidPricing(result),
    catalog: !hasValidBsr(result) && !result.error,
  };
}

async function fetchPricingAndCatalog(
  asin: string,
  existingResult?: AsinResult,
  retryParts?: { fees: boolean; pricing: boolean; catalog: boolean },
): Promise<{
  pricingData: AsinResult["pricingData"];
  catalogData: AsinResult["catalogData"];
  pricingRestricted: boolean;
}> {
  const shouldFetchPricing = !retryParts || retryParts.pricing;
  const shouldFetchCatalog = !retryParts || retryParts.catalog;

  let pricingData = existingResult?.pricingData ?? {
    lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null as "FBA" | "FBM" | null,
    lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null,
    numberOfSellers: null, sellersFba: null, sellersFbm: null,
  };
  let catalogData = existingResult?.catalogData ?? {
    weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null,
  };
  let pricingRestricted = false;

  const parallelCalls: Promise<void>[] = [];

  if (shouldFetchPricing) {
    parallelCalls.push(
      getPricing(asin).then((data: any) => {
        if (data._restricted) {
          pricingRestricted = true;
          log(`Pricing for ${asin} flagged as restricted`, "analyzer");
        }
        pricingData = data;
      }).catch((err) => {
        log(`Pricing error for ${asin}: ${err.message}`, "analyzer");
      })
    );
  }
  if (shouldFetchCatalog) {
    parallelCalls.push(
      getCatalogData(asin).then((data) => {
        if (!retryParts) {
          catalogData = data;
        } else {
          if (data.bsrRank != null) {
            catalogData = { ...catalogData, bsrRank: data.bsrRank, bsrCategory: data.bsrCategory };
          }
          if (catalogData.title == null && data.title != null) catalogData.title = data.title;
          if (catalogData.imageUrl == null && data.imageUrl != null) catalogData.imageUrl = data.imageUrl;
        }
      }).catch((err) => {
        log(`Catalog error for ${asin}: ${err.message}`, "analyzer");
      })
    );
  }

  await Promise.all(parallelCalls);

  return { pricingData, catalogData, pricingRestricted };
}

function buildResult(
  input: AsinInput,
  pricingData: AsinResult["pricingData"],
  catalogData: AsinResult["catalogData"],
  feesData: AsinResult["feesData"],
  pricingRestricted: boolean,
  eligibilityData: EligibilityResult,
): AsinResult {
  let error: string | null = null;
  if (pricingRestricted && !hasValidPricing({ pricingData } as AsinResult)) {
    error = "Restricted - no pricing data available";
  } else if (!hasValidPricing({ pricingData } as AsinResult) && catalogData.title != null) {
    error = "Price unavailable - product found but pricing data could not be retrieved";
  } else if (!hasValidFees({ feesData } as AsinResult) && !hasValidPricing({ pricingData } as AsinResult)) {
    error = "No pricing or fee data available";
  }

  return {
    asin: input.asin,
    cogs: input.cogs,
    buyLink: input.buyLink ?? null,
    prepOverride: input.prepOverride ?? null,
    storageOverride: input.storageOverride ?? null,
    pricingData, feesData, catalogData,
    eligibilityData,
    error,
  };
}

function getFeePriceForAsin(pricingData: AsinResult["pricingData"]): { price: number; isFallback: boolean } {
  const realPrice =
    pricingData.lowestFbaPrice ??
    pricingData.buyBoxPrice ??
    pricingData.lowestPrice;
  return { price: realPrice ?? 15, isFallback: realPrice == null };
}

async function upsertAsinResult(result: AsinResult): Promise<void> {
  const supplier = extractDomain(result.buyLink);

  await query(
    `INSERT INTO asins (asin, title, image_url, brand, category, weight_lb, buy_link, supplier, is_meltable, is_hazmat, last_refreshed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (asin) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, asins.title),
       image_url = COALESCE(EXCLUDED.image_url, asins.image_url),
       brand = COALESCE(EXCLUDED.brand, asins.brand),
       category = COALESCE(EXCLUDED.category, asins.category),
       weight_lb = COALESCE(EXCLUDED.weight_lb, asins.weight_lb),
       buy_link = COALESCE(EXCLUDED.buy_link, asins.buy_link),
       supplier = COALESCE(EXCLUDED.supplier, asins.supplier),
       is_meltable = EXCLUDED.is_meltable OR asins.is_meltable,
       is_hazmat = EXCLUDED.is_hazmat OR asins.is_hazmat,
       last_refreshed_at = NOW()`,
    [
      result.asin,
      result.catalogData.title,
      result.catalogData.imageUrl,
      result.catalogData.brand,
      result.catalogData.bsrCategory,
      result.catalogData.weightLbs,
      result.buyLink,
      supplier,
      (result.catalogData as any).isMeltable ?? false,
      (result.catalogData as any).isHazmat ?? false,
    ]
  );

  await query(
    `INSERT INTO asin_estimates (
       asin, cogs, prep_override, storage_override,
       lowest_fba_price, buy_box_price, buy_box_fulfillment, lowest_price,
       sellers_fba, sellers_fbm, fba_fee, referral_fee, fees_estimate_price,
       bsr, bsr_category, eligibility_status, error, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (asin) DO UPDATE SET
       cogs = EXCLUDED.cogs,
       prep_override = EXCLUDED.prep_override,
       storage_override = EXCLUDED.storage_override,
       lowest_fba_price = COALESCE(EXCLUDED.lowest_fba_price, asin_estimates.lowest_fba_price),
       buy_box_price = COALESCE(EXCLUDED.buy_box_price, asin_estimates.buy_box_price),
       buy_box_fulfillment = COALESCE(EXCLUDED.buy_box_fulfillment, asin_estimates.buy_box_fulfillment),
       lowest_price = COALESCE(EXCLUDED.lowest_price, asin_estimates.lowest_price),
       sellers_fba = COALESCE(EXCLUDED.sellers_fba, asin_estimates.sellers_fba),
       sellers_fbm = COALESCE(EXCLUDED.sellers_fbm, asin_estimates.sellers_fbm),
       fba_fee = COALESCE(EXCLUDED.fba_fee, asin_estimates.fba_fee),
       referral_fee = COALESCE(EXCLUDED.referral_fee, asin_estimates.referral_fee),
       fees_estimate_price = COALESCE(EXCLUDED.fees_estimate_price, asin_estimates.fees_estimate_price),
       bsr = COALESCE(EXCLUDED.bsr, asin_estimates.bsr),
       bsr_category = COALESCE(EXCLUDED.bsr_category, asin_estimates.bsr_category),
       eligibility_status = EXCLUDED.eligibility_status,
       error = EXCLUDED.error,
       fetched_at = NOW()`,
    [
      result.asin,
      result.cogs, result.prepOverride, result.storageOverride,
      result.pricingData.lowestFbaPrice, result.pricingData.buyBoxPrice,
      result.pricingData.buyBoxFulfillment, result.pricingData.lowestPrice,
      result.pricingData.sellersFba, result.pricingData.sellersFbm,
      result.feesData.fbaFulfillmentFee, result.feesData.referralFee, result.feesData.feesEstimatePrice,
      result.catalogData.bsrRank, result.catalogData.bsrCategory,
      result.eligibilityData?.status, result.error,
    ]
  );

  // Record history snapshot for seller/price/BSR trends
  const salePrice = result.pricingData.lowestFbaPrice ?? result.pricingData.buyBoxPrice ?? result.pricingData.lowestPrice;
  const idRow = await query(`SELECT id FROM asins WHERE asin = $1`, [result.asin]);
  if (idRow.rows.length > 0) {
    await query(
      `INSERT INTO asin_estimates_history (asin_id, sellers_fba, sellers_fbm, sale_price, bsr) VALUES ($1, $2, $3, $4, $5)`,
      [idRow.rows[0].id, result.pricingData.sellersFba, result.pricingData.sellersFbm, salePrice, result.catalogData.bsrRank]
    ).catch(() => {});
  }
}

async function upsertTagsForAsin(asin: string, tagNames: string[]): Promise<void> {
  const asinRow = await query(`SELECT id FROM asins WHERE asin = $1`, [asin]);
  if (asinRow.rows.length === 0) return;
  const asinId = asinRow.rows[0].id;

  for (const name of tagNames) {
    let tagRes = await query(`SELECT id FROM tags WHERE LOWER(name) = LOWER($1)`, [name]);
    if (tagRes.rows.length === 0) {
      tagRes = await query(
        `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id`,
        [name, TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]]
      );
    }
    await query(
      `INSERT INTO asin_tags (asin_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [asinId, tagRes.rows[0].id]
    );
  }
}

async function appendNotesForAsin(asin: string, newNotes: string): Promise<void> {
  await query(
    `UPDATE asins SET notes = CASE
       WHEN notes IS NULL OR notes = '' THEN $2
       WHEN notes = $2 THEN notes
       ELSE notes || E'\n' || $2
     END WHERE asin = $1`,
    [asin, newNotes]
  );
}

function writeResult(res: Response, allResults: Map<string, AsinResult>, asin: string, result: AsinResult, isUpdate = false): void {
  allResults.set(asin, result);
  res.write(JSON.stringify({ type: "result", data: isUpdate ? { ...result, _update: true } : result }) + "\n");
  if (isDbAvailable()) {
    upsertAsinResult(result).catch((err: any) => log(`DB upsert error for ${asin}: ${err.message}`, "db"));
  }
}

async function runSheetsSync(): Promise<{ updated: number; skipped: number; errors: string[] }> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured");

  const sheetData = await fetchSheetData(sheetId);
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [asin, data] of Array.from(sheetData.entries())) {
    try {
      // Respect manual COGS overrides: skip COGS update (but still sync ordered_qty)
      // for ASINs where a user has explicitly entered cogs_source = 'manual'.
      const manualCheck = data.cogs != null
        ? await query(`SELECT cogs_source FROM asin_estimates WHERE asin = $1`, [asin])
        : null;
      const isManualOverride = manualCheck?.rows?.[0]?.cogs_source === "manual";

      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;
      if (data.cogs != null && !isManualOverride) {
        setClauses.push(`cogs = $${idx++}`, `cogs_source = $${idx++}`);
        values.push(data.cogs, "po_sheet");
      }
      setClauses.push(`ordered_qty = $${idx++}`);
      values.push(data.orderedQty);
      values.push(asin);

      const result = await query(
        `UPDATE asin_estimates SET ${setClauses.join(", ")} WHERE asin = $${idx}`,
        values
      );
      if ((result.rowCount ?? 0) > 0) updated++;
      else skipped++;

      // Update supplier on asins table if available
      if (data.supplier) {
        await query(`UPDATE asins SET supplier = COALESCE(supplier, $2) WHERE asin = $1`, [asin, data.supplier]);
      }
    } catch (err: any) {
      errors.push(`${asin}: ${err.message}`);
    }
  }

  return { updated, skipped, errors };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/verify-password", (req: Request, res: Response) => {
    const { password } = req.body as { password: string };
    const appPassword = process.env.APP_PASSWORD;

    if (!appPassword) {
      res.json({ valid: true });
      return;
    }

    if (password === appPassword) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false, message: "Incorrect password" });
    }
  });

  app.get("/api/credentials-status", (_req: Request, res: Response) => {
    const configured = !!(
      process.env.SP_API_CLIENT_ID &&
      process.env.SP_API_CLIENT_SECRET &&
      process.env.SP_API_REFRESH_TOKEN
    );
    res.json({ configured });
  });

  // Main AsinFlow: load all ASINs joined with estimates, inventory, sales, tags, deltas
  app.get("/api/asins", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      const { startDate, endDate, includeArchived } = req.query as { startDate?: string; endDate?: string; includeArchived?: string };
      const activeFilter = includeArchived === "true" ? "TRUE" : "a.is_active = TRUE";

      const result = await query(`
        SELECT
          a.asin, a.title, a.image_url, a.brand, a.category, a.weight_lb, a.buy_link, a.is_active,
          a.primary_sku, a.in_catalog, a.notes, a.is_meltable, a.is_hazmat, a.is_search_suppressed, a.suppression_reasons, a.last_reviewed_at, a.added_at,
          e.cogs, e.cogs_source, e.prep_override, e.storage_override,
          e.lowest_fba_price, e.buy_box_price, e.buy_box_fulfillment, e.lowest_price,
          e.sellers_fba, e.sellers_fbm,
          e.fba_fee, e.referral_fee, e.fees_estimate_price,
          e.bsr, e.bsr_category, e.eligibility_status, e.error,
          e.fetched_at,
          e.ordered_qty AS est_ordered_qty
        FROM asins a
        LEFT JOIN asin_estimates e ON e.asin = a.asin
        WHERE ${activeFilter}
        ORDER BY a.last_refreshed_at DESC NULLS LAST
      `);

      // Latest inventory snapshot per ASIN
      const invResult = await query(`
        SELECT DISTINCT ON (i.asin_id)
          a.asin, i.available_fba, i.reserved, i.inbound_shipped, i.inbound_receiving, i.ordered_qty
        FROM inventory_snapshots i
        JOIN asins a ON a.id = i.asin_id
        ORDER BY i.asin_id, i.snapshot_at DESC
      `).catch(() => ({ rows: [] as any[] }));
      const invMap = new Map<string, any>();
      for (const row of invResult.rows) invMap.set(row.asin, row);

      // Aggregated sales for date range
      const salesMap = new Map<string, any>();
      const daysInStockMap = new Map<string, number>();
      if (startDate && endDate) {
        const salesResult = await query(`
          SELECT
            a.asin,
            SUM(s.units_sold) AS units_sold,
            SUM(s.revenue) AS revenue,
            SUM(s.units_refunded) AS units_refunded,
            SUM(s.refund_amount) AS refund_amount,
            COUNT(CASE WHEN s.units_sold > 0 THEN 1 END) AS days_with_sales
          FROM sales_daily s
          JOIN asins a ON a.id = s.asin_id
          WHERE s.sale_date >= $1 AND s.sale_date <= $2
          GROUP BY a.asin
        `, [startDate, endDate]).catch(() => ({ rows: [] as any[] }));
        for (const row of salesResult.rows) salesMap.set(row.asin, row);

        const disResult = await query(`
          SELECT a.asin, COUNT(DISTINCT DATE(i.snapshot_at)) AS days_in_stock
          FROM inventory_snapshots i
          JOIN asins a ON a.id = i.asin_id
          WHERE i.snapshot_at >= $1::date AND i.snapshot_at <= ($2::date + 1) AND i.available_fba > 0
          GROUP BY a.asin
        `, [startDate, endDate]).catch(() => ({ rows: [] as any[] }));
        for (const row of disResult.rows) daysInStockMap.set(row.asin, parseInt(row.days_in_stock) || 0);
      }

      // Seller deltas (7d/30d)
      const deltaResult = await query(`
        SELECT
          a.asin,
          (SELECT sellers_fba FROM asin_estimates_history h WHERE h.asin_id = a.id AND h.fetched_at <= NOW() - INTERVAL '6 days' ORDER BY h.fetched_at DESC LIMIT 1) AS fba_7d_old,
          (SELECT sellers_fbm FROM asin_estimates_history h WHERE h.asin_id = a.id AND h.fetched_at <= NOW() - INTERVAL '6 days' ORDER BY h.fetched_at DESC LIMIT 1) AS fbm_7d_old,
          (SELECT sellers_fba FROM asin_estimates_history h WHERE h.asin_id = a.id AND h.fetched_at <= NOW() - INTERVAL '29 days' ORDER BY h.fetched_at DESC LIMIT 1) AS fba_30d_old,
          (SELECT sellers_fbm FROM asin_estimates_history h WHERE h.asin_id = a.id AND h.fetched_at <= NOW() - INTERVAL '29 days' ORDER BY h.fetched_at DESC LIMIT 1) AS fbm_30d_old
        FROM asins a WHERE a.is_active = TRUE
      `).catch(() => ({ rows: [] as any[] }));
      const deltaMap = new Map<string, any>();
      for (const row of deltaResult.rows) deltaMap.set(row.asin, row);

      // SKUs per ASIN
      const skusResult = await query(`
        SELECT a.asin, s.sku FROM asin_skus s
        JOIN asins a ON a.id = s.asin_id
        WHERE a.is_active = TRUE ORDER BY s.is_primary DESC, s.sku
      `).catch(() => ({ rows: [] as any[] }));
      const skusMap = new Map<string, string[]>();
      for (const row of skusResult.rows) {
        const arr = skusMap.get(row.asin) ?? [];
        arr.push(row.sku);
        skusMap.set(row.asin, arr);
      }

      // Tags per ASIN
      const tagsResult = await query(`
        SELECT a.asin, t.name, t.color FROM asin_tags at
        JOIN tags t ON t.id = at.tag_id
        JOIN asins a ON a.id = at.asin_id
        WHERE a.is_active = TRUE
      `).catch(() => ({ rows: [] as any[] }));
      const tagsMap = new Map<string, { name: string; color: string }[]>();
      for (const row of tagsResult.rows) {
        const arr = tagsMap.get(row.asin) ?? [];
        arr.push({ name: row.name, color: row.color });
        tagsMap.set(row.asin, arr);
      }

      const asinResults: AsinResult[] = result.rows.map((row: any) => {
        const inv = invMap.get(row.asin);
        const sales = salesMap.get(row.asin);

        const stock = inv ? {
          available_fba: parseInt(inv.available_fba) || 0,
          reserved: parseInt(inv.reserved) || 0,
          inbound: (parseInt(inv.inbound_shipped) || 0) + (parseInt(inv.inbound_receiving) || 0),
          ordered: parseInt(row.est_ordered_qty) || 0,
          total: (parseInt(inv.available_fba) || 0) +
                 (parseInt(inv.reserved) || 0) +
                 (parseInt(inv.inbound_shipped) || 0) +
                 (parseInt(inv.inbound_receiving) || 0) +
                 (parseInt(row.est_ordered_qty) || 0),
        } : null;

        const actuals = sales ? {
          units_sold: parseInt(sales.units_sold) || 0,
          revenue: parseFloat(sales.revenue) || 0,
          units_refunded: parseInt(sales.units_refunded) || 0,
          refund_amount: parseFloat(sales.refund_amount) || 0,
          days_with_sales: parseInt(sales.days_with_sales) || 0,
          days_in_stock: daysInStockMap.get(row.asin) ?? 0,
        } : null;

        const d = deltaMap.get(row.asin);
        const curFba = row.sellers_fba != null ? parseInt(row.sellers_fba) : null;
        const curFbm = row.sellers_fbm != null ? parseInt(row.sellers_fbm) : null;

        return {
          asin: row.asin,
          cogs: parseFloat(row.cogs) || 0,
          buyLink: row.buy_link ?? null,
          prepOverride: row.prep_override != null ? parseFloat(row.prep_override) : null,
          storageOverride: row.storage_override != null ? parseFloat(row.storage_override) : null,
          pricingData: {
            lowestFbaPrice: row.lowest_fba_price != null ? parseFloat(row.lowest_fba_price) : null,
            buyBoxPrice: row.buy_box_price != null ? parseFloat(row.buy_box_price) : null,
            buyBoxFulfillment: row.buy_box_fulfillment as "FBA" | "FBM" | null,
            lowestPrice: row.lowest_price != null ? parseFloat(row.lowest_price) : null,
            avg30DayPrice: null,
            avg90DayPrice: null,
            numberOfSellers: null,
            sellersFba: curFba,
            sellersFbm: curFbm,
          },
          feesData: {
            fbaFulfillmentFee: row.fba_fee != null ? parseFloat(row.fba_fee) : null,
            referralFee: row.referral_fee != null ? parseFloat(row.referral_fee) : null,
            feesEstimatePrice: row.fees_estimate_price != null ? parseFloat(row.fees_estimate_price) : null,
          },
          catalogData: {
            weightLbs: row.weight_lb != null ? parseFloat(row.weight_lb) : null,
            title: row.title ?? null,
            brand: row.brand ?? null,
            imageUrl: row.image_url ?? null,
            bsrRank: row.bsr != null ? parseInt(row.bsr) : null,
            bsrCategory: row.bsr_category ?? null,
          },
          eligibilityData: { status: (row.eligibility_status as "yes" | "no" | "check") ?? "check" },
          error: row.error ?? null,
          stock,
          actuals,
          sku: row.primary_sku ?? null,
          skus: skusMap.get(row.asin) ?? [],
          inCatalog: row.in_catalog ?? false,
          tags: tagsMap.get(row.asin) ?? [],
          notes: row.notes ?? null,
          isArchived: row.is_active === false,
          isMeltable: row.is_meltable ?? false,
          isHazmat: row.is_hazmat ?? false,
          isSearchSuppressed: row.is_search_suppressed ?? false,
          suppressionReasons: row.suppression_reasons ?? [],
          cogsSource: (row.cogs_source as "po_sheet" | "csv" | "manual" | null) ?? null,
          pricesFetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
          lastReviewedAt: row.last_reviewed_at ? new Date(row.last_reviewed_at).toISOString() : null,
          addedAt: row.added_at ? new Date(row.added_at).toISOString() : null,
          sellersDelta: d ? {
            fba_7d: curFba != null && d.fba_7d_old != null ? curFba - parseInt(d.fba_7d_old) : null,
            fba_30d: curFba != null && d.fba_30d_old != null ? curFba - parseInt(d.fba_30d_old) : null,
            fbm_7d: curFbm != null && d.fbm_7d_old != null ? curFbm - parseInt(d.fbm_7d_old) : null,
            fbm_30d: curFbm != null && d.fbm_30d_old != null ? curFbm - parseInt(d.fbm_30d_old) : null,
          } : null,
        };
      });

      res.json(asinResults);
    } catch (err: any) {
      log(`GET /api/asins error: ${err.message}`, "db");
      res.status(500).json({ message: err.message });
    }
  });

  // Settings API for Chrome extension
  app.get("/api/settings", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query("SELECT key, value FROM settings");
      const settings: Record<string, number> = {};
      for (const row of result.rows) {
        settings[row.key] = parseFloat(row.value);
      }
      res.json(settings);
    } catch (err: any) {
      log(`Settings fetch error: ${err.message}`, "api");
      res.status(500).json({ message: "Failed to fetch settings. Is DATABASE_URL configured?" });
    }
  });

  // ASIN existence check for Chrome extension
  app.get("/api/asins/check/:asin", async (req: Request, res: Response) => {
    try {
      const rawAsin = req.params.asin;
      const asin = (typeof rawAsin === "string" ? rawAsin : "").toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) {
        res.status(400).json({ message: "Valid 10-character ASIN is required" });
        return;
      }

      const asinResult = await pool.query(
        "SELECT asin FROM asins WHERE asin = $1 LIMIT 1",
        [asin]
      );

      if (asinResult.rowCount === 0) {
        res.json({ exists: false });
        return;
      }

      // Look up the most recent non-null COGS for this ASIN. We order by
      // `id DESC` (UUID insertion order is not strictly chronological but
      // serves as a stable tiebreaker) — we avoid `updated_at`/`fetched_at`
      // because the exact timestamp column name varies in production.
      const cogsResult = await pool.query(
        `SELECT cogs FROM asin_estimates
         WHERE asin = $1 AND cogs IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
        [asin]
      );

      const cogs = cogsResult.rows[0]?.cogs != null ? parseFloat(cogsResult.rows[0].cogs) : null;
      res.json({ exists: true, cogs });
    } catch (err: any) {
      log(`ASIN check error: ${err.message}`, "api");
      res.status(500).json({ message: "Failed to check ASIN. Is DATABASE_URL configured?" });
    }
  });

  // ASIN import from Chrome extension
  app.post("/api/import-asin", async (req: Request, res: Response) => {
    try {
      const {
        asin,
        title,
        image_url,
        brand,
        category,
        weight_oz,
        length_in,
        width_in,
        height_in,
        buy_link,
        cogs,
        sale_price,
        bsr,
        sellers_fba,
        sellers_fbm,
      } = req.body;

      if (!asin || typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) {
        res.status(400).json({ message: "Valid 10-character ASIN is required" });
        return;
      }

      // The production schema stores weight in pounds (`weight_lb`), but the
      // extension scrapes it from Amazon detail pages in ounces. Convert here.
      const weightLb = weight_oz != null && !isNaN(parseFloat(weight_oz))
        ? parseFloat(weight_oz) / 16
        : null;

      // ── Upsert asins ────────────────────────────────────────────────────
      // Only columns that exist in production's `asins` table. BSR,
      // seller counts, and prices live in `asin_estimates`, not here.
      const upsertResult = await pool.query(
        `INSERT INTO asins (asin, title, brand, image_url, category, weight_lb, length_in, width_in, height_in, buy_link, in_catalog, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, true)
         ON CONFLICT (asin) DO UPDATE SET
           title = COALESCE($2, asins.title),
           brand = COALESCE($3, asins.brand),
           image_url = COALESCE($4, asins.image_url),
           category = COALESCE($5, asins.category),
           weight_lb = COALESCE($6, asins.weight_lb),
           length_in = COALESCE($7, asins.length_in),
           width_in = COALESCE($8, asins.width_in),
           height_in = COALESCE($9, asins.height_in),
           buy_link = COALESCE($10, asins.buy_link)
         RETURNING (xmax = 0) AS inserted`,
        [
          asin,
          title ?? null,
          brand ?? null,
          image_url ?? null,
          category ?? null,
          weightLb,
          length_in ?? null,
          width_in ?? null,
          height_in ?? null,
          buy_link ?? null,
        ]
      );

      const wasInserted = upsertResult.rows[0]?.inserted;

      // ── Upsert asin_estimates ───────────────────────────────────────────
      // The production `cogs_source` column has a CHECK constraint that
      // restricts values to ('po_sheet', 'csv', 'manual'), so the extension
      // writes as 'manual'. We also can't rely on a unique constraint
      // existing for ON CONFLICT, so we use an explicit
      // SELECT → UPDATE-or-INSERT pattern.
      //
      // The sale price from the extension maps to `buy_box_price` in
      // production (the price the user saw on the product page).
      const hasCogs = cogs != null && !isNaN(parseFloat(cogs));
      const hasEstimateFields = hasCogs
        || sale_price != null
        || bsr != null
        || sellers_fba != null
        || sellers_fbm != null;

      if (hasEstimateFields) {
        const existing = await pool.query(
          `SELECT id FROM asin_estimates
           WHERE asin = $1 AND cogs_source = 'manual'
           ORDER BY id DESC LIMIT 1`,
          [asin]
        );

        if ((existing.rowCount ?? 0) > 0) {
          await pool.query(
            `UPDATE asin_estimates SET
               cogs = COALESCE($2, cogs),
               buy_box_price = COALESCE($3, buy_box_price),
               bsr = COALESCE($4, bsr),
               sellers_fba = COALESCE($5, sellers_fba),
               sellers_fbm = COALESCE($6, sellers_fbm)
             WHERE id = $1`,
            [
              existing.rows[0].id,
              hasCogs ? parseFloat(cogs) : null,
              sale_price ?? null,
              bsr ?? null,
              sellers_fba ?? null,
              sellers_fbm ?? null,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO asin_estimates (asin, cogs, cogs_source, buy_box_price, bsr, sellers_fba, sellers_fbm)
             VALUES ($1, $2, 'manual', $3, $4, $5, $6)`,
            [
              asin,
              hasCogs ? parseFloat(cogs) : null,
              sale_price ?? null,
              bsr ?? null,
              sellers_fba ?? null,
              sellers_fbm ?? null,
            ]
          );
        }
      }

      res.json({ success: true, action: wasInserted ? "created" : "updated", asin });
    } catch (err: any) {
      log(`Import ASIN error: ${err.message}`, "api");
      res.status(500).json({ message: "Failed to import ASIN. Is DATABASE_URL configured?" });
    }
  });

  app.get("/api/download-template", (_req: Request, res: Response) => {
    try {
      const wb = XLSX.utils.book_new();

      const titleRow = ["AsinFlow Upload Template"];
      const blankRow = [""];
      const headerRow = ["ASIN", "COGS", "Buy Link", "Prep Cost", "Additional Fees"];
      const exampleRows = [
        ["B0EXAMPLE01", 5.99, "https://supplier.com/product1", 0.50, 0.25],
        ["B0EXAMPLE02", 12.49, "https://amazon.com/dp/B0EXAMPLE02", "", ""],
        ["B0EXAMPLE03", 3.25, "", 1.00, ""],
      ];
      const noteRows = [
        [""],
        ["Notes:"],
        ["- ASIN and COGS columns are required"],
        ["- Buy Link: URL to supplier or source page (optional)"],
        ["- Prep Cost: Per-unit prep cost override (optional, uses default from settings if blank)"],
        ["- Additional Fees: Per-unit storage/additional fee override (optional, uses default from settings if blank)"],
        ["- Delete the example rows above before uploading your data"],
      ];

      const allRows = [titleRow, blankRow, headerRow, ...exampleRows, ...noteRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];

      ws["!cols"] = [
        { wch: 16 },
        { wch: 10 },
        { wch: 40 },
        { wch: 14 },
        { wch: 18 },
      ];

      XLSX.utils.book_append_sheet(wb, ws, "Template");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Disposition", "attachment; filename=asinflow_template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: any) {
      log(`Template generation error: ${err.message}`, "template");
      res.status(500).json({ message: "Failed to generate template" });
    }
  });

  app.post("/api/parse-file", upload.single("file"), (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "No file uploaded" });
        return;
      }

      const { headers, rows } = parseFileToRawRows(req.file.buffer, req.file.originalname);
      const rowCount = rows.length;

      const autoMapping: Record<string, string | null> = {};
      for (const field of Object.keys(COLUMN_NAME_ALIASES)) {
        const matched = headers.find((h) => matchColumnName(h, field));
        autoMapping[field] = matched ?? null;
      }

      log(`Parsed ${rowCount} rows with ${headers.length} columns from ${req.file.originalname} (headers: ${headers.join(", ")})`, "parser");
      res.json({ headers, rowCount, autoMapping });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  app.post("/api/parse-mapped", upload.single("file"), (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "No file uploaded" });
        return;
      }

      let mapping: ColumnMapping;
      try {
        const mappingStr = req.body?.mapping;
        if (!mappingStr) {
          res.status(400).json({ message: "Column mapping is required" });
          return;
        }
        mapping = JSON.parse(mappingStr);
      } catch {
        res.status(400).json({ message: "Invalid column mapping format" });
        return;
      }

      if (!mapping.asin || !mapping.cogs) {
        res.status(400).json({ message: "ASIN and COGS column mappings are required" });
        return;
      }

      const { rows } = parseFileToRawRows(req.file.buffer, req.file.originalname);
      const asins = mapRowsToAsins(rows, mapping);

      const hasPrepOverrides = asins.some((a) => a.prepOverride != null);
      const hasStorageOverrides = asins.some((a) => a.storageOverride != null);
      const hasBuyLinks = asins.some((a) => a.buyLink != null);
      log(`Mapped ${asins.length} ASINs from ${req.file.originalname} (prep: ${hasPrepOverrides}, storage: ${hasStorageOverrides}, buyLinks: ${hasBuyLinks})`, "parser");
      res.json({ asins, hasPrepOverrides, hasStorageOverrides, hasBuyLinks });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // === Inventory / Sales / Sheets / Suppression sync ===
  app.get("/api/inventory/sync", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const result = await syncInventory();
      res.json(result);
    } catch (err: any) {
      log(`Inventory sync error: ${err.message}`, "inventory-sync");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sales/sync", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { startDate, endDate } = req.body as { startDate?: string; endDate?: string };
    if (!startDate || !endDate) {
      res.status(400).json({ message: "startDate and endDate are required" });
      return;
    }
    try {
      const result = await syncSalesData(startDate, endDate);
      res.json(result);
    } catch (err: any) {
      log(`Sales sync error: ${err.message}`, "sales-sync");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/sheets/sync", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!credPath || !fs.existsSync(credPath)) {
      res.status(400).json({ message: "Google credentials file not found" });
      return;
    }
    try {
      const result = await runSheetsSync();
      res.json(result);
    } catch (err: any) {
      log(`Sheets sync error: ${err.message}`, "sheets");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/suppression/sync", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const result = await syncSuppressionData();
      res.json(result);
    } catch (err: any) {
      log(`Suppression sync error: ${err.message}`, "suppression-sync");
      res.status(500).json({ message: err.message });
    }
  });

  // === Archive / unarchive ===
  app.put("/api/asins/archive", async (req: Request, res: Response) => {
    const { asins: asinList, archive } = req.body as { asins: string[]; archive: boolean };
    if (!asinList || !Array.isArray(asinList) || asinList.length === 0) {
      res.status(400).json({ message: "No ASINs provided" });
      return;
    }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(`UPDATE asins SET is_active = $2 WHERE asin = ANY($1::text[])`, [asinList, !archive]);
      res.json({ count: asinList.length, archived: archive });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Tags ===
  app.get("/api/tags", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      const result = await query(`SELECT id, name, color FROM tags ORDER BY name`);
      res.json(result.rows);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/tags", async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) { res.status(400).json({ message: "Tag name required" }); return; }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const existing = await query(`SELECT id, name, color FROM tags WHERE LOWER(name) = LOWER($1)`, [name.trim()]);
      if (existing.rows.length > 0) { res.json(existing.rows[0]); return; }
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
      const result = await query(
        `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color`,
        [name.trim(), color]
      );
      res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/asins/:asin/tags", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { tagIds } = req.body as { tagIds?: string[] };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const asinRow = await query(`SELECT id FROM asins WHERE asin = $1`, [asin]);
      if (asinRow.rows.length === 0) { res.status(404).json({ message: "ASIN not found" }); return; }
      const asinId = asinRow.rows[0].id;
      await query(`DELETE FROM asin_tags WHERE asin_id = $1`, [asinId]);
      if (tagIds && tagIds.length > 0) {
        for (const tagId of tagIds) {
          await query(`INSERT INTO asin_tags (asin_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [asinId, tagId]);
        }
      }
      const tags = await query(
        `SELECT t.id, t.name, t.color FROM asin_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asin_id = $1 ORDER BY t.name`,
        [asinId]
      );
      res.json(tags.rows);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Notes ===
  app.put("/api/asins/:asin/notes", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { notes } = req.body as { notes?: string };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(`UPDATE asins SET notes = $2 WHERE asin = $1`, [asin, notes ?? null]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Reviewed timestamp ===
  app.put("/api/asins/:asin/reviewed", async (req: Request, res: Response) => {
    const { asin } = req.params;
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(`UPDATE asins SET last_reviewed_at = NOW() WHERE asin = $1`, [asin]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Buy Link ===
  app.put("/api/asins/:asin/buy-link", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { buyLink: rawLink } = req.body as { buyLink?: string };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const cleaned = rawLink ? cleanBuyLink(rawLink) : null;
      const supplier = cleaned ? extractDomain(cleaned) : null;
      await query(`UPDATE asins SET buy_link = $2, supplier = $3 WHERE asin = $1`, [asin, cleaned, supplier]);
      res.json({ buyLink: cleaned, supplier });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === View Presets ===
  app.get("/api/view-presets", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      const result = await query(`SELECT id, name, description, config, is_default, created_by, created_at FROM view_presets ORDER BY is_default DESC, name`);
      res.json(result.rows);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/view-presets", async (req: Request, res: Response) => {
    const { name, config } = req.body as { name?: string; config?: any };
    if (!name || !config) { res.status(400).json({ message: "name and config required" }); return; }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const result = await query(
        `INSERT INTO view_presets (name, config, is_default) VALUES ($1, $2, FALSE) RETURNING id, name, config, is_default`,
        [name, JSON.stringify(config)]
      );
      res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/view-presets/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, config } = req.body as { name?: string; config?: any };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const updates: string[] = [];
      const params: any[] = [id];
      if (name) { params.push(name); updates.push(`name = $${params.length}`); }
      if (config) { params.push(JSON.stringify(config)); updates.push(`config = $${params.length}`); }
      if (updates.length === 0) { res.status(400).json({ message: "Nothing to update" }); return; }
      updates.push(`updated_at = NOW()`);
      await query(`UPDATE view_presets SET ${updates.join(", ")} WHERE id = $1`, params);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/view-presets/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(`DELETE FROM view_presets WHERE id = $1 AND is_default = FALSE`, [id]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Stock/Sales History ===
  app.get("/api/asins/:asin/history", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const asinRow = await query(`SELECT id FROM asins WHERE asin = $1`, [asin]);
      if (asinRow.rows.length === 0) { res.status(404).json({ message: "ASIN not found" }); return; }
      const asinId = asinRow.rows[0].id;

      const salesRes = await query(
        `SELECT sale_date AS date, units_sold, revenue FROM sales_daily WHERE asin_id = $1 AND sale_date >= $2 AND sale_date <= $3 ORDER BY sale_date`,
        [asinId, startDate ?? "2020-01-01", endDate ?? "2099-12-31"]
      );

      const invRes = await query(
        `SELECT DISTINCT ON (DATE(snapshot_at)) DATE(snapshot_at) AS date, available_fba, reserved,
           inbound_shipped + inbound_receiving AS inbound
         FROM inventory_snapshots WHERE asin_id = $1 AND snapshot_at >= $2::date AND snapshot_at <= ($3::date + 1)
         ORDER BY DATE(snapshot_at), snapshot_at DESC`,
        [asinId, startDate ?? "2020-01-01", endDate ?? "2099-12-31"]
      );

      const latestInv = await query(
        `SELECT available_fba, reserved, inbound_shipped + inbound_receiving AS inbound, ordered_qty FROM inventory_snapshots WHERE asin_id = $1 ORDER BY snapshot_at DESC LIMIT 1`,
        [asinId]
      );
      const estRow = await query(`SELECT cogs, ordered_qty FROM asin_estimates WHERE asin = $1`, [asin]);
      const inv = latestInv.rows[0];
      const est = estRow.rows[0];
      const stock = parseInt(inv?.available_fba) || 0;
      const cogs = parseFloat(est?.cogs) || 0;
      const totalSold = salesRes.rows.reduce((s: number, r: any) => s + (parseInt(r.units_sold) || 0), 0);
      const daysWithSales = salesRes.rows.filter((r: any) => parseInt(r.units_sold) > 0).length;
      const velocity = daysWithSales > 0 ? totalSold / daysWithSales : 0;

      res.json({
        sales: salesRes.rows.map((r: any) => ({ date: r.date, units_sold: parseInt(r.units_sold) || 0, revenue: parseFloat(r.revenue) || 0 })),
        inventory: invRes.rows.map((r: any) => ({ date: r.date, available_fba: parseInt(r.available_fba) || 0, reserved: parseInt(r.reserved) || 0, inbound: parseInt(r.inbound) || 0 })),
        metrics: {
          days_left: velocity > 0 ? Math.round(stock / velocity) : null,
          velocity: Math.round(velocity * 10) / 10,
          stock_value: Math.round(stock * cogs * 100) / 100,
          reserved: parseInt(inv?.reserved) || 0,
          inbound: parseInt(inv?.inbound) || 0,
          ordered: parseInt(est?.ordered_qty) || 0,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Hazmat surcharge settings ===
  app.get("/api/settings/hazmat", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json({ shipSurcharge: 0, prepSurcharge: 0 }); return; }
    try {
      const ship = await query(`SELECT value FROM settings WHERE key = 'hazmat_ship_surcharge'`);
      const prep = await query(`SELECT value FROM settings WHERE key = 'hazmat_prep_surcharge'`);
      res.json({
        shipSurcharge: parseFloat(ship.rows[0]?.value) || 0,
        prepSurcharge: parseFloat(prep.rows[0]?.value) || 0,
      });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/settings/hazmat", async (req: Request, res: Response) => {
    const { shipSurcharge, prepSurcharge } = req.body as { shipSurcharge?: number; prepSurcharge?: number };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      if (shipSurcharge != null) await query(`UPDATE settings SET value = $1 WHERE key = 'hazmat_ship_surcharge'`, [String(shipSurcharge)]);
      if (prepSurcharge != null) await query(`UPDATE settings SET value = $1 WHERE key = 'hazmat_prep_surcharge'`, [String(prepSurcharge)]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  async function runAnalyzeAndStream(
    asins: AsinInput[],
    res: Response,
    progressPrefix: (i: number) => string | null = () => null,
  ) {
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 1000;
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 2000;

    const allResults: Map<string, AsinResult> = new Map();
    const retryQueue: { input: AsinInput; attempt: number; result: AsinResult }[] = [];

    for (let i = 0; i < asins.length; i++) {
      const input = asins[i];

      const prefix = progressPrefix(i);
      const progressAsin = prefix ? `${prefix} ${input.asin}` : input.asin;
      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: i + 1, total: asins.length, asin: progressAsin },
        }) + "\n"
      );

      let result: AsinResult;

      try {
        const [{ pricingData, catalogData, pricingRestricted }, eligibilityData] = await Promise.all([
          fetchPricingAndCatalog(input.asin),
          getEligibility(input.asin),
        ]);

        const { price: feePrice, isFallback } = getFeePriceForAsin(pricingData);
        let feesData: AsinResult["feesData"] = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };

        if (isFallback) {
          log(`No real price available for ${input.asin}, using fallback price $${feePrice} for fee estimation`, "fees");
        }

        try {
          feesData = await getFees(input.asin, feePrice, catalogData.bsrCategory);
          if (isFallback && feesData.fbaFulfillmentFee != null) {
            log(`Discarding fee estimate for ${input.asin} because it was based on fallback price (got FBA=$${feesData.fbaFulfillmentFee})`, "fees");
            feesData = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
          }
        } catch (err: any) {
          log(`Fees error for ${input.asin}: ${err.message}`, "analyzer");
        }

        result = buildResult(input, pricingData, catalogData, feesData, pricingRestricted, eligibilityData);
      } catch (err: any) {
        log(`Error processing ${input.asin}: ${err.message}\n${err.stack}`, "analyzer");
        result = {
          asin: input.asin,
          cogs: input.cogs,
          buyLink: input.buyLink ?? null,
          prepOverride: input.prepOverride ?? null,
          storageOverride: input.storageOverride ?? null,
          pricingData: {
            lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null,
            lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null,
            numberOfSellers: null, sellersFba: null, sellersFbm: null,
          },
          feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
          catalogData: { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
          eligibilityData: { status: "check" },
          error: err.message || "Unknown error",
        };
      }

      const retryNeeded = needsRetry(result);
      const needsAnyRetry = retryNeeded.fees || retryNeeded.pricing || retryNeeded.catalog;
      if (needsAnyRetry) {
        retryQueue.push({ input, attempt: 1, result });
        log(`Queued ${input.asin} for retry (fees=${retryNeeded.fees}, pricing=${retryNeeded.pricing}, catalog=${retryNeeded.catalog})`, "retry");
        if (!retryNeeded.fees && !retryNeeded.pricing) {
          writeResult(res, allResults, input.asin, result);
        }
      } else {
        writeResult(res, allResults, input.asin, result);
      }

      // Save tags and notes from CSV import (fire-and-forget)
      if (isDbAvailable()) {
        if (input.tags && input.tags.length > 0) {
          upsertTagsForAsin(input.asin, input.tags).catch((err: any) => log(`Tags error for ${input.asin}: ${err.message}`, "db"));
        }
        if (input.notes) {
          appendNotesForAsin(input.asin, input.notes).catch((err: any) => log(`Notes error for ${input.asin}: ${err.message}`, "db"));
        }
      }

      if ((i + 1) % BATCH_SIZE === 0 && i < asins.length - 1) {
        await delay(BATCH_DELAY);
      }
    }

    if (retryQueue.length > 0) {
      log(`Starting retry phase: ${retryQueue.length} ASINs to retry`, "retry");

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const currentBatch = retryQueue.filter((r) => r.attempt === attempt);
        if (currentBatch.length === 0) break;

        log(`Retry attempt ${attempt}: ${currentBatch.length} ASINs`, "retry");
        await delay(RETRY_DELAY);

        res.write(
          JSON.stringify({
            type: "progress",
            data: { current: asins.length, total: asins.length, asin: `Retrying ${currentBatch.length} ASINs (attempt ${attempt})...` },
          }) + "\n"
        );

        for (const item of currentBatch) {
          const retryParts = needsRetry(item.result);

          try {
            log(`Retrying ${item.input.asin}: fees=${retryParts.fees}, pricing=${retryParts.pricing}, catalog=${retryParts.catalog}`, "retry");

            let pricingData = item.result.pricingData;
            let catalogData = item.result.catalogData;
            let pricingRestricted = false;

            if (retryParts.pricing || retryParts.catalog) {
              const fetched = await fetchPricingAndCatalog(item.input.asin, item.result, retryParts);
              pricingData = fetched.pricingData;
              catalogData = fetched.catalogData;
              pricingRestricted = fetched.pricingRestricted;
            }

            let feesData = item.result.feesData;
            if (retryParts.fees) {
              const { price: feePrice, isFallback } = getFeePriceForAsin(pricingData);
              try {
                feesData = await getFees(item.input.asin, feePrice, catalogData.bsrCategory);
                if (isFallback && feesData.fbaFulfillmentFee != null) {
                  log(`Discarding retry fee estimate for ${item.input.asin} because it was based on fallback price (got FBA=$${feesData.fbaFulfillmentFee})`, "fees");
                  feesData = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
                }
              } catch (err: any) {
                log(`Retry fees error for ${item.input.asin}: ${err.message}`, "retry");
              }
            }

            const eligibilityData = item.result.eligibilityData;
            let retried = buildResult(item.input, pricingData, catalogData, feesData, pricingRestricted, eligibilityData);
            item.result = retried;

            const stillNeeds = needsRetry(retried);
            const stillNeedsAny = stillNeeds.fees || stillNeeds.pricing || stillNeeds.catalog;
            if (stillNeedsAny && attempt < MAX_RETRIES) {
              item.attempt = attempt + 1;
              log(`${item.input.asin} still needs retry after attempt ${attempt} (fees=${stillNeeds.fees}, pricing=${stillNeeds.pricing}, catalog=${stillNeeds.catalog})`, "retry");
            } else {
              if (stillNeeds.fees && hasValidPricing(retried)) {
                const { price: fallbackPrice } = getFeePriceForAsin(retried.pricingData);
                const fallbackFees = estimateFeeFallback(
                  item.input.asin, fallbackPrice,
                  retried.catalogData.weightLbs,
                  retried.catalogData.bsrCategory
                );
                retried = buildResult(item.input, retried.pricingData, retried.catalogData, fallbackFees, pricingRestricted, eligibilityData);
                log(`Used fee fallback for ${item.input.asin}: FBA=$${fallbackFees.fbaFulfillmentFee}, Referral=$${fallbackFees.referralFee}`, "retry");
              }

              const updatedNeeds = needsRetry(retried);
              let retryError: string | null = null;
              if (updatedNeeds.pricing) {
                const missingParts: string[] = [];
                if (updatedNeeds.fees) missingParts.push("fees");
                if (updatedNeeds.pricing) missingParts.push("pricing");
                if (updatedNeeds.catalog) missingParts.push("BSR");
                if (retried.error?.includes("Restricted")) {
                  retryError = "Restricted - no pricing data available";
                } else {
                  retryError = `No data after ${attempt} retries (missing: ${missingParts.join(", ")})`;
                }
                log(`EXHAUSTED ${item.input.asin}: ${retryError} | fees=${retried.feesData.fbaFulfillmentFee}, pricing=[fba=${retried.pricingData.lowestFbaPrice}, bb=${retried.pricingData.buyBoxPrice}, low=${retried.pricingData.lowestPrice}], bsr=${retried.catalogData.bsrRank}, weight=${retried.catalogData.weightLbs}, category=${retried.catalogData.bsrCategory}`, "retry");
              }
              const finalResult = retryError
                ? { ...retried, error: retryError }
                : retried;
              writeResult(res, allResults, item.input.asin, finalResult, allResults.has(item.input.asin));
            }
          } catch (err: any) {
            log(`Retry error for ${item.input.asin}: ${err.message}`, "retry");
            if (attempt >= MAX_RETRIES) {
              let finalItem = item.result;
              const failNeeds = needsRetry(finalItem);

              if (failNeeds.fees && hasValidPricing(finalItem)) {
                const { price: fallbackPrice } = getFeePriceForAsin(finalItem.pricingData);
                const fallbackFees = estimateFeeFallback(
                  item.input.asin, fallbackPrice,
                  finalItem.catalogData.weightLbs,
                  finalItem.catalogData.bsrCategory
                );
                finalItem = buildResult(item.input, finalItem.pricingData, finalItem.catalogData, fallbackFees, false, finalItem.eligibilityData);
                log(`Used fee fallback (exception path) for ${item.input.asin}: FBA=$${fallbackFees.fbaFulfillmentFee}, Referral=$${fallbackFees.referralFee}`, "retry");
              }

              const updatedFailNeeds = needsRetry(finalItem);
              const missingParts: string[] = [];
              if (updatedFailNeeds.fees) missingParts.push("fees");
              if (updatedFailNeeds.pricing) missingParts.push("pricing");
              if (updatedFailNeeds.catalog) missingParts.push("BSR");
              const errorMsg = (missingParts.length > 0)
                ? (finalItem.error?.includes("Restricted")
                  ? "Restricted - no pricing data available"
                  : `No data after ${attempt} retries (missing: ${missingParts.join(", ")})`)
                : null;
              log(`EXHAUSTED ${item.input.asin}: ${errorMsg ?? "resolved via fallback"} | exception=${err.message}`, "retry");
              const errorResult: AsinResult = {
                ...finalItem,
                error: errorMsg ?? finalItem.error,
              };
              writeResult(res, allResults, item.input.asin, errorResult, allResults.has(item.input.asin));
            } else {
              item.attempt = attempt + 1;
            }
          }

          await delay(500);
        }
      }

      const uncalculated: string[] = [];
      for (const item of retryQueue) {
        if (!allResults.has(item.input.asin)) {
          const failNeeds = needsRetry(item.result);
          const missingParts: string[] = [];
          if (failNeeds.fees) missingParts.push("fees");
          if (failNeeds.pricing) missingParts.push("pricing");
          if (failNeeds.catalog) missingParts.push("BSR");
          const errorMsg = item.result.error?.includes("Restricted")
            ? "Restricted - no pricing data available"
            : `No data after retries (missing: ${missingParts.join(", ")})`;
          log(`EXHAUSTED (final sweep) ${item.input.asin}: ${errorMsg}`, "retry");
          uncalculated.push(item.input.asin);
          const errorResult: AsinResult = {
            ...item.result,
            error: errorMsg,
          };
          writeResult(res, allResults, item.input.asin, errorResult);
        }
      }
      if (uncalculated.length > 0) {
        log(`=== RETRY SUMMARY: ${uncalculated.length} ASINs still uncalculated: ${uncalculated.join(", ")} ===`, "retry");
      }
    }
  }

  function runPostAnalyzeBackgroundSyncs() {
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (isDbAvailable() && credPath && fs.existsSync(credPath) && process.env.GOOGLE_SHEET_ID) {
      runSheetsSync().catch((err: any) => log(`Post-analysis sheets sync error: ${err.message}`, "sheets"));
    }
    if (isDbAvailable()) {
      syncSuppressionData().catch((err: any) => log(`Post-analysis suppression sync error: ${err.message}`, "suppression-sync"));
    }
  }

  // Analyze a user-supplied list of ASINs (typically from a fresh CSV upload).
  app.post("/api/analyze", async (req: Request, res: Response) => {
    const { asins } = req.body as { asins: AsinInput[] };

    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      res.status(400).json({ message: "No ASINs provided" });
      return;
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await runAnalyzeAndStream(asins, res);
    res.write(JSON.stringify({ type: "complete" }) + "\n");
    res.end();
    runPostAnalyzeBackgroundSyncs();
  });

  // Analyze all active ASINs from the DB in server-side batches of 100.
  // Used when re-analyzing the full catalog — avoids "request entity too large"
  // because the ASIN list is never sent in the request body.
  app.post("/api/analyze/all", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const dbRes = await query(`
        SELECT a.asin, e.cogs, a.buy_link, e.prep_override, e.storage_override
        FROM asins a
        LEFT JOIN asin_estimates e ON e.asin = a.asin
        WHERE a.is_active = TRUE
        ORDER BY a.asin
      `);
      const allAsins: AsinInput[] = dbRes.rows.map((r: any) => ({
        asin: r.asin,
        cogs: r.cogs != null ? parseFloat(r.cogs) : 0,
        buyLink: r.buy_link ?? null,
        prepOverride: r.prep_override != null ? parseFloat(r.prep_override) : null,
        storageOverride: r.storage_override != null ? parseFloat(r.storage_override) : null,
      }));

      const BATCH_SIZE = 100;
      const totalBatches = Math.max(1, Math.ceil(allAsins.length / BATCH_SIZE));
      log(`Full-catalog analyze: ${allAsins.length} ASINs in ${totalBatches} batch(es) of ${BATCH_SIZE}`, "analyzer");

      let succeededTotal = 0;
      let failedBatches = 0;

      for (let b = 0; b < totalBatches; b++) {
        const start = b * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, allAsins.length);
        const batch = allAsins.slice(start, end);
        const batchLabel = `Batch ${b + 1} of ${totalBatches} (ASINs ${start + 1}-${end})`;

        try {
          await runAnalyzeAndStream(batch, res, () => batchLabel);
          succeededTotal += batch.length;
        } catch (err: any) {
          failedBatches++;
          log(`Batch ${b + 1} failed: ${err.message}`, "analyzer");
          res.write(JSON.stringify({
            type: "progress",
            data: { current: end, total: allAsins.length, asin: `${batchLabel} FAILED — continuing` },
          }) + "\n");
        }
      }

      res.write(JSON.stringify({
        type: "complete",
        data: {
          totalAsins: allAsins.length,
          updated: succeededTotal,
          failedBatches,
        },
      }) + "\n");
      res.end();
      runPostAnalyzeBackgroundSyncs();
    } catch (err: any) {
      log(`/api/analyze/all error: ${err.message}`, "analyzer");
      try {
        res.write(JSON.stringify({ type: "error", message: err.message }) + "\n");
        res.end();
      } catch {}
    }
  });

  // === Prices: status (staleness indicator) + on-demand refresh ===
  app.get("/api/prices/status", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json({ lastRefreshedAt: null }); return; }
    try {
      const row = await query(
        `SELECT MAX(e.fetched_at) AS last_refreshed
         FROM asin_estimates e
         JOIN asins a ON a.asin = e.asin
         WHERE a.is_active = TRUE`
      );
      const ts = row.rows[0]?.last_refreshed;
      res.json({ lastRefreshedAt: ts ? new Date(ts).toISOString() : null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/prices/refresh", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const summary = await refreshPrices(async (p) => {
        res.write(JSON.stringify({ type: "progress", data: p }) + "\n");
      });
      res.write(JSON.stringify({
        type: "complete",
        data: { updated: summary.updated, failed: summary.failed },
      }) + "\n");
      res.end();
    } catch (err: any) {
      log(`Price refresh error: ${err.message}`, "price-sync");
      try {
        res.write(JSON.stringify({ type: "error", message: err.message }) + "\n");
        res.end();
      } catch {}
    }
  });

  // === COGS: manual inline edit + reset to PO sync ===
  app.put("/api/asins/:asin/cogs", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { cogs } = req.body as { cogs?: number };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (cogs == null || typeof cogs !== "number" || !isFinite(cogs) || cogs < 0) {
      res.status(400).json({ message: "cogs must be a non-negative number" }); return;
    }
    try {
      const existing = await query(`SELECT asin FROM asin_estimates WHERE asin = $1`, [asin]);
      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO asin_estimates (asin, cogs, cogs_source) VALUES ($1, $2, 'manual')`,
          [asin, cogs],
        );
      } else {
        await query(
          `UPDATE asin_estimates SET cogs = $2, cogs_source = 'manual' WHERE asin = $1`,
          [asin, cogs],
        );
      }
      res.json({ cogs, cogsSource: "manual" });
    } catch (err: any) {
      log(`COGS update error for ${asin}: ${err.message}`, "cogs");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/asins/:asin/cogs/reset", async (req: Request, res: Response) => {
    const asin = String(req.params.asin ?? "");
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!sheetId || !credPath || !fs.existsSync(credPath)) {
      res.status(400).json({ message: "Google Sheet integration not configured" });
      return;
    }

    try {
      // Clear the manual override first so the PO sync path can write to this ASIN.
      await query(
        `UPDATE asin_estimates SET cogs = NULL, cogs_source = NULL WHERE asin = $1`,
        [asin],
      );

      // Pull fresh data from the PO sheet and apply the value for this ASIN only.
      const sheetData = await fetchSheetData(sheetId);
      const entry = sheetData.get(asin);
      if (entry?.cogs != null) {
        await query(
          `UPDATE asin_estimates SET cogs = $2, cogs_source = 'po_sheet' WHERE asin = $1`,
          [asin, entry.cogs],
        );
        res.json({ cogs: entry.cogs, cogsSource: "po_sheet" });
      } else {
        res.json({ cogs: null, cogsSource: null });
      }
    } catch (err: any) {
      log(`COGS reset error for ${asin}: ${err.message}`, "cogs");
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}
