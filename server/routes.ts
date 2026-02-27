import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { getPricing, getFees, getCatalogData } from "./spapi";
import { log } from "./index";
import { type AsinInput, type AsinResult } from "@shared/schema";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function parseFileToAsins(buffer: Buffer, filename: string): AsinInput[] {
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

  const asins: AsinInput[] = [];
  for (const row of rows) {
    const asinKey = Object.keys(row).find((k) => k.toLowerCase().trim() === "asin");
    const cogsKey = Object.keys(row).find((k) => k.toLowerCase().trim() === "cogs");
    const prepKey = Object.keys(row).find((k) => k.toLowerCase().trim() === "prep");
    const storageKey = Object.keys(row).find((k) => k.toLowerCase().trim() === "storage");

    if (!asinKey || !cogsKey) {
      throw new Error('File must contain "ASIN" and "COGS" columns.');
    }

    const asin = String(row[asinKey]).trim();
    const cogs = parseFloat(String(row[cogsKey]));

    let prepOverride: number | null = null;
    let storageOverride: number | null = null;

    if (prepKey && row[prepKey] !== undefined && row[prepKey] !== "") {
      const p = parseFloat(String(row[prepKey]));
      if (!isNaN(p)) prepOverride = p;
    }
    if (storageKey && row[storageKey] !== undefined && row[storageKey] !== "") {
      const s = parseFloat(String(row[storageKey]));
      if (!isNaN(s)) storageOverride = s;
    }

    if (asin && !isNaN(cogs)) {
      asins.push({ asin, cogs, prepOverride, storageOverride });
    }
  }

  if (asins.length === 0) {
    throw new Error("No valid ASIN/COGS rows found in the file.");
  }

  return asins;
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

async function fetchAsinData(
  asin: string,
  cogs: number,
  prepOverride: number | null,
  storageOverride: number | null,
  existingResult?: AsinResult,
  retryParts?: { fees: boolean; pricing: boolean; catalog: boolean },
): Promise<AsinResult> {
  const shouldFetchPricing = !retryParts || retryParts.pricing;
  const shouldFetchCatalog = !retryParts || retryParts.catalog;
  const shouldFetchFees = !retryParts || retryParts.fees;

  let pricingData = existingResult?.pricingData ?? {
    lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null as "FBA" | "FBM" | null,
    lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null,
    numberOfSellers: null, sellersFba: null, sellersFbm: null,
  };
  let catalogData = existingResult?.catalogData ?? {
    weightLbs: null, title: null, imageUrl: null, bsrRank: null, bsrCategory: null,
  };
  let feesData = existingResult?.feesData ?? {
    fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null,
  };

  const parallelCalls: Promise<void>[] = [];

  let pricingRestricted = false;

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

  if (shouldFetchFees) {
    const realPrice =
      pricingData.lowestFbaPrice ??
      pricingData.buyBoxPrice ??
      pricingData.lowestPrice;
    const bestPrice = realPrice ?? 15;
    const usedFallbackPrice = realPrice == null;

    if (usedFallbackPrice) {
      log(`No real price available for ${asin}, using fallback price $${bestPrice} for fee estimation`, "fees");
    }

    try {
      feesData = await getFees(asin, bestPrice);
      if (usedFallbackPrice && feesData.fbaFulfillmentFee != null) {
        log(`Discarding fee estimate for ${asin} because it was based on fallback price (got FBA=$${feesData.fbaFulfillmentFee})`, "fees");
        feesData = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
      }
    } catch (err: any) {
      log(`Fees error for ${asin}: ${err.message}`, "analyzer");
    }
  }

  let error: string | null = null;
  if (pricingRestricted && !hasValidPricing({ pricingData } as AsinResult)) {
    error = "Restricted - no pricing data available";
  } else if (!hasValidFees({ feesData } as AsinResult) && !hasValidPricing({ pricingData } as AsinResult)) {
    error = "No pricing or fee data available";
  }

  return {
    asin, cogs,
    prepOverride: prepOverride ?? null,
    storageOverride: storageOverride ?? null,
    pricingData, feesData, catalogData,
    error,
  };
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

  app.post("/api/parse-file", upload.single("file"), (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "No file uploaded" });
        return;
      }

      const asins = parseFileToAsins(req.file.buffer, req.file.originalname);
      const hasPrepOverrides = asins.some((a) => a.prepOverride != null);
      const hasStorageOverrides = asins.some((a) => a.storageOverride != null);
      log(`Parsed ${asins.length} ASINs from ${req.file.originalname} (prep overrides: ${hasPrepOverrides}, storage overrides: ${hasStorageOverrides})`, "parser");
      res.json({ asins, hasPrepOverrides, hasStorageOverrides });
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
    const retryQueue: { input: AsinInput; attempt: number; result: AsinResult }[] = [];

    for (let i = 0; i < asins.length; i++) {
      const { asin, cogs, prepOverride, storageOverride } = asins[i];

      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: i + 1, total: asins.length, asin },
        }) + "\n"
      );

      let result: AsinResult;

      try {
        result = await fetchAsinData(asin, cogs, prepOverride ?? null, storageOverride ?? null);
      } catch (err: any) {
        log(`Error processing ${asin}: ${err.message}`, "analyzer");
        result = {
          asin, cogs,
          prepOverride: prepOverride ?? null,
          storageOverride: storageOverride ?? null,
          pricingData: {
            lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null,
            lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null,
            numberOfSellers: null, sellersFba: null, sellersFbm: null,
          },
          feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
          catalogData: { weightLbs: null, title: null, imageUrl: null, bsrRank: null, bsrCategory: null },
          error: err.message || "Unknown error",
        };
      }

      const retryNeeded = needsRetry(result);
      const needsAnyRetry = retryNeeded.fees || retryNeeded.pricing || retryNeeded.catalog;
      if (needsAnyRetry) {
        retryQueue.push({ input: asins[i], attempt: 1, result });
        log(`Queued ${asin} for retry (fees=${retryNeeded.fees}, pricing=${retryNeeded.pricing}, catalog=${retryNeeded.catalog})`, "retry");
        if (!retryNeeded.fees && !retryNeeded.pricing) {
          allResults.set(asin, result);
          res.write(JSON.stringify({ type: "result", data: result }) + "\n");
        }
      } else {
        allResults.set(asin, result);
        res.write(JSON.stringify({ type: "result", data: result }) + "\n");
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
          const { asin, cogs, prepOverride, storageOverride } = item.input;
          const retryParts = needsRetry(item.result);

          try {
            log(`Retrying ${asin}: fees=${retryParts.fees}, pricing=${retryParts.pricing}, catalog=${retryParts.catalog}`, "retry");
            const retried = await fetchAsinData(
              asin, cogs, prepOverride ?? null, storageOverride ?? null,
              item.result, retryParts,
            );

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
          } catch (err: any) {
            log(`Retry error for ${asin}: ${err.message}`, "retry");
            if (attempt >= MAX_RETRIES) {
              const failNeeds = needsRetry(item.result);
              const missingParts: string[] = [];
              if (failNeeds.fees) missingParts.push("fees");
              if (failNeeds.pricing) missingParts.push("pricing");
              if (failNeeds.catalog) missingParts.push("BSR");
              const errorMsg = item.result.error?.includes("Restricted")
                ? "Restricted - no pricing data available"
                : `No data after ${attempt} retries (missing: ${missingParts.join(", ")})`;
              log(`EXHAUSTED ${asin}: ${errorMsg} | exception=${err.message}`, "retry");
              const errorResult: AsinResult = {
                ...item.result,
                error: errorMsg,
              };
              if (!allResults.has(asin)) {
                allResults.set(asin, errorResult);
                res.write(JSON.stringify({ type: "result", data: errorResult }) + "\n");
              } else {
                allResults.set(asin, errorResult);
                res.write(JSON.stringify({ type: "result", data: { ...errorResult, _update: true } }) + "\n");
              }
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
