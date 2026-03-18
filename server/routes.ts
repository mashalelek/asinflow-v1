import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { getPricing, getFees, getCatalogData, estimateFeeFallback, getEligibility, type EligibilityResult } from "./spapi";
import { log } from "./index";
import { type AsinInput, type AsinResult, type ColumnMapping } from "@shared/schema";
import { validateUser } from "./auth";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
}

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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/register", (_req: Request, res: Response) => {
    res.status(403).json({ message: "Registration is closed" });
  });

  app.post("/api/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      if (!email || !password) {
        res.status(400).json({ message: "Email and password are required" });
        return;
      }
      const user = await validateUser(email, password);
      if (!user) {
        res.status(401).json({ message: "Invalid email or password" });
        return;
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      log(`User logged in: ${user.email} (id=${user.id})`, "auth");
      res.json({ id: user.id, email: user.email });
    } catch (err: any) {
      log(`Login error: ${err.message}`, "auth");
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.get("/api/logout", (req: Request, res: Response) => {
    const email = req.session.email;
    req.session.destroy((err) => {
      if (err) {
        log(`Logout error: ${err.message}`, "auth");
        res.status(500).json({ message: "Logout failed" });
        return;
      }
      res.clearCookie("connect.sid");
      log(`User logged out: ${email}`, "auth");
      res.json({ message: "Logged out" });
    });
  });

  app.get("/api/me", (req: Request, res: Response) => {
    if (req.session && req.session.userId) {
      res.json({ id: req.session.userId, email: req.session.email });
    } else {
      res.status(401).json({ message: "Not authenticated" });
    }
  });

  app.get("/api/credentials-status", requireAuth, (_req: Request, res: Response) => {
    const configured = !!(
      process.env.SP_API_CLIENT_ID &&
      process.env.SP_API_CLIENT_SECRET &&
      process.env.SP_API_REFRESH_TOKEN
    );
    res.json({ configured });
  });

  app.get("/api/download-template", requireAuth, (_req: Request, res: Response) => {
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

  app.post("/api/parse-file", requireAuth, upload.single("file"), (req: Request, res: Response) => {
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

  app.post("/api/parse-mapped", requireAuth, upload.single("file"), (req: Request, res: Response) => {
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

  app.post("/api/analyze", requireAuth, async (req: Request, res: Response) => {
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
      const input = asins[i];

      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: i + 1, total: asins.length, asin: input.asin },
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
          catalogData: { weightLbs: null, title: null, imageUrl: null, bsrRank: null, bsrCategory: null },
          eligibilityData: { status: "unknown", approvalUrl: null },
          error: err.message || "Unknown error",
        };
      }

      const retryNeeded = needsRetry(result);
      const needsAnyRetry = retryNeeded.fees || retryNeeded.pricing || retryNeeded.catalog;
      if (needsAnyRetry) {
        retryQueue.push({ input, attempt: 1, result });
        log(`Queued ${input.asin} for retry (fees=${retryNeeded.fees}, pricing=${retryNeeded.pricing}, catalog=${retryNeeded.catalog})`, "retry");
        if (!retryNeeded.fees && !retryNeeded.pricing) {
          allResults.set(input.asin, result);
          res.write(JSON.stringify({ type: "result", data: result }) + "\n");
        }
      } else {
        allResults.set(input.asin, result);
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
              if (!allResults.has(item.input.asin)) {
                allResults.set(item.input.asin, finalResult);
                res.write(JSON.stringify({ type: "result", data: finalResult }) + "\n");
              } else {
                allResults.set(item.input.asin, finalResult);
                res.write(JSON.stringify({ type: "result", data: { ...finalResult, _update: true } }) + "\n");
              }
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
              if (!allResults.has(item.input.asin)) {
                allResults.set(item.input.asin, errorResult);
                res.write(JSON.stringify({ type: "result", data: errorResult }) + "\n");
              } else {
                allResults.set(item.input.asin, errorResult);
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
