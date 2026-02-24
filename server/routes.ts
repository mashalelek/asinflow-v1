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

    if (!asinKey || !cogsKey) {
      throw new Error('File must contain "ASIN" and "COGS" columns.');
    }

    const asin = String(row[asinKey]).trim();
    const cogs = parseFloat(String(row[cogsKey]));

    if (asin && !isNaN(cogs)) {
      asins.push({ asin, cogs });
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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
      log(`Parsed ${asins.length} ASINs from ${req.file.originalname}`, "parser");
      res.json({ asins });
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

    for (let i = 0; i < asins.length; i++) {
      const { asin, cogs } = asins[i];

      res.write(
        JSON.stringify({
          type: "progress",
          data: { current: i + 1, total: asins.length, asin },
        }) + "\n"
      );

      let result: AsinResult;

      try {
        const [pricingData, catalogData] = await Promise.all([
          getPricing(asin),
          getCatalogData(asin),
        ]);

        const bestPrice =
          pricingData.lowestFbaPrice ??
          pricingData.buyBoxPrice ??
          pricingData.lowestPrice ??
          15;

        const feesData = await getFees(asin, bestPrice);

        result = {
          asin,
          cogs,
          pricingData,
          feesData,
          catalogData,
          error: null,
        };
      } catch (err: any) {
        log(`Error processing ${asin}: ${err.message}`, "analyzer");
        result = {
          asin,
          cogs,
          pricingData: {
            lowestFbaPrice: null,
            buyBoxPrice: null,
            buyBoxFulfillment: null,
            lowestPrice: null,
            avg30DayPrice: null,
            avg90DayPrice: null,
            numberOfSellers: null,
          },
          feesData: { fbaFulfillmentFee: null, referralFee: null },
          catalogData: { weightLbs: null, title: null },
          error: err.message || "Unknown error",
        };
      }

      res.write(JSON.stringify({ type: "result", data: result }) + "\n");

      if ((i + 1) % BATCH_SIZE === 0 && i < asins.length - 1) {
        await delay(BATCH_DELAY);
      }
    }

    res.write(JSON.stringify({ type: "complete" }) + "\n");
    res.end();
  });

  return httpServer;
}
