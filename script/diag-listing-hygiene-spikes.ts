// DIAGNOSTIC ONLY — read-only. Listing-hygiene spikes a/b/c
// (spec-patch-listing-hygiene). No listing writes; spike c only requests a report.
// Usage: tsx script/diag-listing-hygiene-spikes.ts a <SKU> [<SKU>...] | b | c <days>
import "dotenv/config";
import axios from "axios";
import zlib from "zlib";
import fs from "fs";
import { spApiGet, spApiPost } from "../server/spapi-auth";

const MKT = "ATVPDKIKX0DER";
const sellerId = process.env.SP_API_SELLER_ID!;
const err = (e: any) => `HTTP ${e?.response?.status} -> ${JSON.stringify(e?.response?.data ?? e?.message)}`;

async function spikeA(skus: string[]) {
  for (const sku of skus) {
    console.log(`\n===== getListingsItem ${sku} includedData=summaries,attributes,offers =====`);
    try {
      const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`, {
        marketplaceIds: MKT, includedData: "summaries,attributes,offers",
      });
      console.log("summaries:", JSON.stringify(d?.summaries));
      console.log("offers:", JSON.stringify(d?.offers));
      console.log("purchasable_offer:", JSON.stringify(d?.attributes?.purchasable_offer, null, 2));
      console.log("fulfillment_availability:", JSON.stringify(d?.attributes?.fulfillment_availability));
    } catch (e) { console.log(err(e)); }
  }
}

async function spikeB() {
  let nextToken: string | undefined;
  let pages = 0, total = 0;
  const hits: any[] = [];
  let sample: any;
  do {
    const params: any = { granularityType: "Marketplace", granularityId: MKT, marketplaceIds: MKT, details: true };
    if (nextToken) params.nextToken = nextToken;
    const d = await spApiGet("/fba/inventory/v1/summaries", params);
    const rows: any[] = d?.payload?.inventorySummaries ?? [];
    pages++; total += rows.length;
    for (const r of rows) {
      sample ??= r;
      const u = r?.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0;
      if (u > 0) hits.push(r);
    }
    nextToken = d?.pagination?.nextToken;
  } while (nextToken && pages < 200);
  console.log(`pages=${pages} rows=${total} skusWithUnfulfillable=${hits.length}`);
  console.log("first row (shape):", JSON.stringify(sample, null, 2));
  for (const h of hits.slice(0, 3)) console.log("unfulfillable example:", JSON.stringify(h, null, 2));
  const rr = hits.filter((h) => (h?.inventoryDetails?.researchingQuantity?.totalResearchingQuantity ?? 0) > 0);
  if (rr[0]) console.log("researching example:", JSON.stringify(rr[0], null, 2));
}

async function spikeC(days: number) {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - (days - 1));
  const body = {
    reportType: "GET_LEDGER_SUMMARY_VIEW_DATA", marketplaceIds: [MKT],
    dataStartTime: start.toISOString(), dataEndTime: new Date(end.getTime() + 86399000).toISOString(),
    reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "DAILY" },
  };
  console.log("request:", JSON.stringify(body));
  let created: any;
  try { created = await spApiPost("/reports/2021-06-30/reports", body); } catch (e) { console.log("create:", err(e)); return; }
  const id = created.reportId; console.log("reportId", id);
  const deadline = Date.now() + 15 * 60_000;
  let docId: string | undefined, st: any;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    st = await spApiGet(`/reports/2021-06-30/reports/${id}`);
    if (st.processingStatus === "DONE") { docId = st.reportDocumentId; break; }
    if (st.processingStatus === "FATAL" || st.processingStatus === "CANCELLED") break;
  }
  console.log("status:", JSON.stringify(st));
  if (!docId) {
    if (st?.reportDocumentId) {
      const doc = await spApiGet(`/reports/2021-06-30/documents/${st.reportDocumentId}`);
      const r = await axios.get(doc.url, { responseType: "arraybuffer", timeout: 120_000 });
      let buf = Buffer.from(r.data); if (doc.compressionAlgorithm === "GZIP") buf = zlib.gunzipSync(buf);
      console.log("FATAL doc:", buf.toString("utf8").slice(0, 2000));
    }
    return;
  }
  const doc = await spApiGet(`/reports/2021-06-30/documents/${docId}`);
  const r = await axios.get(doc.url, { responseType: "arraybuffer", timeout: 120_000 });
  let buf = Buffer.from(r.data); if (doc.compressionAlgorithm === "GZIP") buf = zlib.gunzipSync(buf);
  const text = buf.toString("utf8");
  if (process.env.SPIKE_OUT) fs.writeFileSync(process.env.SPIKE_OUT, text);
  const lines = text.split("\n").filter((l) => l.trim());
  const unq = (v: string) => (v ?? "").replace(/^"|"$/g, "");
  const headers = lines[0].replace(/\r$/, "").split("\t").map(unq);
  console.log("headers:", JSON.stringify(headers));
  console.log("rows:", lines.length - 1);
  for (const l of lines.slice(1, 6)) console.log("row:", l);
  const idx = (n: string) => headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iD = idx("Date"), iF = idx("FNSKU"), iM = idx("MSKU"), iDisp = idx("Disposition"), iLoc = idx("Location");
  const keys = new Set<string>(), dates = new Set<string>(), disps = new Set<string>(), fnskus = new Set<string>(), mskus = new Set<string>(), locs = new Set<string>();
  let dup = 0;
  for (const l of lines.slice(1)) {
    const c = l.replace(/\r$/, "").split("\t").map(unq);
    const k = [c[iD], c[iF], c[iM], c[iDisp], c[iLoc]].join("|");
    if (keys.has(k)) dup++; keys.add(k);
    dates.add(c[iD]); disps.add(c[iDisp]); fnskus.add(c[iF]); mskus.add(c[iM]); locs.add(c[iLoc]);
  }
  console.log(`distinct dates=${dates.size} fnsku=${fnskus.size} msku=${mskus.size} dispositions=${JSON.stringify([...disps])} locations=${JSON.stringify([...locs])} dupKeys(date,fnsku,msku,disp,loc)=${dup}`);
  console.log(`date range: ${[...dates].sort()[0]} .. ${[...dates].sort().slice(-1)[0]}`);
}

const [mode, ...rest] = process.argv.slice(2);
(mode === "a" ? spikeA(rest) : mode === "b" ? spikeB() : spikeC(Number(rest[0] ?? 31)))
  .catch((e) => { console.error("FATAL", err(e)); process.exit(1); });
