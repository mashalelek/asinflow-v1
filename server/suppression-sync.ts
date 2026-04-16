import axios from "axios";
import { spApiGet, spApiPost } from "./spapi";
import { query } from "./db";
import { log } from "./index";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

export async function syncSuppressionData(): Promise<{ suppressed: number; cleared: number }> {
  log("Requesting FYP suppression report", "suppression-sync");

  // 1. Create report
  let createRes: any;
  try {
    createRes = await spApiPost("/reports/2021-06-30/reports", {
      reportType: "GET_MERCHANTS_LISTINGS_FYP_REPORT",
      marketplaceIds: [MARKETPLACE_ID],
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    log(`FYP report creation failed — HTTP ${status}: ${JSON.stringify(body)}`, "suppression-sync");
    throw new Error(`FYP report creation failed (${status}): ${JSON.stringify(body)}`);
  }

  const reportId: string = createRes.reportId;
  log(`FYP report created: ${reportId}`, "suppression-sync");

  // 2. Poll
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let reportDocumentId: string | undefined;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    const status: string = statusRes.processingStatus;
    if (status === "DONE") { reportDocumentId = statusRes.reportDocumentId; break; }
    if (status === "FATAL" || status === "CANCELLED") {
      throw new Error(`FYP report ${reportId} failed: ${status}`);
    }
  }

  if (!reportDocumentId) throw new Error(`FYP report ${reportId} timed out`);

  // 3. Download
  const docRes = await spApiGet(`/reports/2021-06-30/documents/${reportDocumentId}`);
  const downloadRes = await axios.get(docRes.url, { responseType: "text" });
  const rawData = typeof downloadRes.data === "string" ? downloadRes.data : String(downloadRes.data);
  const lines = rawData.split("\n").filter((l: string) => l.trim());

  if (lines.length < 2) {
    log("FYP report empty — no suppressed listings", "suppression-sync");
    // Clear all suppression flags
    const cleared = await query(`UPDATE asins SET is_search_suppressed = FALSE, suppression_reasons = NULL WHERE is_search_suppressed = TRUE`);
    return { suppressed: 0, cleared: cleared.rowCount ?? 0 };
  }

  // 4. Parse TSV
  const headers = lines[0].replace(/\r$/, "").split("\t");
  const col = (name: string) => {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(name.toLowerCase()));
    return idx;
  };

  const iSku = col("sku");
  const iAsin = col("asin");
  const iReason = col("reason");
  const iCondition = col("condition");

  log(`FYP headers: ${headers.join(", ")}`, "suppression-sync");
  log(`FYP column indices: sku=${iSku}, asin=${iAsin}, reason=${iReason}`, "suppression-sync");

  // Aggregate reasons per ASIN
  const suppressedAsins = new Map<string, string[]>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r$/, "").split("\t");
    const asin = iAsin >= 0 ? cols[iAsin]?.trim() : null;
    const reason = iReason >= 0 ? cols[iReason]?.trim() : null;

    if (!asin) continue;

    const existing = suppressedAsins.get(asin);
    if (existing) {
      if (reason && !existing.includes(reason)) existing.push(reason);
    } else {
      suppressedAsins.set(asin, reason ? [reason] : []);
    }
  }

  // 5. Update database
  // First clear all, then set suppressed ones
  await query(`UPDATE asins SET is_search_suppressed = FALSE, suppression_reasons = NULL WHERE is_search_suppressed = TRUE`);

  let suppressed = 0;
  for (const [asin, reasons] of Array.from(suppressedAsins.entries())) {
    const result = await query(
      `UPDATE asins SET is_search_suppressed = TRUE, suppression_reasons = $2 WHERE asin = $1`,
      [asin, JSON.stringify(reasons)]
    );
    if (result.rowCount && result.rowCount > 0) suppressed++;
  }

  log(`Suppression sync complete: ${suppressed} ASINs suppressed, ${suppressedAsins.size} in report`, "suppression-sync");
  return { suppressed, cleared: 0 };
}
