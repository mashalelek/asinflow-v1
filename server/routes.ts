import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { getPricing, getFees, getCatalogData, getBatchFees, type BatchFeeItem, type AsinFeesResult } from "./spapi";
import { log } from "./index";
import { type AsinInput, type AsinResult, type ColumnMapping } from "@shared/schema";

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

    asins.push({ asin, cogs, buyLink, prepOverride, storageOverride });
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

  const mapping: ColumnMapping = {
    asin: asinHeader,
    cogs: cogsHeader,
    buyLink: buyLinkHeader ?? null,
    prepCost: prepHeader ?? null,
    additionalFees: storageHeader ?? null,
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
    weightLbs: null, title: null, imageUrl: null, bsrRank: null, bsrCategory: null,
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

    const BATCH_SIZE = 10;
    const BATCH_DELAY = 1000;
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 2000;

    const allResults: Map<string, AsinResult> = new Map();
    const retryQueue: { input: AsinInput; attempt: number; result: AsinResult; pricingRestricted: boolean; pricingData: AsinResult["pricingData"]; catalogData: AsinResult["catalogData"] }[] = [];

    type IntermediateData = {
      input: AsinInput;
      pricingData: AsinResult["pricingData"];
      catalogData: AsinResult["catalogData"];
      pricingRestricted: boolean;
      error?: string;
    };

    for (let batchStart = 0; batchStart < asins.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, asins.length);
      const batch = asins.slice(batchStart, batchEnd);

      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: batchStart + 1, total: asins.length, asin: `Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}...` },
        }) + "\n"
      );

      const intermediates: IntermediateData[] = await Promise.all(
        batch.map(async (input) => {
          try {
            const { pricingData, catalogData, pricingRestricted } = await fetchPricingAndCatalog(input.asin);
            return { input, pricingData, catalogData, pricingRestricted };
          } catch (err: any) {
            log(`Error fetching pricing/catalog for ${input.asin}: ${err.message}`, "analyzer");
            return {
              input,
              pricingData: {
                lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null as "FBA" | "FBM" | null,
                lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null,
                numberOfSellers: null, sellersFba: null, sellersFbm: null,
              },
              catalogData: { weightLbs: null, title: null, imageUrl: null, bsrRank: null, bsrCategory: null },
              pricingRestricted: false,
              error: err.message || "Unknown error",
            };
          }
        })
      );

      const feeItems: BatchFeeItem[] = [];
      const feeItemFlags: Map<string, boolean> = new Map();
      for (const item of intermediates) {
        if (item.error) continue;
        const { price, isFallback } = getFeePriceForAsin(item.pricingData);
        feeItemFlags.set(item.input.asin, isFallback);
        if (isFallback) {
          log(`No real price available for ${item.input.asin}, using fallback price $${price} for fee estimation`, "fees");
        }
        feeItems.push({ asin: item.input.asin, price, category: item.catalogData.bsrCategory });
      }

      let batchFeeResults = new Map<string, AsinFeesResult>();
      if (feeItems.length > 0) {
        try {
          batchFeeResults = await getBatchFees(feeItems);
        } catch (err: any) {
          log(`Batch fee error: ${err.message}. Falling back to individual calls.`, "fees-batch");
        }
      }

      for (const item of intermediates) {
        let feesData: AsinResult["feesData"] = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };

        if (!item.error) {
          const batchFee = batchFeeResults.get(item.input.asin);
          const isFallback = feeItemFlags.get(item.input.asin) ?? true;

          if (batchFee) {
            if (isFallback && batchFee.fbaFulfillmentFee != null) {
              log(`Discarding fee estimate for ${item.input.asin} because it was based on fallback price (got FBA=$${batchFee.fbaFulfillmentFee})`, "fees");
            } else {
              feesData = batchFee;
            }
          }

          if (!feesData.fbaFulfillmentFee && !isFallback) {
            try {
              const { price } = getFeePriceForAsin(item.pricingData);
              feesData = await getFees(item.input.asin, price, item.catalogData.bsrCategory);
            } catch (err: any) {
              log(`Individual fee fallback for ${item.input.asin} failed: ${err.message}`, "fees");
            }
          }
        }

        const result = item.error
          ? {
              asin: item.input.asin,
              cogs: item.input.cogs,
              buyLink: item.input.buyLink ?? null,
              prepOverride: item.input.prepOverride ?? null,
              storageOverride: item.input.storageOverride ?? null,
              pricingData: item.pricingData,
              feesData,
              catalogData: item.catalogData,
              error: item.error,
            }
          : buildResult(item.input, item.pricingData, item.catalogData, feesData, item.pricingRestricted);

        const retryNeeded = needsRetry(result);
        const needsAnyRetry = retryNeeded.fees || retryNeeded.pricing || retryNeeded.catalog;
        if (needsAnyRetry) {
          retryQueue.push({ input: item.input, attempt: 1, result, pricingRestricted: item.pricingRestricted, pricingData: item.pricingData, catalogData: item.catalogData });
          log(`Queued ${item.input.asin} for retry (fees=${retryNeeded.fees}, pricing=${retryNeeded.pricing}, catalog=${retryNeeded.catalog})`, "retry");
          if (!retryNeeded.fees && !retryNeeded.pricing) {
            allResults.set(item.input.asin, result);
            res.write(JSON.stringify({ type: "result", data: result }) + "\n");
          }
        } else {
          allResults.set(item.input.asin, result);
          res.write(JSON.stringify({ type: "result", data: result }) + "\n");
        }
      }

      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: batchEnd, total: asins.length, asin: batch[batch.length - 1].asin },
        }) + "\n"
      );

      if (batchEnd < asins.length) {
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

        const retryIntermediates: { item: typeof currentBatch[0]; pricingData: AsinResult["pricingData"]; catalogData: AsinResult["catalogData"]; pricingRestricted: boolean }[] = [];

        for (const item of currentBatch) {
          const retryParts = needsRetry(item.result);

          try {
            log(`Retrying ${item.input.asin}: fees=${retryParts.fees}, pricing=${retryParts.pricing}, catalog=${retryParts.catalog}`, "retry");

            if (retryParts.pricing || retryParts.catalog) {
              const { pricingData, catalogData, pricingRestricted } = await fetchPricingAndCatalog(
                item.input.asin, item.result, retryParts,
              );
              item.pricingData = pricingData;
              item.catalogData = catalogData;
              item.pricingRestricted = pricingRestricted || item.pricingRestricted;
            }

            retryIntermediates.push({ item, pricingData: item.pricingData, catalogData: item.catalogData, pricingRestricted: item.pricingRestricted });
          } catch (err: any) {
            log(`Retry pricing/catalog error for ${item.input.asin}: ${err.message}`, "retry");
            retryIntermediates.push({ item, pricingData: item.pricingData, catalogData: item.catalogData, pricingRestricted: item.pricingRestricted });
          }
        }

        const retryFeeItems: BatchFeeItem[] = [];
        const retryFeeFlags: Map<string, boolean> = new Map();
        for (const ri of retryIntermediates) {
          const retryParts = needsRetry(ri.item.result);
          if (retryParts.fees) {
            const { price, isFallback } = getFeePriceForAsin(ri.pricingData);
            retryFeeFlags.set(ri.item.input.asin, isFallback);
            retryFeeItems.push({ asin: ri.item.input.asin, price, category: ri.catalogData.bsrCategory });
          }
        }

        let retryFeeResults = new Map<string, AsinFeesResult>();
        if (retryFeeItems.length > 0) {
          try {
            retryFeeResults = await getBatchFees(retryFeeItems);
          } catch (err: any) {
            log(`Retry batch fee error: ${err.message}`, "fees-batch");
          }
        }

        for (const ri of retryIntermediates) {
          const { item } = ri;
          const asin = item.input.asin;
          const retryParts = needsRetry(item.result);
          let feesData = item.result.feesData;

          if (retryParts.fees) {
            const batchFee = retryFeeResults.get(asin);
            const isFallback = retryFeeFlags.get(asin) ?? true;
            if (batchFee && !(isFallback && batchFee.fbaFulfillmentFee != null)) {
              feesData = batchFee;
            } else if (batchFee && isFallback && batchFee.fbaFulfillmentFee != null) {
              log(`Discarding retry fee estimate for ${asin} because it was based on fallback price`, "fees");
            }
          }

          const retried = buildResult(item.input, ri.pricingData, ri.catalogData, feesData, ri.pricingRestricted);
          item.result = retried;

          const stillNeeds = needsRetry(retried);
          const stillNeedsAny = stillNeeds.fees || stillNeeds.pricing || stillNeeds.catalog;
          if (stillNeedsAny && attempt < MAX_RETRIES) {
            item.attempt = attempt + 1;
            log(`${asin} still needs retry after attempt ${attempt} (fees=${stillNeeds.fees}, pricing=${stillNeeds.pricing}, catalog=${stillNeeds.catalog})`, "retry");
          } else {
            let retryError: string | null = null;
            if (stillNeeds.fees || stillNeeds.pricing) {
              const missingParts: string[] = [];
              if (stillNeeds.fees) missingParts.push("fees");
              if (stillNeeds.pricing) missingParts.push("pricing");
              if (stillNeeds.catalog) missingParts.push("BSR");
              if (retried.error?.includes("Restricted")) {
                retryError = "Restricted - no pricing data available";
              } else {
                retryError = `No data after ${attempt} retries (missing: ${missingParts.join(", ")})`;
              }
              log(`EXHAUSTED ${asin}: ${retryError} | fees=${retried.feesData.fbaFulfillmentFee}, pricing=[fba=${retried.pricingData.lowestFbaPrice}, bb=${retried.pricingData.buyBoxPrice}, low=${retried.pricingData.lowestPrice}], bsr=${retried.catalogData.bsrRank}, weight=${retried.catalogData.weightLbs}, category=${retried.catalogData.bsrCategory}`, "retry");
            }
            const finalResult = retryError
              ? { ...retried, error: retryError }
              : retried;
            if (!allResults.has(asin)) {
              allResults.set(asin, finalResult);
              res.write(JSON.stringify({ type: "result", data: finalResult }) + "\n");
            } else {
              allResults.set(asin, finalResult);
              res.write(JSON.stringify({ type: "result", data: { ...finalResult, _update: true } }) + "\n");
            }
          }

          await delay(200);
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
          allResults.set(item.input.asin, errorResult);
          res.write(JSON.stringify({ type: "result", data: errorResult }) + "\n");
        }
      }
      if (uncalculated.length > 0) {
        log(`=== RETRY SUMMARY: ${uncalculated.length} ASINs still uncalculated: ${uncalculated.join(", ")} ===`, "retry");
      }
    }

    res.write(JSON.stringify({ type: "complete" }) + "\n");
    res.end();
  });

  return httpServer;
}
