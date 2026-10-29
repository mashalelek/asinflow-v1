import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { getPricing, getFees, getCatalogData, estimateFeeFallback, getEligibility } from "./spapi";
import { getInboundHazmat } from "./inbound-hazmat";
import { closeAfterCreate } from "./listing-hygiene-run";
import { verifyPending, resolveSubmissionManual, resolveSubmissionsBulk, dismissFlags, getUnverifiedCount, listNeedsAttention, listInFlight, findRecentPendingIds, countOpenAmong } from "./listing-submissions-repo";
import { runAuraSyncChain } from "./aura-sync-chain";
import { probeGatingForAsins } from "./gating-probe";
import { loadPoAsinRows, normalizeLineQty } from "./po-queries";
import { loadAliases, resolveRetailer, setAlias } from "./supplier-aliases";
import { linkUnmatchedLine } from "./shipment-link";
import { likeContains, stripShipmentSuffix } from "./order-number";
import { clearExtraUnits } from "./extra-units";
import { velocityIneligible, ineligibleText } from "./shipment-match";
import { readVelocityStartDate } from "./ships-to-backfill";
import { evaluateAutoClose, setPoClosedManually, parseQtyInput, MANUAL_QTY_COLUMNS, type ManualQtyColumn } from "./po-close";
import { ACTION_ITEMS, DISPLAY_ACTION_ITEMS, REVIEW_VELOCITY, EXTRA_UNITS_SHIPPED, PACK_SIZE_MISSING, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, normalizeActionItems } from "./po-status-map";
import { asinWriteThrough, unionActionItems, PO_ACTION_ITEMS_SQL, REVIEW_VELOCITY_EXISTS_SQL, REVIEW_VELOCITY_REASONS_SQL, PACK_SIZE_MISSING_EXISTS_SQL, PACK_SIZE_MISMATCH_EXISTS_SQL, RECEIVING_MISMATCH_EXISTS_SQL, EXTRA_UNITS_EXISTS_SQL } from "./po-action-items";
import { editPoHeader, editLine, addLine, removeLine, editAsinRow, loadPoHistory, logEdits, changedFields, asLogText, EditError, type EditResult } from "./po-edit";
import { createPoFromForm, lookupAsins } from "./po-create";
import { loadPoGuards, deletePo, cancelPo, assertAsinRowCancelable, reassignShipment } from "./po-guards";
import { syncPoSheet, type PoSyncResult } from "./po-sheet-sync";
import { syncVelocityShipments, type VelocitySyncResult } from "./shipment-sync-velocity";
import { syncScShipments, type ScSyncResult } from "./shipment-sync-sc";
import { loadAsinPipeline, EMPTY_PIPELINE } from "./asin-po-pipeline";
import { log } from "./log";
import { type AsinInput, type AsinResult, type ColumnMapping, extractDomain, cleanBuyLink, getFeePriceForAsin, LEAD_SOURCES, normalizeLeadSource, type LeadSource } from "@shared/schema";
import { parseMoney } from "@shared/parse-money";
import pool, { query, isDbAvailable } from "./db";
import { loadSubmitRows, loadSettingsForSubmit } from "./offer-add-load";
import { runRelist } from "./relist";
import { syncInventory } from "./inventory-sync";
import { syncSalesData } from "./sales-sync";
import { syncSuppressionData } from "./suppression-sync";
import { loadAfAsinCostMap } from "./po-af-source";
import { buildVelocityRecords, serializeVelocityCsv, parseMDY, formatYMD, todayLocal } from "./velocity-export";
import { fetchAllKnownOrders, matchKeysForOrder, createBundleOrder, submitBulkCsv, updateInboundOrder } from "./velocity-api";
import { recordableBundles, recordBundleIdentities, mapBundleIdentity, hydrateChildlessBundles } from "./velocity-bundle-identity";
import { buildVelocityPlan, putBodyFromDiffs, type PlanUpdate } from "./velocity-reconcile";
import { buildSellerboardCogs, serializeSbCsv } from "./sellerboard-cogs";
import { buildSourcingCost, sourcingCostFilename, parseYMDLocal } from "./sourcing-cost";
import { recordSourcingCostExport, listSourcingCostExports } from "./sourcing-cost-repo";
import { syncSourcingSheet } from "./sourcing-sync";
import { refreshPrices } from "./price-sync";
import { runFeesStage } from "./refresh-job";
import { enqueueJob, enqueueOnboardingJob, findRecentSameOnboarding, ONBOARDING_DEDUPE_MINUTES } from "./scheduler/jobs-repo";
import { fetchCatalogBatch, fetchFeesBatch } from "./product-info-batch";
import { applyCatalogDeletedSignal } from "./catalog-deleted-write";
import { offerAddForAsin, preFilterSubmitSet, type OfferAddResult, type PreFilterResult } from "./offer-add";
import { submitOfferAddBatch, type SubmitAsinRow } from "./offer-add-submit";

import { runFullScopePass } from "./full-scope-pass";
import type { OnboardResolution } from "./sc-discovery";
import { writeLiveOfferVerdict } from "./live-offer-write";
import { makeProductRegistryRepo } from "./product-registry-repo";
import { processBulkApproval, makeProductionHandlers, type ApprovalItem } from "./sku-legend-approval";
import { settingsSchema, type Settings } from "@shared/schema";
import type { AnalyzeSink } from "./analyze-sink";
import { enqueueBulkRefresh, bulkRefreshStatus } from "./scheduler/bulk";
import { upsertTagsForAsin, TAG_COLORS } from "./tags-repo";
import { resolveRepricerRange as resolveRange } from "./repricer-range";
import { promoteBulkAsins } from "./bulk-promote";
import { rateLimitStats, rateLimitStatsSince } from "./spapi-rate-limit";
import {
  createBulkList,
  listBulkLists,
  getBulkListWithRows,
  renameBulkList,
  deleteBulkList,
  parseAddedAt,
} from "./bulk-lists";
import fs from "fs";


// Module-level handle to runAnalyzeCore (defined inside registerRoutes).
// Set during registerRoutes init so the sourcing-sync cron (which runs after
// registerRoutes resolves in server/index.ts) can invoke the analyzer without
// hoisting ~270 lines of function body out of registerRoutes.
// The sink parameter is REQUIRED, never defaulted: a defaulted sink is
// fail-open — a future call site that omits the argument would silently
// write to the live catalog, which is the single failure the §21 isolation
// exists to prevent. Every caller names its sink explicitly.
type RunAnalyzeCore = (
  asins: AsinInput[],
  emit: (chunk: string) => void,
  progressPrefix: (i: number) => string | null,
  fromCsvUpload: boolean,
  sink: AnalyzeSink,
  // §11 Product Info (2026-09-07): dryRun = zero writes — batch catalog +
  // fees are FETCHED and compared vs stored, gating/hazmat are LISTED (what
  // the 30-day rule would probe) but never probed, sink writes suppressed.
  opts?: { dryRun?: boolean },
) => Promise<void>;
let runAnalyzeCoreRef: RunAnalyzeCore | null = null;
type OnboardNewAsins = (asins: AsinInput[], emit: (chunk: string) => void, sink: AnalyzeSink, trigger: "upload" | "sourcing" | "extension" | "backfill" | "sc_discovery", progressPrefix?: (i: number) => string | null) => Promise<{ jobId: number | null }>;
let onboardNewAsinsRef: OnboardNewAsins | null = null;
export function getOnboardNewAsins(): OnboardNewAsins {
  if (!onboardNewAsinsRef) throw new Error("onboardNewAsins not initialized — call registerRoutes first");
  return onboardNewAsinsRef;
}
// Scheduler component 1 (SC discovery) onboards through the ONE insert path
// without importing this module: index.ts injects this into the runner.
let onboardScDiscoveriesRef: ((rows: OnboardResolution[]) => Promise<void>) | null = null;
let onboardSalesAsinsRef: ((asins: string[]) => Promise<void>) | null = null;
/** Injected into the runner for component 19 (sales): insert ASINs the orders report names that AF lacks. */
export function getOnboardSalesAsins(): (asins: string[]) => Promise<void> {
  if (!onboardSalesAsinsRef) throw new Error("onboardSalesAsins not initialized — call registerRoutes first");
  return onboardSalesAsinsRef;
}
export function getOnboardScDiscoveries(): (rows: OnboardResolution[]) => Promise<void> {
  if (!onboardScDiscoveriesRef) throw new Error("onboardScDiscoveries not initialized — call registerRoutes first");
  return onboardScDiscoveriesRef;
}
export function getRunAnalyzeCore(): RunAnalyzeCore {
  if (!runAnalyzeCoreRef) throw new Error("runAnalyzeCore not initialized — call registerRoutes first");
  return runAnalyzeCoreRef;
}

// cleanBuyLink moved to @shared/schema (2026-09-04) — shared with the §21
// bulk path. Imported above.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Long-sync response wrapper (2026-08-11). Buffered JSON responses send ZERO
// bytes until the sync finishes; Chrome aborts a byte-silent response around
// the 5-minute mark, so the client saw "Failed to fetch" (red "sync failed"
// toast) while the server kept working and later logged 200. This streams a
// heartbeat line every 15s to keep the connection alive, then one terminal
// {result} or {error} line — the client helper (lib/long-sync.ts) resolves on
// it. Guard-path failures (503/400 before work starts) stay plain JSON.
async function respondLongSync(res: Response, work: () => Promise<any>): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const hb = setInterval(() => {
    try { res.write(JSON.stringify({ type: "heartbeat" }) + "\n"); } catch { /* client gone — work continues */ }
  }, 15_000);
  try {
    const data = await work();
    res.write(JSON.stringify({ type: "result", data }) + "\n");
  } catch (err: any) {
    // Genuine sync failure: the server's error, verbatim, as the terminal line.
    res.write(JSON.stringify({ type: "error", message: err?.message ?? String(err) }) + "\n");
  } finally {
    clearInterval(hb);
    try { res.end(); } catch {}
  }
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
  // "estimated cogs" / "est cogs": the ASINs-page export's group-qualified
  // header (§6, 2026-10-03) — matchColumnName is an EXACT match on the
  // normalized header, so the qualified form needs its own alias or the
  // export does not re-import. "actual cogs" is deliberately absent: actual
  // COGS comes from the PO sheet and SellerBoard (§2), never a CSV upload.
  cogs: ["cogs", "cost", "cost of goods", "unit cost", "purchase price", "price paid", "buy cost", "estimated cogs", "est cogs", "est. cogs"],
  buyLink: ["buy link", "buylink", "buy url", "buyurl", "link", "url", "supplier link", "source link", "source url"],
  // "estimated prep cost": same qualified-header reason as cogs above.
  // "actual prep cost" deliberately absent — actuals are not CSV-sourced.
  prepCost: ["prep", "prep cost", "prepcost", "prep fee", "prepfee", "estimated prep cost", "est prep cost"],
  additionalFees: ["storage", "storage fee", "storagefee", "additional fees", "additionalfees", "additional fee", "extra fees", "misc", "misc fees", "other fees"],
  tags: ["tags", "tag"],
  notes: ["notes", "note", "comments", "comment"],
  // Supplier's own catalog/item number — never Amazon SKUs. "sku" is included
  // because on a supplier sheet a bare "SKU" column IS the supplier SKU; the
  // mapping modal confirmation is the guard against mis-mapping.
  supplierSku: ["supplier sku", "supplier_sku", "suppliersku", "sku", "item number", "item #", "item no", "vendor sku", "vendor item", "catalog number", "part number", "mpn"],
  // §21 bulk fields (2026-09-04). Broad aliases ("date"/"added") are safe
  // because matchColumnName is EXACT on the normalized header, never fuzzy.
  // Parsed on both paths; the main upload path ignores both (promos on the
  // main page come only from the sourcing sheet — SPEC §21 asymmetry note).
  promos: ["promos", "promo", "promo notes", "promonotes"],
  dateAdded: ["date added", "dateadded", "added", "date"],
};

function matchColumnName(header: string, field: string): boolean {
  const normalized = header.toLowerCase().trim();
  const aliases = COLUMN_NAME_ALIASES[field];
  if (!aliases) return false;
  return aliases.includes(normalized);
}

// cogsOptional (§21 bulk page only): the COGS column may be unmapped, and
// blank/unparseable COGS cells keep the row with cogs=0 instead of dropping
// it — a supplier catalog with ASINs and no costs is the normal starting
// case there. Default (false) preserves the main upload path exactly: COGS
// column required, rows with unparseable COGS skipped.
// §6 (2026-10-13): `defaultLeadSource` is the upload dialog's list-wide
// pick. A per-row lead_source CSV column OVERRIDES it — the file is more
// specific than the dropdown. An unrecognised cell falls back to the
// list-wide pick rather than to null, so one bad cell in a labelled upload
// does not silently lose the label.
function mapRowsToAsins(
  rows: Record<string, any>[],
  mapping: ColumnMapping,
  cogsOptional = false,
  defaultLeadSource: LeadSource | null = null,
): AsinInput[] {
  const asins: AsinInput[] = [];

  for (const row of rows) {
    if (!mapping.asin) continue;
    if (!mapping.cogs && !cogsOptional) continue;

    const asinVal = row[mapping.asin];
    const cogsVal = mapping.cogs ? row[mapping.cogs] : undefined;

    if (asinVal === undefined) continue;
    if (cogsVal === undefined && !cogsOptional) continue;

    const asin = String(asinVal).trim();
    const parsedCogs = cogsVal !== undefined ? parseMoney(cogsVal) : null;

    if (!asin) continue;
    if (parsedCogs == null && !cogsOptional) continue;

    const cogs = parsedCogs ?? 0;

    let buyLink: string | null = null;
    let prepOverride: number | null = null;
    let storageOverride: number | null = null;

    if (mapping.buyLink && row[mapping.buyLink] !== undefined && row[mapping.buyLink] !== "") {
      buyLink = String(row[mapping.buyLink]).trim();
    }
    if (mapping.prepCost && row[mapping.prepCost] !== undefined && row[mapping.prepCost] !== "") {
      const p = parseMoney(row[mapping.prepCost]);
      if (p != null) prepOverride = p;
    }
    if (mapping.additionalFees && row[mapping.additionalFees] !== undefined && row[mapping.additionalFees] !== "") {
      const s = parseMoney(row[mapping.additionalFees]);
      if (s != null) storageOverride = s;
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

    let supplierSku: string | null = null;
    if (mapping.supplierSku && row[mapping.supplierSku] !== undefined && row[mapping.supplierSku] !== "") {
      supplierSku = String(row[mapping.supplierSku]).trim().slice(0, 100) || null;
    }

    let promoNotes: string | null = null;
    if (mapping.promos && row[mapping.promos] !== undefined && row[mapping.promos] !== "") {
      promoNotes = String(row[mapping.promos]).trim() || null;
    }
    let addedAtRaw: string | null = null;
    if (mapping.dateAdded && row[mapping.dateAdded] !== undefined && row[mapping.dateAdded] !== "") {
      addedAtRaw = String(row[mapping.dateAdded]).trim() || null;
    }

    const rowLead = mapping.leadSource && row[mapping.leadSource] !== undefined
      ? normalizeLeadSource(row[mapping.leadSource])
      : null;
    asins.push({ asin, cogs, buyLink, prepOverride, storageOverride, tags, notes, supplierSku, promoNotes, addedAtRaw,
                 leadSource: rowLead ?? defaultLeadSource });
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
    throw new Error('File must contain "ASIN" and "COGS" (or "Est. COGS") columns.');
  }

  const tagsHeader = headers.find((h) => matchColumnName(h, "tags"));
  const notesHeader = headers.find((h) => matchColumnName(h, "notes"));
  const supplierSkuHeader = headers.find((h) => matchColumnName(h, "supplierSku"));

  const mapping: ColumnMapping = {
    asin: asinHeader,
    cogs: cogsHeader,
    buyLink: buyLinkHeader ?? null,
    prepCost: prepHeader ?? null,
    additionalFees: storageHeader ?? null,
    tags: tagsHeader ?? null,
    notes: notesHeader ?? null,
    supplierSku: supplierSkuHeader ?? null,
    promos: headers.find((h) => matchColumnName(h, "promos")) ?? null,
    dateAdded: headers.find((h) => matchColumnName(h, "dateAdded")) ?? null,
  };

  return mapRowsToAsins(rows, mapping);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Maps the submit orchestrator's SubmitOutcome → the OfferAddResult shape the
// preview dialog already understands. "would_submit" maps to "preview" (UI
// renders payload + sku); skip reasons collapse onto blocked outcome kinds.
function mapSubmitOutcomeToOfferAddResult(outcome: any): OfferAddResult {
  switch (outcome.kind) {
    case "would_submit":
      return {
        kind: "preview",
        asin: outcome.asin,
        sku: outcome.sku,
        reused: outcome.reused,
        payload: outcome.payload,
        // 18555-cap surfacing (SPEC §18 "Suppression cap")
        priceDetail: outcome.priceDetail,
        maxOrderQuantity: outcome.maxOrderQuantity,
        capApplied: outcome.capApplied,
        noPriceReference: outcome.noPriceReference,
        lowRoiAfterCap: outcome.lowRoiAfterCap,
        brandCode: outcome.brandCode,
        registry: outcome.registry,
        proposedNnn: outcome.proposedNnn,
        proposedTtl: outcome.proposedTtl,
      } as any;
    case "skipped":
      // Reverse-map skip reasons back to OfferAddResult shape
      switch (outcome.reason) {
        case "gated": return { kind: "gated", asin: outcome.asin, details: outcome.details };
        case "dead_asin": return { kind: "dead_asin", asin: outcome.asin, details: outcome.details };
        case "legend_pending": return { kind: "legend_pending", asin: outcome.asin, pending: outcome.pending ?? { brand: null, dept: null } as any, details: outcome.details };
        case "duplicate_warning": return { kind: "duplicate_warning", asin: outcome.asin, existingSku: "", statuses: [] };
        case "already_in_catalog": return { kind: "already_in_catalog", asin: outcome.asin, items: [] as any, details: outcome.details } as any;
        case "dg_value_unresolved": return { kind: "dg_value_unresolved", asin: outcome.asin, details: outcome.details };
        case "needs_cogs":
        case "offers_fetch_failed":
        case "unreachable_roi":
        case "nnn_overflow":
        case "resurrection_error":
        case "definitions_fetch_failed":
        case "catalog_deleted":
        case "not_checked":
        default:
          return { kind: "resurrection_error", asin: outcome.asin, reason: outcome.reason, details: outcome.details };
      }
    case "created":
    case "putlistings_failed":
      // Shouldn't happen in preview mode (phase4Mode="preview"), but pass through
      return outcome;
    default:
      return { kind: "resurrection_error", asin: outcome.asin, reason: "unknown", details: "unknown outcome" };
  }
}

// §19 auto verify after submit: one-shot in-process follow-up to a batch
// submit with ≥1 ACCEPTED submission — first scoped sweep ~10 min after
// submit, one retry ~30 min later for rows still open (async materialization
// lag; rehearsals settled by T+65 at the latest). Deliberately NOT a cron and
// NOT persisted: a restart before firing just leaves the rows in the pill for
// the manual sweep, which stays the fallback. Reuses verifyPending scoped to
// the batch's ledger ids — fail-closed semantics (throttle/not-yet-found
// writes nothing) and the has_live_offer 'live' transition come with it; no
// new writers.
// §19 probe ladder (2026-09-06): T+1m, +3m, +10m, +30m, +60m — each fires
// only while rows in scope are still open. verifyPending itself now writes
// has_live_offer = TRUE on ANY 200 for the submitted SKU (§18 one
// definition), so the icon flips on the first probe that sees the listing
// exist, independent of ledger materialization. Timers are in-process +
// unref'd; a restart loses them and the Refresh listings reconcile catches
// up.
const AUTO_VERIFY_LADDER_MS = [1, 3, 10, 30, 60].map((m) => m * 60 * 1000);
function scheduleBatchVerify(
  sellerId: string,
  pairs: Array<{ asin: string; sku: string }>,
  ladderMs: number[] = AUTO_VERIFY_LADDER_MS,
): void {
  findRecentPendingIds(pairs)
    .then((ids) => {
      if (ids.length === 0) {
        log(`Auto-verify: no pending ledger rows found for ${pairs.length} submitted pair(s) — nothing scheduled (manual sweep remains the fallback)`, "verify");
        return;
      }
      log(`Auto-verify ladder scheduled for ${ids.length} submission(s): ${ladderMs.map((ms) => `${Math.round(ms / 60000)}m`).join(", ")} (each only while rows stay open)`, "verify");
      const fire = (step: number) => {
        if (step >= ladderMs.length) return;
        const delay = ladderMs[step] - (step > 0 ? ladderMs[step - 1] : 0);
        const t = setTimeout(async () => {
          try {
            const s = await verifyPending(sellerId, { ids, closeAfterCreate: (r) => closeAfterCreate(query as any, sellerId, r) });
            log(`Auto-verify probe ${step + 1}/${ladderMs.length} (${ids.length} scoped): checked=${s.checked} live=${s.live} failed=${s.failed} processing=${s.processing} stale=${s.stale} throttled=${s.throttled}`, "verify");
            const open = await countOpenAmong(ids);
            if (open === 0) {
              log(`Auto-verify: all ${ids.length} resolved after probe ${step + 1} — ladder stopped`, "verify");
              return;
            }
            if (step + 1 < ladderMs.length) {
              log(`Auto-verify: ${open} still open — next probe at T+${Math.round(ladderMs[step + 1] / 60000)}m`, "verify");
            } else {
              log(`Auto-verify: ${open} still open after the full ladder — left for the pill / manual sweep`, "verify");
            }
            fire(step + 1);
          } catch (err: any) {
            log(`Auto-verify probe ${step + 1} error (ladder continues): ${err.message}`, "verify");
            fire(step + 1);
          }
        }, delay);
        t.unref?.();
      };
      fire(0);
    })
    .catch((err: any) => log(`Auto-verify scheduling error (manual sweep remains the fallback): ${err.message}`, "verify"));
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
    // Product Info no longer fetches prices (§11, 2026-09-07) — stored
    // prices may legitimately be null (never synced / no_offers), so
    // pricing NEVER queues a retry. Fees skipped for lack of a price are
    // likewise not retryable (feesSkippedNoPrice tracked separately).
    fees: !hasValidFees(result) && !(result as any)._feesSkippedNoPrice,
    pricing: false,
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
  eligibilityData: AsinResult["eligibilityData"],
): AsinResult {
  // Since 2026-09-07 Product Info doesn't fetch prices — a missing stored
  // price is a STATE, not an error. The old synthesized strings ("Price
  // unavailable…" and the no-pricing-or-fees variant) were persisted into
  // asin_estimates.error by the sink and survived later conclusive price
  // writes, poisoning the Sale Price cell into "⚠ Error" on rows with
  // perfectly good prices (2026-09-09 incident; migration 041 cleared the
  // 188 stale rows). Only genuine failures set error now.
  let error: string | null = null;
  if (pricingRestricted && !hasValidPricing({ pricingData } as AsinResult)) {
    error = "Restricted - no pricing data available";
  }

  // Analyze only refreshes Amazon-side data. Cost fields (estimatedCogs,
  // actualCogs, prepOverride) are NOT set here — the frontend re-fetches
  // from /api/asins after analyze to get the DB-authoritative values.
  return {
    asin: input.asin,
    cogs: input.cogs, // deprecated, kept for backward compat
    estimatedCogs: null,
    actualCogs: null,
    buyLink: input.buyLink ?? null,
    prepOverride: null,
    storageOverride: null,
    // User-controlled (§14): rides through to the asins INSERT branch only —
    // the ON CONFLICT branch never touches it, so re-analyze can't write it.
    supplierSku: input.supplierSku ?? null,
    pricingData, feesData, catalogData,
    eligibilityData,
    error,
  };
}

// getFeePriceForAsin moved to @shared/schema (2026-09-07) — shared with the
// Prices & Stock fees stage. Imported above.

/**
 * Dedicated write path for CSV-uploaded COGS values. Runs BEFORE the
 * analyze UPSERT so estimated_cogs is populated regardless of whether
 * the ASIN is new or existing. This is separate from the analyze UPSERT
 * which only touches Amazon-side pricing/fees and never user-controlled
 * cost fields.
 */
async function upsertCsvCogs(asin: string, cogs: number): Promise<void> {
  // Try UPDATE first (existing ASIN)
  const updated = await query(
    `UPDATE asin_estimates SET estimated_cogs = $2, estimated_cogs_source = 'csv'
     WHERE asin = $1`,
    [asin, cogs],
  );
  if ((updated.rowCount ?? 0) === 0) {
    // New ASIN — INSERT will be handled by upsertAsinResult below,
    // which includes estimated_cogs in its INSERT branch
  }
}

async function upsertAsinResult(
  result: AsinResult,
  notesForNewInsert: string | null = null,
  promoNotesForNewInsert: string | null = null,
  // §6 lead source, INSERT branch only (§14). Absent = NULL, which is what
  // §18 phase c wants: an SC-discovered ASIN has no lead source AF can claim.
  leadSourceForNewInsert: LeadSource | null = null,
  // Scheduler v1 onboarding (2026-10-15): rows only. Existing rows keep
  // their last_refreshed_at; asin_estimates is INSERT ... DO NOTHING; no
  // history row, no catalog-deleted signal. The queued job does the rest.
  insertOnly = false,
): Promise<{ inserted: boolean }> {
  const supplier = extractDomain(result.buyLink);

  // Asymmetric UPSERT for notes + promo_notes (same pattern as estimated_cogs
  // below):
  //   INSERT branch    — writes both from the CSV/sourcing input.
  //   ON CONFLICT UPDATE — neither in the SET list (§14 ownership preserved).
  // Existing-ASIN notes get appended (with dedup) by writeResult based on the
  // `inserted` boolean returned from RETURNING (xmax = 0). promo_notes has NO
  // append path — existing ASINs keep their prior value untouched.
  const asinUpsert = await query(
    `INSERT INTO asins (asin, title, image_url, brand, category, weight_lb, buy_link, supplier, is_meltable, is_hazmat, is_dangerous_good, notes, promo_notes, supplier_sku, lead_source, last_refreshed_at)
     -- §18 (2026-09-24): NULLIF(TRIM(...)) so a blank catalog brand is stored
     -- as NULL, never "". An empty-string brand is what let the legend build a
     -- row keyed on "" and swallow every brandless ASIN into one code.
     -- $15 lead_source: INSERT-BRANCH ONLY. It is absent from the ON CONFLICT
     -- SET list below, so a re-analyze of an existing ASIN never touches it
     -- (§14 user-controlled — only the INSERT paths and the inline edit write
     -- it, and a sync must not overwrite a human's answer).
     VALUES ($1, $2, $3, NULLIF(TRIM($4::text), ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
     ON CONFLICT (asin) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, asins.title),
       image_url = COALESCE(EXCLUDED.image_url, asins.image_url),
       brand = COALESCE(EXCLUDED.brand, asins.brand),
       category = COALESCE(EXCLUDED.category, asins.category),
       weight_lb = COALESCE(EXCLUDED.weight_lb, asins.weight_lb),
       buy_link = COALESCE(EXCLUDED.buy_link, asins.buy_link),
       supplier = COALESCE(EXCLUDED.supplier, asins.supplier),
       is_meltable = EXCLUDED.is_meltable OR asins.is_meltable,
       -- Latest INBOUND hazmat result wins. NULL = inconclusive (throttle/error)
       -- → keep prior value, don't wipe. Same fail-closed contract for DG.
       is_hazmat = COALESCE(EXCLUDED.is_hazmat, asins.is_hazmat),
       is_dangerous_good = COALESCE(EXCLUDED.is_dangerous_good, asins.is_dangerous_good),
       last_refreshed_at = CASE WHEN $16::boolean THEN asins.last_refreshed_at ELSE NOW() END
     RETURNING (xmax = 0) AS inserted`,
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
      // tri-state: true | false | null(inconclusive → COALESCE keeps prior)
      (result.catalogData as any).isHazmat ?? null,
      (result.catalogData as any).isDangerousGood ?? null,
      notesForNewInsert, // $12 — used in INSERT; ignored by UPDATE
      promoNotesForNewInsert, // $13 — used in INSERT; ignored by UPDATE
      result.supplierSku ?? null, // $14 — user-controlled (§14): INSERT branch only, never in the ON CONFLICT SET list
      leadSourceForNewInsert, // $15 — §6, same INSERT-branch-only contract
      insertOnly,             // $16 — keep last_refreshed_at on an existing row
    ]
  );
  const inserted = asinUpsert.rows[0]?.inserted === true;

  // DA-2: catalog-deleted signal + auto-archive on FALSE→TRUE transition.
  // Single source of truth lives in server/catalog-deleted-write.ts so the
  // bulk backfill script can't drift from the live analyze write.
  // Tri-state input: null = inconclusive (no write), true/false = definitive.
  if (!insertOnly) {
    await applyCatalogDeletedSignal(
      result.asin,
      (result.catalogData as any).isCatalogDeleted ?? null,
    ).catch((err: any) =>
      log(`catalog-deleted write error for ${result.asin}: ${err.message}`, "db"),
    );
  }

  // Asymmetric UPSERT: INSERT populates estimated_cogs from the CSV upload
  // input (result.cogs). ON CONFLICT UPDATE only refreshes Amazon-side pricing/
  // fees — never touches estimated_cogs, actual_cogs, or other user-controlled
  // cost fields. This is an architectural smell: CSV upload piggybacks on the
  // analyze UPSERT to persist COGS. TODO: separate CSV write path from analyze.
  // Fee triple + fee_source write gate (migration 026): 'spapi' always wins;
  // 'fallback' only fills missing fees or refreshes a prior 'fallback' — it
  // never overwrites a real fee ('spapi' or legacy-NULL rows, which predate
  // the marker and are presumed real after the fingerprint backfill). The
  // three fee fields + source move as ONE coherent block, keyed on the
  // incoming fba_fee (all-null error shapes write nothing, as before).
  await query(
    `INSERT INTO asin_estimates (
       asin, estimated_cogs, estimated_cogs_source,
       lowest_fba_price, buy_box_price, buy_box_fulfillment, lowest_price,
       sellers_fba, sellers_fbm, fba_fee, referral_fee, fees_estimate_price, fee_source,
       bsr, bsr_category, eligibility_status, error, fetched_at
     ) VALUES ($1,$2,'csv',$3,$4,$5,$6,$7,$8,$9,$10,$11,$16,$12,$13,$14,$15,NOW())
     ${insertOnly ? "ON CONFLICT (asin) DO NOTHING" : `ON CONFLICT (asin) DO UPDATE SET
       lowest_fba_price = COALESCE(EXCLUDED.lowest_fba_price, asin_estimates.lowest_fba_price),
       buy_box_price = COALESCE(EXCLUDED.buy_box_price, asin_estimates.buy_box_price),
       buy_box_fulfillment = COALESCE(EXCLUDED.buy_box_fulfillment, asin_estimates.buy_box_fulfillment),
       lowest_price = COALESCE(EXCLUDED.lowest_price, asin_estimates.lowest_price),
       sellers_fba = COALESCE(EXCLUDED.sellers_fba, asin_estimates.sellers_fba),
       sellers_fbm = COALESCE(EXCLUDED.sellers_fbm, asin_estimates.sellers_fbm),
       fba_fee = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fba_fee ELSE asin_estimates.fba_fee END,
       referral_fee = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.referral_fee ELSE asin_estimates.referral_fee END,
       fees_estimate_price = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fees_estimate_price ELSE asin_estimates.fees_estimate_price END,
       fee_source = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fee_source ELSE asin_estimates.fee_source END,
       bsr = COALESCE(EXCLUDED.bsr, asin_estimates.bsr),
       bsr_category = COALESCE(EXCLUDED.bsr_category, asin_estimates.bsr_category),
       eligibility_status = EXCLUDED.eligibility_status,
       error = EXCLUDED.error,
       fetched_at = NOW()`}`,
    [
      result.asin,
      result.cogs, // $2 — only used in INSERT (new ASIN), ignored by UPDATE
      result.pricingData.lowestFbaPrice, result.pricingData.buyBoxPrice,
      result.pricingData.buyBoxFulfillment, result.pricingData.lowestPrice,
      result.pricingData.sellersFba, result.pricingData.sellersFbm,
      result.feesData.fbaFulfillmentFee, result.feesData.referralFee, result.feesData.feesEstimatePrice,
      result.catalogData.bsrRank, result.catalogData.bsrCategory,
      result.eligibilityData?.status, result.error,
      result.feesData.feeSource ?? null, // $16 — fee provenance, gated with the fee block
    ]
  );

  // Record history snapshot for seller/price/BSR trends
  if (insertOnly) return { inserted };
  const salePrice = result.pricingData.lowestFbaPrice ?? result.pricingData.buyBoxPrice ?? result.pricingData.lowestPrice;
  const idRow = await query(`SELECT id FROM asins WHERE asin = $1`, [result.asin]);
  if (idRow.rows.length > 0) {
    await query(
      `INSERT INTO asin_estimates_history (asin_id, sellers_fba, sellers_fbm, sale_price, bsr) VALUES ($1, $2, $3, $4, $5)`,
      [idRow.rows[0].id, result.pricingData.sellersFba, result.pricingData.sellersFbm, salePrice, result.catalogData.bsrRank]
    ).catch(() => {});
  }

  return { inserted };
}

// upsertTagsForAsin + TAG_COLORS moved to server/tags-repo.ts (2026-09-09).

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

// Main-catalog persistence sink: the historical writes, verbatim.
// Fire-and-forget — persistResult launches the promise chain and returns
// immediately, exactly as the old inline writeResult DB block did. The §21
// bulk page passes makeBulkListSink instead. Exported so out-of-module
// callers (sourcing-sync cron) can name it explicitly — the sink parameter
// is required everywhere, never defaulted.
export const mainCatalogSink: AnalyzeSink = {
  persistResult(result, { fromCsvUpload, inputNotes, inputPromoNotes, inputLeadSource, insertOnly }) {
    if (!isDbAvailable()) return Promise.resolve();
    // If this is a CSV upload with user-provided COGS, persist estimated_cogs
    // via the dedicated write path BEFORE the analyze UPSERT. This ensures
    // estimated_cogs is set for both new and existing ASINs.
    const csvCogsPromise = fromCsvUpload && result.cogs > 0
      ? upsertCsvCogs(result.asin, result.cogs).catch((err: any) => log(`CSV COGS write error for ${result.asin}: ${err.message}`, "db"))
      : Promise.resolve();
    // RETURNED (2026-09-27), not dropped: writeResult awaits this so the tag
    // write is ordered behind the asins INSERT. Errors stay logged-and-
    // swallowed here exactly as before — this promise reports COMPLETION,
    // not success.
    return csvCogsPromise.then(async () => {
      // For CSV/sourcing of a brand-new ASIN, notes + promo_notes go in
      // atomically via the INSERT branch of upsertAsinResult — eliminates the
      // race against appendNotesForAsin that lost ~152 notes in a recent
      // 7-day window.
      const notesForInsert = fromCsvUpload ? inputNotes : null;
      const promoNotesForInsert = fromCsvUpload ? inputPromoNotes : null;
      // §6: always passed, not gated on fromCsvUpload — the sourcing sync and
      // bulk promote supply it too, and it is INSERT-branch-only in the SQL.
      const leadSourceForInsert = inputLeadSource;
      const { inserted } = await upsertAsinResult(result, notesForInsert, promoNotesForInsert, leadSourceForInsert, insertOnly === true);
      // Existing-ASIN path: dedup-aware append. Skipped when the row was just
      // inserted (notes already written by the INSERT branch above).
      // promo_notes: intentionally NO existing-ASIN write — insert-only.
      if (!inserted && inputNotes) {
        await appendNotesForAsin(result.asin, inputNotes);
      }
    }).catch((err: any) => log(`DB upsert error for ${result.asin}: ${err.message}`, "db"));
  },
  persistTags(asin, tagNames) {
    if (!isDbAvailable()) return Promise.resolve();
    // NOT fire-and-forget (fixed 2026-09-27). The old version launched this
    // alongside the asins INSERT and swallowed the result. upsertTagsForAsin
    // opens with `SELECT id FROM asins` and returns silently when the row is
    // absent, so for a BRAND-NEW ASIN the lookup reliably won the race and
    // every CSV tag was dropped — with no error anywhere. Existing ASINs were
    // unaffected, which is why this looked intermittent rather than broken.
    // writeResult now awaits persistResult before calling this, and the
    // rejection propagates so the caller can report it (§14 honest labeling).
    return upsertTagsForAsin(asin, tagNames);
  },
  async persistProbeStamps(asin, which) {
    if (!isDbAvailable()) return;
    // Built from `which` rather than always setting both: a failed probe
    // must not move its stamp (§11), and a NULL-valued SET would move it to
    // NULL rather than leave it alone.
    const sets: string[] = [];
    if (which.gating) sets.push("gating_checked_at = NOW()");
    if (which.hazmat) sets.push("hazmat_checked_at = NOW()");
    if (sets.length === 0) return;
    const r = await query(`UPDATE asins SET ${sets.join(", ")} WHERE asin = $1`, [asin]);
    // Zero rows is the old bug, not a success. pg reports no error for an
    // UPDATE that matches nothing, so without this check moving the write
    // after the INSERT would still fail silently the day the INSERT itself
    // fails (persistResult logs-and-swallows its own errors).
    if (r.rowCount === 0) {
      throw new Error(`no asins row for ${asin} — stamp(s) ${sets.join(", ")} not written`);
    }
  },
};

// Which probe stamps this ASIN earned, plus how to report a failed write.
// Carried to writeResult rather than written at the probe site: the probe
// runs before the row exists for a brand-new ASIN (§14, 2026-10-09).
type ProbeStampWrite = {
  gating: boolean;
  hazmat: boolean;
  onError: (msg: string) => void;
};

// One per-ASIN unit of work: emit, persist the row, THEN apply the tags it
// was given. Tags live here rather than at the call sites so every persist
// path — first pass, retry `_update`, exhausted final sweep — orders them
// behind the INSERT identically; the 2026-09-27 bug was a tag write that sat
// outside this unit and raced it. Same contract as bulk-promote.ts: a tag
// failure is reported against that ASIN, never a silent success without tags.
async function writeResult(
  emit: (chunk: string) => void,
  allResults: Map<string, AsinResult>,
  asin: string,
  result: AsinResult,
  isUpdate = false,
  fromCsvUpload = false,
  inputNotes: string | null = null,
  inputPromoNotes: string | null = null,
  sink: AnalyzeSink,
  inputTags: string[] | null = null,
  stamps: ProbeStampWrite | null = null,
  // §6 lead source, INSERT branch only. Rides here with tags and notes for
  // the same reason they do: one per-ASIN unit of work, one ordering.
  inputLeadSource: LeadSource | null = null,
  // Scheduler v1 onboarding: rows only, no Amazon data (see upsertAsinResult).
  insertOnly = false,
): Promise<void> {
  allResults.set(asin, result);
  emit(JSON.stringify({ type: "result", data: isUpdate ? { ...result, _update: true } : result }) + "\n");
  await sink.persistResult(result, { fromCsvUpload, inputNotes, inputPromoNotes, inputLeadSource, insertOnly });
  // Probe stamps ride here for the same reason tags do: ordered BEHIND the
  // asins INSERT (§14, 2026-10-09). The failure is reported against the
  // probe's own stage via onError — the probe succeeded, but the record does
  // not show it, so `updated` would be a lie.
  if (stamps && (stamps.gating || stamps.hazmat)) {
    try {
      await sink.persistProbeStamps(asin, { gating: stamps.gating, hazmat: stamps.hazmat });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      log(`Probe stamp write FAILED for ${asin}: ${msg}`, "db");
      stamps.onError(msg);
    }
  }
  if (!inputTags || inputTags.length === 0) return;
  try {
    await sink.persistTags(asin, inputTags);
  } catch (err: any) {
    const msg = `row written; tag write FAILED for ${asin} (${inputTags.join(", ")}): ${err?.message ?? err}`;
    log(msg, "db");
    emit(JSON.stringify({ type: "progress", data: { current: 0, total: 0, asin: `⚠ ${msg}` } }) + "\n");
  }
}

async function runSheetsSync(
  asinFilter?: ReadonlySet<string>,
): Promise<{ updated: number; skipped: number; errors: string[]; cleared: number; clearedAsins: string[] }> {
  // Source = the AF PO tables (patch po-af-owned §2.4, 2026-10-18): the
  // newest non-canceled ASIN row per ASIN (order_date, then entry_seq). The
  // Orders sheet is intake-only and is no longer read here.
  const { data: sheetData, rowsRead: rawRowsRead } = await loadAfAsinCostMap(query as any, asinFilter && asinFilter.size > 0 ? Array.from(asinFilter) : undefined);
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [asin, data] of Array.from(sheetData.entries())) {
    if (asinFilter && asinFilter.size > 0 && !asinFilter.has(asin)) {
      skipped++;
      continue;
    }
    try {
      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;
      // Per-ASIN branch trace (2026-08-11): the csv-freeze diagnosis had to
      // reconstruct these decisions from DB side-effects — log them instead.
      let actBranch = "no-cogs";
      let estBranch = "no-cogs";
      if (data.cogs != null) {
        // ALWAYS overwrite actual_cogs from PO — §2, enforced 2026-08-30.
        // actual_cogs is PO-sync-only; the old cogs_source='manual' guard let
        // a phantom marker (manual + NULL value) block this write forever
        // (B0G4XGFX1Z). Manual-override semantics live on estimated_cogs ONLY.
        setClauses.push(`cogs = $${idx++}`, `cogs_source = $${idx++}`, `actual_cogs = $${idx++}`);
        values.push(data.cogs, "po_sheet", data.cogs);
        actBranch = "written";
      }
      // Est. COGS auto-sync (§2, corrected 2026-08-11): overwrite with the PO
      // value (source → 'po_sheet') UNLESS the source is 'manual'. csv/imported
      // yield to PO — CSV seeds pre-purchase estimates, a PO row is ground
      // truth. The old po_sheet/NULL-only check silently froze csv rows.
      if (data.cogs != null) {
        const estCheck = await query(`SELECT estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [asin]);
        const estSource = estCheck?.rows?.[0]?.estimated_cogs_source;
        if (estSource !== "manual") {
          setClauses.push(`estimated_cogs = $${idx++}`, `estimated_cogs_source = $${idx++}`);
          values.push(data.cogs, "po_sheet");
          estBranch = `written(was:${estSource ?? "null"})`;
        } else {
          estBranch = "skipped:manual";
        }
      }
      // Prep cost from PO sheet (Col AS)
      if (data.prepCost != null) {
        setClauses.push(`prep_override = $${idx++}`);
        values.push(data.prepCost);
      }
      // ordered_qty is NOT written any more (patch asins-on-order-from-pos
      // §3.4, 2026-10-17): the ASINs page derives On Order / Pipeline from
      // the PO tables. The column stays in place, unread, until a cleanup
      // migration drops it. A row the sheet gives no cost or prep for has
      // nothing left to write.
      if (setClauses.length === 0) { skipped++; continue; }
      values.push(asin);

      const result = await query(
        `UPDATE asin_estimates SET ${setClauses.join(", ")} WHERE asin = $${idx}`,
        values
      );
      if ((result.rowCount ?? 0) > 0) {
        updated++;
        log(`PO sync ${asin}: cogs=${data.cogs ?? "-"} actual=${actBranch} est=${estBranch} prep=${data.prepCost ?? "-"}`, "sheets");
      } else skipped++;

      // Update supplier on asins table if available
      if (data.supplier) {
        await query(`UPDATE asins SET supplier = COALESCE(supplier, $2) WHERE asin = $1`, [asin, data.supplier]);
      }
    } catch (err: any) {
      errors.push(`${asin}: ${err.message}`);
    }
  }

  // The ordered_qty clearing pass (SPEC §11, 2026-08-23) is gone with the
  // column's last writer (2026-10-17): nothing reads asin_estimates.
  // ordered_qty any more. `cleared` / `clearedAsins` stay in the result
  // shape for the callers (toast, component 9 ledger) and are always 0.
  // rawRowsRead keeps its fail-closed meaning for the read itself.
  if (rawRowsRead === 0) log(`PO sync: rawRowsRead=0 — no PO rows in AF (nothing written)`, "sheets");
  const clearedAsins: string[] = [];
  return { updated, skipped, errors, cleared: clearedAsins.length, clearedAsins };
}

// Getter so the Aura sync chain (a separate module) can invoke the exact same
// PO sync the /api/sheets/sync route uses — one shared implementation, no
// divergence. Mirrors getRunAnalyzeCore; leaves runSheetsSync itself untouched
// and avoids a routes ↔ aura-sync-chain import cycle at module-load time.
export function getRunSheetsSync() {
  return runSheetsSync;
}

/** ASINs list: latest inventory snapshot per ASIN (LATERAL + LIMIT 1 on idx_inventory_latest). Exported for tests. */
export const LATEST_INVENTORY_SQL = `
  SELECT a.asin, i.available_fba, i.reserved, i.inbound_shipped, i.inbound_receiving
    FROM asins a
    CROSS JOIN LATERAL (
      SELECT s.available_fba, s.reserved, s.inbound_shipped, s.inbound_receiving
        FROM inventory_snapshots s
       WHERE s.asin_id = a.id
       ORDER BY s.snapshot_at DESC
       LIMIT 1
    ) i`;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Purchase Orders module (Phase 2). All /api/pos and /api/pos/:id/line-items
  // routes live in po-routes.ts to keep this file from growing further.

  // POST /api/verify-password (APP_PASSWORD) was removed with auth v1
  // (SPEC §25, 2026-10-14): nothing called it, and it answered valid:true
  // whenever the variable was unset. Login is POST /api/auth/login in
  // server/auth.ts.

  app.get("/api/credentials-status", (_req: Request, res: Response) => {
    const configured = !!(
      process.env.SP_API_CLIENT_ID &&
      process.env.SP_API_CLIENT_SECRET &&
      process.env.SP_API_REFRESH_TOKEN
    );
    res.json({ configured });
  });

  // §23 data-as-of (2026-09-15). Crons are OFF (§11) — every input to the
  // zero-sales view is only as fresh as the last manual Prices & Stock run,
  // and stale data must be VISIBLE rather than silently manufacturing
  // "zero sales". notYetChecked counts ASINs that pass every OTHER condition
  // but were never probed (has_buyable_offer IS NULL): excluded from the rows
  // (fail-closed) and shown in plain sight so they are never silently gone.
  // §23 (2026-09-16): pure resolution + clamp lives in repricer-range.ts;
  // this only supplies the coverage start from the DB.
  async function resolveRepricerRange(fromRaw?: string, toRaw?: string) {
    let coverageStart: string | null = null;
    try {
      const r = await query(`SELECT MIN(sale_date)::text AS s FROM sales_daily`);
      coverageStart = r.rows[0]?.s ?? null;
    } catch { coverageStart = null; }
    return resolveRange(coverageStart, fromRaw, toRaw);
  }

  async function repricerMeta(range: { from: string; to: string }) {
    const one = async (sql: string, params?: any[]) => {
      try { return (await query(sql, params)).rows[0] ?? {}; } catch { return {}; }
    };
    const sales = await one(`SELECT MAX(sale_date)::text AS through FROM sales_daily`);
    const inv = await one(`SELECT MAX(snapshot_at) AS as_of FROM inventory_snapshots`);
    const listings = await one(`SELECT MAX(buyable_checked_at) AS as_of FROM asins WHERE status = 'active'`);
    const runs = await one(`
      SELECT MAX(finished_at) FILTER (WHERE stage = 'sales')     AS sales_run,
             MAX(finished_at) FILTER (WHERE stage = 'inventory') AS inventory_run,
             MAX(finished_at) FILTER (WHERE stage = 'listings')  AS listings_run
        FROM refresh_runs WHERE scope NOT LIKE 'bulk:%'`);
    const unprobed = await one(`
      SELECT COUNT(*)::int AS n FROM asins a
       WHERE a.status = 'active'
         AND a.has_buyable_offer IS NULL
         AND COALESCE((
           SELECT i.available_fba FROM inventory_snapshots i
            WHERE i.asin_id = a.id ORDER BY i.snapshot_at DESC LIMIT 1
         ), 0) > 0
         AND COALESCE((
           SELECT SUM(s.units_sold) FROM sales_daily s
            WHERE s.asin_id = a.id
              AND s.sale_date >= $1::date
              AND s.sale_date <= $2::date
         ), 0) = 0`, [range.from, range.to]);
    const iso = (v: any) => (v ? new Date(v).toISOString() : null);
    return {
      freshness: {
        salesThrough: sales.through ?? null,
        salesRunAt: iso(runs.sales_run),
        inventoryAsOf: iso(inv.as_of),
        inventoryRunAt: iso(runs.inventory_run),
        listingsCheckedAt: iso(listings.as_of),
        listingsRunAt: iso(runs.listings_run),
      },
      notYetChecked: unprobed.n ?? 0,
    };
  }

  // Main AsinFlow: load all ASINs joined with estimates, inventory, sales, tags, deltas.
  //
  // ONE row builder, two routes (§23, 2026-09-15): the Repricer zero-sales
  // view renders the SAME table with the SAME column semantics, so it
  // delegates here with a server-side pre-filter rather than duplicating 260
  // lines of payload assembly. opts.repricerZeroSales adds the §23 WHERE
  // conditions and wraps the response with freshness + the unprobed count.
  async function listAsinsHandler(
    req: Request,
    res: Response,
    opts: { repricerZeroSales?: boolean } = {},
  ) {
    if (!isDbAvailable()) { res.json(opts.repricerZeroSales ? { rows: [], freshness: null, notYetChecked: 0 } : []); return; }
    try {
      // §14 parked/dead (2026-09-07): Show parked / Show dead are separate
      // view-scope toggles; includeArchived kept as a legacy alias for
      // includeParked (old clients / scripts).
      const { startDate, endDate, includeArchived, includeParked, includeDead } = req.query as Record<string, string | undefined>;
      // Row refresh (2026-10-18): ?asins=A,B,… returns just those rows — what a
      // finished job reloads (the rows of its scope that are on screen) instead
      // of the whole list. Capped; ASIN-shaped values only.
      const subset = typeof req.query.asins === "string"
        ? Array.from(new Set(req.query.asins.split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{10}$/.test(x)))).slice(0, 500)
        : null;
      if (subset && subset.length === 0) { res.json([]); return; }
      // Appended to each per-ASIN query as `AND a.asin = ANY($n::text[])`.
      const onlyA = (n: number) => (subset ? ` AND a.asin = ANY($${n}::text[])` : "");
      const withSubset = (params: any[]) => (subset ? [...params, subset] : params);
      const statuses = ["'active'"];
      if (includeParked === "true" || includeArchived === "true") statuses.push("'parked'");
      if (includeDead === "true") statuses.push("'dead'");
      let activeFilter = `a.status IN (${statuses.join(", ")})`;
      const repRange = opts.repricerZeroSales
        ? await resolveRepricerRange(req.query.from as string | undefined, req.query.to as string | undefined)
        : null;
      if (opts.repricerZeroSales) {
        // §23 SC-Active + at-FBA stock + zero 7-day sales. Status hygiene is
        // forced to 'active' regardless of the toggles (parked/dead never
        // appear here). NULL has_buyable_offer is EXCLUDED — never-probed is
        // not evidence of BUYABLE — and surfaced as "not yet checked" instead.
        activeFilter = `a.status = 'active'
          AND a.has_buyable_offer = TRUE
          AND COALESCE((
            SELECT i.available_fba FROM inventory_snapshots i
             WHERE i.asin_id = a.id ORDER BY i.snapshot_at DESC LIMIT 1
          ), 0) > 0
          AND COALESCE((
            SELECT SUM(s.units_sold) FROM sales_daily s
             WHERE s.asin_id = a.id
               -- Interpolated, not bound: both values are either regex-
               -- validated ISO dates or DB-derived (coverage start), never
               -- raw user input. resolveRepricerRange is the only producer.
               AND s.sale_date >= '${repRange!.effective.from}'::date
               AND s.sale_date <= '${repRange!.effective.to}'::date
          ), 0) = 0`;
        // Range entirely outside sales coverage: refuse rather than return
        // every ASIN as "no sales" (§23 coverage guard).
        if (repRange!.noCoverage) activeFilter = `FALSE`;
      }

      const result = await query(`
        SELECT
          a.asin, a.title, a.image_url, a.brand, a.category, a.weight_lb, a.buy_link, a.status, a.status_reason,
          a.primary_sku, a.has_live_offer, a.offer_checked_at, a.current_issues, a.issues_checked_at, a.notes, a.promo_notes, a.supplier_sku, a.lead_source, a.is_meltable, a.is_hazmat, a.is_dangerous_good, a.is_search_suppressed, a.suppression_reasons, a.last_reviewed_at, a.added_at, a.is_wholesale, a.is_oa,
          e.cogs, e.cogs_source, e.actual_cogs, e.estimated_cogs, e.estimated_cogs_source, e.prep_override, e.storage_override,
          e.lowest_fba_price, e.buy_box_price, e.buy_box_fulfillment, e.lowest_price,
          e.sellers_fba, e.sellers_fbm,
          e.fba_fee, e.referral_fee, e.fees_estimate_price, e.fee_source,
          e.bsr, e.bsr_category, e.eligibility_status, e.error,
          e.fetched_at
        FROM asins a
        LEFT JOIN asin_estimates e ON e.asin = a.asin
        WHERE ${activeFilter}${onlyA(1)}
        ORDER BY a.last_refreshed_at DESC NULLS LAST
      `, withSubset([]));

      // Latest inventory snapshot per ASIN: one index probe per ASIN on
      // idx_inventory_latest (asin_id, snapshot_at DESC) — never the whole
      // history. The DISTINCT ON form it replaced read every snapshot (286,677
      // rows on production, +~2,000 per hourly pass) to keep ~1,940: 2.6–3.3 s.
      const invResult = await query(subset ? `${LATEST_INVENTORY_SQL} WHERE a.asin = ANY($1::text[])` : LATEST_INVENTORY_SQL, withSubset([])).catch(() => ({ rows: [] as any[] }));
      const invMap = new Map<string, any>();
      for (const row of invResult.rows) invMap.set(row.asin, row);
      // On-order figures from the PO tables (patch asins-on-order-from-pos
      // §2): one query, folded per ASIN; the sheet's ordered_qty is not read.
      const pipelineMap = await loadAsinPipeline((sql, params) => query(sql, params), subset ?? undefined);

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
          WHERE s.sale_date >= $1 AND s.sale_date <= $2${onlyA(3)}
          GROUP BY a.asin
        `, withSubset([startDate, endDate])).catch(() => ({ rows: [] as any[] }));
        for (const row of salesResult.rows) salesMap.set(row.asin, row);

        const disResult = await query(`
          SELECT a.asin, COUNT(DISTINCT DATE(i.snapshot_at)) AS days_in_stock
          FROM inventory_snapshots i
          JOIN asins a ON a.id = i.asin_id
          WHERE i.snapshot_at >= $1::date AND i.snapshot_at <= ($2::date + 1) AND i.available_fba > 0${onlyA(3)}
          GROUP BY a.asin
        `, withSubset([startDate, endDate])).catch(() => ({ rows: [] as any[] }));
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
        FROM asins a WHERE a.status = 'active'${onlyA(1)}
      `, withSubset([])).catch(() => ({ rows: [] as any[] }));
      const deltaMap = new Map<string, any>();
      for (const row of deltaResult.rows) deltaMap.set(row.asin, row);

      // SKUs per ASIN
      const skusResult = await query(`
        SELECT a.asin, s.sku FROM asin_skus s
        JOIN asins a ON a.id = s.asin_id
        WHERE a.status = 'active'${onlyA(1)} ORDER BY s.is_primary DESC, s.sku
      `, withSubset([])).catch(() => ({ rows: [] as any[] }));
      const skusMap = new Map<string, string[]>();
      for (const row of skusResult.rows) {
        const arr = skusMap.get(row.asin) ?? [];
        arr.push(row.sku);
        skusMap.set(row.asin, arr);
      }

      // §6 Submission column: full ledger per ASIN, newest first. history[0]
      // = latest (drives the badge); the rest is tooltip history. Read-only —
      // this endpoint never writes the ledger. listing_submissions_asin_idx
      // covers the lookup; the whole table is one small scan here.
      const subsResult = await query(`
        SELECT asin, sku, verify_status, submitted_at, verified_at, issues,
               review_flags, terminal_conflict, flags_acknowledged_at
          FROM listing_submissions
         ${subset ? "WHERE asin = ANY($1::text[])" : ""}
         ORDER BY asin, submitted_at DESC
      `, withSubset([])).catch(() => ({ rows: [] as any[] }));
      const subsMap = new Map<string, any[]>();
      for (const row of subsResult.rows) {
        const arr = subsMap.get(row.asin) ?? [];
        arr.push({
          sku: row.sku,
          status: row.verify_status,
          submittedAt: row.submitted_at,
          verifiedAt: row.verified_at,
          issues: (row.issues ?? []).map((i: any) => ({
            code: String(i?.code ?? ""), severity: String(i?.severity ?? ""), message: String(i?.message ?? ""),
          })),
          reviewFlags: row.review_flags ?? [],
          terminalConflict: row.terminal_conflict === true,
          acknowledged: row.flags_acknowledged_at != null,
        });
        subsMap.set(row.asin, arr);
      }

      // Tags per ASIN
      const tagsResult = await query(`
        SELECT a.asin, t.name, t.color FROM asin_tags at
        JOIN tags t ON t.id = at.tag_id
        JOIN asins a ON a.id = at.asin_id
        WHERE a.status = 'active'${onlyA(1)}
        ORDER BY a.asin, t.name
      `, withSubset([])).catch(() => ({ rows: [] as any[] }));
      const tagsMap = new Map<string, { name: string; color: string }[]>();
      for (const row of tagsResult.rows) {
        const arr = tagsMap.get(row.asin) ?? [];
        arr.push({ name: row.name, color: row.color });
        tagsMap.set(row.asin, arr);
      }

      const asinResults: AsinResult[] = result.rows.map((row: any) => {
        const inv = invMap.get(row.asin);
        const sales = salesMap.get(row.asin);

        // Always populate the stock object. When there is no inventory
        // snapshot yet (ASIN never seen in Seller Central / never synced),
        // the FBA-side fields are 0 but the PO-derived On Order still
        // surfaces — so Stock reads as "0 available + N on order" instead of
        // a "-" that would be dropped by numeric filters. hasSnapshot lets
        // the client distinguish "not synced yet" from a confirmed zero.
        // Stock total adds On Order; Amazon's own inbound (Sent to FBA)
        // covers the shipped-not-received units (pre-flight P2).
        const pl = pipelineMap.get(row.asin) ?? EMPTY_PIPELINE;
        const stock = inv ? {
          available_fba: parseInt(inv.available_fba) || 0,
          reserved: parseInt(inv.reserved) || 0,
          inbound: (parseInt(inv.inbound_shipped) || 0) + (parseInt(inv.inbound_receiving) || 0),
          on_order: pl.on_order, at_prep: pl.at_prep, open_po_count: pl.open_po_count,
          total: (parseInt(inv.available_fba) || 0) +
                 (parseInt(inv.reserved) || 0) +
                 (parseInt(inv.inbound_shipped) || 0) +
                 (parseInt(inv.inbound_receiving) || 0) +
                 pl.on_order,
          hasSnapshot: true,
        } : {
          available_fba: 0,
          reserved: 0,
          inbound: 0,
          on_order: pl.on_order, at_prep: pl.at_prep, open_po_count: pl.open_po_count,
          total: pl.on_order,
          hasSnapshot: false,
        };

        // §6 FBA Stock (2026-09-17): computed ONCE here, from the same two
        // values the Stock and On Order cells render, so the on-screen
        // identity holds and sort/filter/CSV/render all read one number.
        // A no-snapshot row is total = on_order, so this is 0 — never negative.
        const fbaStock = stock.total - stock.on_order;

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
          cogs: parseFloat(row.cogs) || 0, // deprecated — use estimatedCogs/actualCogs
          estimatedCogs: row.estimated_cogs != null ? parseFloat(row.estimated_cogs) : null,
          estimatedCogsSource: row.estimated_cogs_source ?? null,
          actualCogs: row.actual_cogs != null ? parseFloat(row.actual_cogs) : null,
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
          hasLiveOffer: row.has_live_offer ?? null,
          offerCheckedAt: row.offer_checked_at ?? null,
          currentIssues: row.current_issues ?? null,
          issuesCheckedAt: row.issues_checked_at ?? null,
          tags: tagsMap.get(row.asin) ?? [],
          submission: subsMap.has(row.asin)
            ? { latest: subsMap.get(row.asin)![0], history: subsMap.get(row.asin)! }
            : null,
          notes: row.notes ?? null,
          promoNotes: row.promo_notes ?? null,
          supplierSku: row.supplier_sku ?? null,
          leadSource: row.lead_source ?? null,
          // parked keeps the old archived styling; dead renders its own tag.
          isArchived: row.status === 'parked',
          status: row.status ?? 'active',
          statusReason: row.status_reason ?? null,
          isMeltable: row.is_meltable ?? false,
          // Tri-state preserved: NULL = unchecked (renders as muted dash, never
          // a green "No"). Do NOT coerce to false — that would hide unknowns.
          isHazmat: row.is_hazmat ?? null,
          isDangerousGood: row.is_dangerous_good ?? null,
          isSearchSuppressed: row.is_search_suppressed ?? false,
          suppressionReasons: row.suppression_reasons ?? [],
          cogsSource: (row.cogs_source as "po_sheet" | "manual" | null) ?? null,
          fbaStock,
          pricesFetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
          feeSource: row.fee_source ?? null,
          lastReviewedAt: row.last_reviewed_at ? new Date(row.last_reviewed_at).toISOString() : null,
          addedAt: row.added_at ? new Date(row.added_at).toISOString() : null,
          category: row.category ?? null,
          isWholesale: row.is_wholesale ?? false,
          isOa: row.is_oa ?? false,
          sellersDelta: d ? {
            fba_7d: curFba != null && d.fba_7d_old != null ? curFba - parseInt(d.fba_7d_old) : null,
            fba_30d: curFba != null && d.fba_30d_old != null ? curFba - parseInt(d.fba_30d_old) : null,
            fbm_7d: curFbm != null && d.fbm_7d_old != null ? curFbm - parseInt(d.fbm_7d_old) : null,
            fbm_30d: curFbm != null && d.fbm_30d_old != null ? curFbm - parseInt(d.fbm_30d_old) : null,
          } : null,
        };
      });

      if (opts.repricerZeroSales) {
        res.json({
          rows: asinResults,
          ...(await repricerMeta(repRange!.effective)),
          range: repRange,
        });
        return;
      }
      res.json(asinResults);
    } catch (err: any) {
      log(`GET /api/asins error: ${err.message}`, "db");
      res.status(500).json({ message: err.message });
    }
  }

  app.get("/api/asins", (req: Request, res: Response) => listAsinsHandler(req, res));

  // §23 Repricer Phase 1b (2026-09-15) — zero-sales view. Same table, same
  // columns, backend-filtered. Read-only.
  app.get("/api/repricer/zero-sales", (req: Request, res: Response) =>
    listAsinsHandler(req, res, { repricerZeroSales: true }));

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
        `INSERT INTO asins (asin, title, brand, image_url, category, weight_lb, length_in, width_in, height_in, buy_link)
         -- §18 (2026-09-24): blank brand -> NULL, never "" (see the analyze upsert).
         VALUES ($1, $2, NULLIF(TRIM($3::text), ''), $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (asin) DO UPDATE SET
           title = COALESCE($2, asins.title),
           brand = COALESCE(NULLIF(TRIM($3::text), ''), asins.brand),
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
               estimated_cogs = COALESCE($2, estimated_cogs),
               estimated_cogs_source = CASE WHEN $2 IS NOT NULL THEN 'manual' ELSE estimated_cogs_source END,
               buy_box_price = COALESCE($3, buy_box_price),
               sellers_fba = COALESCE($4, sellers_fba),
               sellers_fbm = COALESCE($5, sellers_fbm)
             WHERE id = $1`,
            [
              existing.rows[0].id,
              hasCogs ? parseFloat(cogs) : null,
              sale_price ?? null,
              sellers_fba ?? null,
              sellers_fbm ?? null,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO asin_estimates (asin, estimated_cogs, estimated_cogs_source, buy_box_price, sellers_fba, sellers_fbm)
             VALUES ($1, $2, 'manual', $3, $4, $5)`,
            [
              asin,
              hasCogs ? parseFloat(cogs) : null,
              sale_price ?? null,
              sellers_fba ?? null,
              sellers_fbm ?? null,
            ]
          );
        }
      }

      // §11 onboarding (2026-09-09): a NEW row from the extension has only
      // the page-scraped buy-box price and no fees — run the shared
      // onboarding fire-and-forget (one ASIN ≈ seconds; the extension's
      // response must stay fast). Errors log; the row exists either way.
      if (wasInserted && onboardNewAsinsRef) {
        void onboardNewAsinsRef([{ asin, cogs: 0 } as AsinInput], () => {}, mainCatalogSink, "extension")
          .catch((err: any) => log(`Extension onboarding failed for ${asin}: ${err?.message ?? err}`, "refresh"));
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
      const headerRow = ["ASIN", "Est. COGS", "Buy Link", "Prep Cost", "Additional Fees"];
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

      // Opt-in COGS-optional mode (§21 bulk page only). Default: exactly the
      // historical behavior — ASIN and COGS mappings both required.
      const allowMissingCogs = String(req.body?.allowMissingCogs ?? "").toLowerCase() === "true";
      // §6: the dialog's list-wide pick. Blank = none, which leaves
      // lead_source NULL unless a per-row column supplies one.
      const defaultLeadSource = normalizeLeadSource(req.body?.leadSource);

      if (!mapping.asin || (!mapping.cogs && !allowMissingCogs)) {
        res.status(400).json({ message: "ASIN and COGS column mappings are required" });
        return;
      }

      const { rows } = parseFileToRawRows(req.file.buffer, req.file.originalname);
      const asins = mapRowsToAsins(rows, mapping, allowMissingCogs, defaultLeadSource);

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
  // ── One Refresh job (SPEC §11 "Refresh job & price refresh v2", 2026-09-06) ──
  // Folds inventory + sales + prices + listings into one NDJSON stream of
  // stages. Scope = the explicit asins list (what is on screen — decision 7).
  // The scheduled pass is a job on the queue now (scheduler/schedule.ts);
  // nothing calls runRefreshJob any more.
  app.post("/api/refresh", async (req: Request, res: Response) => {
    // Scheduler v1 (2026-10-15): thin enqueuer for one more release, then
    // deleted. The client calls POST /api/jobs directly.
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const job = await enqueueJob({ trigger: "manual", includeDaily: false, scopeAsins: asins?.length ? asins : null, requestedBy: req.session?.userId ?? null });
    res.status(202).json({ job, deprecated: "POST /api/jobs" });
  });

  // Run history for the results dialog's clock icon (migration 032).
  app.get("/api/refresh/history", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const r = await query(
        `SELECT id, started_at, finished_at, trigger, stage, scope, requested, counts, outcomes, error
           FROM refresh_runs ORDER BY started_at DESC LIMIT 60`,
      );
      res.json({ runs: r.rows });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/inventory/sync", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const filter = asins && asins.length > 0 ? new Set(asins) : undefined;
    await respondLongSync(res, async () => {
      try {
        return await syncInventory(filter);
      } catch (err: any) {
        log(`Inventory sync error: ${err.message}`, "inventory-sync");
        throw err;
      }
    });
  });

  app.post("/api/sales/sync", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { startDate, endDate, asins } = req.body as { startDate?: string; endDate?: string; asins?: string[] };
    if (!startDate || !endDate) {
      res.status(400).json({ message: "startDate and endDate are required" });
      return;
    }
    const filter = asins && asins.length > 0 ? new Set(asins) : undefined;
    await respondLongSync(res, async () => {
      try {
        return await syncSalesData(startDate, endDate, filter);
      } catch (err: any) {
        log(`Sales sync error: ${err.message}`, "sales-sync");
        throw err;
      }
    });
  });

  // Sync POs (patch docs/claude_spec-patch-po-sheet-sync.md §4, 2026-10-16):
  // the Orders-sheet → PO-module sync runs FIRST over the whole sheet, then
  // the existing per-ASIN COGS/ordered-qty sync for the working set. If the
  // PO sync fails the per-ASIN sync still runs and the result carries both
  // outcomes (`poSync.error`). `?dryRun=true` runs only the PO sync's plan
  // and writes nothing at all. Inline, off the queue (rule C).
  app.post("/api/sheets/sync", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!credPath || !fs.existsSync(credPath)) {
      res.status(400).json({ message: "Google credentials file not found" });
      return;
    }
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) { res.status(400).json({ message: "GOOGLE_SHEET_ID not configured" }); return; }
    const dryRun = String(req.query.dryRun ?? "") === "true";
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const filter = asins && asins.length > 0 ? new Set(asins) : undefined;
    await respondLongSync(res, async () => {
      let poSync: PoSyncResult | { error: string };
      try {
        poSync = await syncPoSheet({ sheetId, dryRun });
        const c = poSync.counts;
        log(`PO sync ${dryRun ? "DRY RUN" : poSync.wrote ? "live" : "STOPPED"}: sheet ${c.sheetPos}, insert ${c.inserted}, update ${c.updated}, unchanged ${c.unchanged}, lines deleted ${c.linesDeleted}, po_asins deleted ${c.poAsinsDeleted}, kept(shipments) ${c.poAsinsKeptWithShipments}, canceled kept ${c.canceledKeptOrderedQty}, canceled 0/0 ${c.canceledNoOrderedQty}, in AF not in sheet ${c.posInAfNotInSheet}, unmapped ${c.unmappedTokens}${poSync.stop ? ` — STOP: ${poSync.stop}` : ""}`, "sheets");
      } catch (err: any) {
        log(`PO sync error: ${err.message}`, "sheets");
        poSync = { error: err?.message ?? String(err) };
      }
      if (dryRun) return { dryRun: true, updated: 0, skipped: 0, errors: [], cleared: 0, clearedAsins: [], poSync };
      try {
        const asinSync = await runSheetsSync(filter);
        return { ...asinSync, poSync };
      } catch (err: any) {
        log(`Sheets sync error: ${err.message}`, "sheets");
        throw err;
      }
    });
  });

  // Insert-only sync from the sourcing Google Sheet. AF is source of truth —
  // pre-existing ASINs are skipped (no archive, no update, no analyze).
  // Streams NDJSON: { type: "sync_summary" } first with the plan, then the
  // standard analyze stream (progress + result) for new ASINs, then complete.
  // Manual trigger for the PO → Aura cost-sync chain. Same shared function the
  // aura-sync cron calls (server/aura-sync-chain.ts), so they can't diverge.
  app.post("/api/sync/aura", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.AURA_API_KEY) { res.status(400).json({ message: "AURA_API_KEY not configured" }); return; }
    await respondLongSync(res, async () => {
      try {
        return await runAuraSyncChain(); // PO read (hard dep, inline) → Aura live push
      } catch (err: any) {
        // PO read failure aborts the chain before any Aura push (stale-cost guard).
        throw new Error(`Aura sync chain failed: ${err?.message ?? err}`);
      }
    });
  });

  // Push to Aura (selection-aware). Decision 9 (2026-10-13): reads the PO
  // sheet for the selection FIRST, then pushes the same selection — the same
  // hard dependency the full chain has; the only difference is the scope.
  // INLINE since 2026-10-16 (a sheet read + COGS upsert is not SP-API refresh
  // work and never waits on the scheduled pass): no jobs row. No selection =
  // every PO cost and every Aura-mapped SKU, i.e. the chain. Since po-af-owned
  // §2.4 (2026-10-18) the cost read is the AF PO tables, so only the Aura key
  // gates it — no Google sheet / credentials needed.
  app.post("/api/sync/aura/push", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.AURA_API_KEY) { res.status(400).json({ message: "AURA_API_KEY not configured" }); return; }
    // Optional selection filter (same body shape as /api/sheets/sync).
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const asinFilter = asins && asins.length > 0 ? new Set(asins) : undefined;
    await respondLongSync(res, async () => {
      try {
        const r = await runAuraSyncChain({ asinFilter });
        const sk = r.aura.skipped;
        const skipped = sk.unmapped_sku + sk.ambiguous_sku + sk.null_cogs + sk.zero_cost;
        return { pushed: r.aura.pushed, unchanged: r.aura.unchanged, failed: r.aura.failed, skipped, notInAura: r.aura.notInAura, poSync: r.poSync };
      } catch (err: any) {
        throw new Error(`Aura push failed: ${err?.message ?? err}`);
      }
    });
  });

  // Velocity prep-service upload export (phase 1: CSV). Rows come from the AF
  // PO tables (po-af-owned §2.4, 2026-10-18); no Google sheet gate.
  app.get("/api/export/velocity-upload", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    const today = todayLocal();
    const fromStr = (req.query.from as string) || "";
    const toStr = (req.query.to as string) || "";
    const from = fromStr ? parseMDY(fromStr) : today;
    const to = toStr ? parseMDY(toStr) : today;
    if (from === null || to === null) { res.status(400).json({ message: "from/to must be M/D/YYYY" }); return; }
    const dryRun = ["1", "true"].includes(String(req.query.dryRun ?? "").toLowerCase());

    try {
      const { records, selfPrepExcluded, skips, effectiveFrom, clamped, rangeBeforeFloor } = await buildVelocityRecords(from, to);
      if (rangeBeforeFloor) {
        res.status(400).json({ message: `range_before_floor: entire range ${formatYMD(from)}..${formatYMD(to)} is before VELOCITY_MIN_ORDER_DATE — no Velocity records can be created for it`, rangeBeforeFloor: true });
        return;
      }
      const skipsByReason = skips.reduce((a, s) => { a[s.reason] = (a[s.reason] || 0) + 1; return a; }, {} as Record<string, number>);
      const clampNote = clamped ? ` (requested ${formatYMD(from)}..${formatYMD(to)}, clamped to ${formatYMD(effectiveFrom)}..${formatYMD(to)} by floor)` : "";
      log(`Velocity export ${formatYMD(effectiveFrom)}..${formatYMD(to)}: ${records.length} records, ${selfPrepExcluded} self-prep excluded, ${skips.length} skips ${JSON.stringify(skipsByReason)}${clampNote}`, "velocity-export");

      if (dryRun) {
        res.json({ from: formatYMD(from), to: formatYMD(to), effectiveFrom: formatYMD(effectiveFrom), clamped, records: records.length, selfPrepExcluded, skipCount: skips.length, skipsByReason, skips });
        return;
      }
      const csv = serializeVelocityCsv(records);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=velocity-upload-${formatYMD(to)}.csv`);
      res.send(csv);
    } catch (err: any) {
      log(`Velocity export error: ${err?.message ?? err}`, "velocity-export");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Velocity API delivery (phase 2, SPEC §11): POST because it writes to an
  // external system. Flow: build → guards → dedup (Velocity-as-truth) →
  // submitBulkCsv. &dryRun=1 does everything EXCEPT the POST.
  app.post("/api/upload/velocity", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.VELOCITY_API_KEY) { res.status(400).json({ message: "VELOCITY_API_KEY not configured" }); return; }
    if (!process.env.VELOCITY_WAREHOUSE_ID) { res.status(400).json({ message: "VELOCITY_WAREHOUSE_ID not configured" }); return; }

    const today = todayLocal();
    const fromStr = (req.query.from as string) || "";
    const toStr = (req.query.to as string) || "";
    const from = fromStr ? parseMDY(fromStr) : today;
    const to = toStr ? parseMDY(toStr) : today;
    if (from === null || to === null) { res.status(400).json({ message: "from/to must be M/D/YYYY" }); return; }
    const dryRun = ["1", "true"].includes(String(req.query.dryRun ?? "").toLowerCase());

    try {
      const { records, selfPrepExcluded, skips, effectiveFrom, clamped, rangeBeforeFloor } = await buildVelocityRecords(from, to);
      if (rangeBeforeFloor) {
        res.status(400).json({ message: `range_before_floor: entire range ${formatYMD(from)}..${formatYMD(to)} is before VELOCITY_MIN_ORDER_DATE — creation refused (reconciliation, not upload, audits existing orders)`, rangeBeforeFloor: true });
        return;
      }
      const skipsByReason = skips.reduce((a, s) => { a[s.reason] = (a[s.reason] || 0) + 1; return a; }, {} as Record<string, number>);

      // Dedup — Velocity is the truth. Key: (order_number exact-string,
      // asin case-insensitive), both trimmed. Orders deleted in Velocity are
      // absent from the list, so re-upload needs no special handling.
      const dedupKey = (orderNumber: string, asin: string) =>
        `${orderNumber.trim()}\u0000${asin.trim().toUpperCase()}`;
      // COMPLETE coverage (2026-08-11): dedup against /inbound + /inventory +
      // shipment details — a completed order must never re-send as a CREATE.
      const existing = await fetchAllKnownOrders();
      const existingKeys = new Set(
        existing.map((o) => dedupKey(String(o.order_number ?? ""), String(o.asin ?? ""))),
      );
      const toSend = records.filter((r) => !existingKeys.has(dedupKey(r.order_number, r.asin)));
      const alreadyInVelocity = records.length - toSend.length; // intentional tally, like self-prep

      const clampNote = clamped ? ` (requested ${formatYMD(from)}..${formatYMD(to)}, clamped to ${formatYMD(effectiveFrom)}..${formatYMD(to)} by floor)` : "";
      log(
        `Velocity upload${dryRun ? " [DRY-RUN]" : ""} ${formatYMD(effectiveFrom)}..${formatYMD(to)}: ${toSend.length} to send, ${alreadyInVelocity} already in Velocity, ${selfPrepExcluded} self-prep excluded, ${skips.length} skips ${JSON.stringify(skipsByReason)}${clampNote}`,
        "velocity-upload",
      );

      if (!dryRun && toSend.length > 0) {
        await submitBulkCsv(serializeVelocityCsv(toSend));
        log(`Velocity upload: bulk CSV accepted (${toSend.length} records)`, "velocity-upload");
      }

      res.json({
        from: formatYMD(from),
        to: formatYMD(to),
        effectiveFrom: formatYMD(effectiveFrom),
        clamped,
        dryRun,
        sent: dryRun ? 0 : toSend.length,
        wouldSend: dryRun ? toSend.length : undefined,
        alreadyInVelocity,
        selfPrepExcluded,
        skipCount: skips.length,
        skipsByReason,
        skips,
      });
    } catch (err: any) {
      log(`Velocity upload error: ${err?.message ?? err}`, "velocity-upload");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Velocity reconciliation (SPEC §11) — read-only. Full classified result:
  // creates / updates (quantity diffs; actionable:false = shipped-pair
  // mismatch, flag-only) / delete-candidates (manual list) / unchanged +
  // closed counts. Feeds the "Upload to Velocity" dialog.
  // §11 Part D (2026-09-21): inline mapping from the Upload dialog's SKIPPED
  // section — writes a manual_map identity row (parent order_id → the sheet
  // order number). Writes to velocity_bundle_identity ONLY; no Velocity call.
  app.post("/api/velocity/bundle-identity/map", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { velocityOrderId, asin, orderNumber } = (req.body ?? {}) as Record<string, string>;
    if (!velocityOrderId || !asin || !orderNumber || !String(orderNumber).trim()) {
      res.status(400).json({ message: "velocityOrderId, asin and orderNumber are all required" }); return;
    }
    try {
      await mapBundleIdentity({ velocityOrderId, asin, orderNumber: String(orderNumber) });
      log(`Velocity bundle identity mapped (manual): ${velocityOrderId} -> ${String(orderNumber).trim()} (${asin})`, "velocity-upload");
      res.json({ ok: true, velocityOrderId, asin, orderNumber: String(orderNumber).trim() });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/velocity/plan", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.VELOCITY_API_KEY || !process.env.VELOCITY_WAREHOUSE_ID) { res.status(400).json({ message: "VELOCITY_API_KEY / VELOCITY_WAREHOUSE_ID not configured" }); return; }

    const today = todayLocal();
    const from = (req.query.from as string) ? parseMDY(req.query.from as string) : today;
    const to = (req.query.to as string) ? parseMDY(req.query.to as string) : today;
    if (from === null || to === null) { res.status(400).json({ message: "from/to must be M/D/YYYY" }); return; }

    try {
      const plan = await buildVelocityPlan(from, to);
      log(
        `Velocity plan ${plan.from}..${plan.to}: ${plan.creates.length} create, ${plan.updates.length} update (${plan.updates.filter((u) => !u.actionable).length} shipped/flag-only), ${plan.deleteCandidates.length} delete-candidate, ${plan.unchanged} unchanged, ${plan.closedInVelocity} closed, ${plan.unmatchedVelocity} unmatched, ${plan.skips.length} skips`,
        "velocity-reconcile",
      );
      res.json(plan);
    } catch (err: any) {
      log(`Velocity plan error: ${err?.message ?? err}`, "velocity-reconcile");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Velocity execute (SPEC §11) — executes ONLY the approved items in the
  // body, nothing inferred. Creates re-checked against live Velocity (a
  // double-execute cannot double-create). Updates via echo-merge full-replace
  // PUT; pack math pre-validated; target must still be actionable (shipped
  // flag-only mismatches are refused here by the live status re-check).
  // Per-item results; no rollback on partial failure.
  app.post("/api/velocity/execute", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.VELOCITY_API_KEY || !process.env.VELOCITY_WAREHOUSE_ID) { res.status(400).json({ message: "VELOCITY_API_KEY / VELOCITY_WAREHOUSE_ID not configured" }); return; }

    const { creates, updates, bundles } = (req.body ?? {}) as { creates?: any[]; updates?: PlanUpdate[]; bundles?: any[] };
    if (!Array.isArray(creates ?? []) || !Array.isArray(updates ?? []) || !Array.isArray(bundles ?? [])) {
      res.status(400).json({ message: "body must be { creates?: VelocityRecord[], updates?: PlanUpdate[], bundles?: VelocityBundleRecord[] }" }); return;
    }
    const toCreate = creates ?? [];
    const toUpdate = updates ?? [];
    const toBundle = bundles ?? [];
    if (toCreate.length === 0 && toUpdate.length === 0 && toBundle.length === 0) { res.status(400).json({ message: "empty plan — nothing to execute" }); return; }

    await respondLongSync(res, async () => {
      const results: any[] = [];
      const createdBundleAsins = new Set<string>();
      // ECHO FRESHNESS RULE (SPEC §11): this GET sources the echo-merge
      // values for full-replace PUTs and MUST happen here, at execute time,
      // immediately before the write loop — never reuse order values cached
      // from the plan/review fetch. A review screen open for minutes would
      // otherwise full-replace away interim Velocity-side changes.
      // COMPLETE coverage (2026-08-11): the execute-time create-dedup uses
      // the same three-leg union as the plan — a completed order must block
      // a CREATE here too, the last line of defense against a duplicate.
      const live = await fetchAllKnownOrders();
      // §11 Part B.1 (2026-09-21): record identity for every list-visible
      // bundle parent on EVERY fetch. Failures are surfaced, never fatal —
      // in-batch hydration already covers what is list-visible (Part B.4).
      {
        const rec = await recordBundleIdentities(recordableBundles(live));
        if (rec.written > 0 || rec.errors.length > 0 || rec.changed.length > 0) {
          results.push({ action: "record_identity", scope: "pre_write_fetch", written: rec.written, changed: rec.changed, errors: rec.errors });
        }
        for (const c of rec.changed) {
          log(`Velocity bundle identity changed for ${c.velocity_order_id}: [${c.from.join(", ")}] -> [${c.to.join(", ")}]`, "velocity-upload");
        }
      }
      // §11 Part C.2 (2026-09-24): hydrate child-less shipment bundles from
      // the identity record BEFORE any key set is built — the SAME shared
      // implementation the plan uses. Without this, a bundle whose parent
      // shipped after approval keyed on the synthetic __velocity_order_id
      // form, matched nothing, and would have been re-sent as a duplicate
      // (134524 / B0DKT4NDFZ, measured 2026-09-24).
      const liveHydration = await hydrateChildlessBundles(live);
      if (liveHydration.hydrated > 0 || liveHydration.unplaced.length > 0) {
        results.push({
          action: "hydrate_identity", scope: "pre_write_fetch",
          hydrated: liveHydration.hydrated, unplaced: liveHydration.unplaced.length,
        });
      }

      const liveByKey = new Map(live.map((o) => [
        `${String(o.order_number ?? "").trim()} ${String(o.asin ?? "").trim().toUpperCase()}`, o,
      ]));

      // Creates: drop anything already present, then one bulk CSV.
      const createNow = [];
      for (const r of toCreate) {
        const key = `${String(r.order_number ?? "").trim()} ${String(r.asin ?? "").trim().toUpperCase()}`;
        if (liveByKey.has(key)) {
          results.push({ action: "create", order_number: r.order_number, asin: r.asin, outcome: "skipped_already_in_velocity" });
        } else {
          createNow.push(r);
        }
      }
      if (createNow.length > 0) {
        try {
          await submitBulkCsv(serializeVelocityCsv(createNow));
          for (const r of createNow) results.push({ action: "create", order_number: r.order_number, asin: r.asin, outcome: "created" });
        } catch (err: any) {
          for (const r of createNow) results.push({ action: "create", order_number: r.order_number, asin: r.asin, outcome: "failed", error: err?.message ?? String(err) });
        }
      }

      // Bundles (SPEC §11 Bundles, 2026-08-31): one JSON POST per bundle —
      // the bulk CSV cannot carry bundle_items. Execute-time dedup uses the
      // CHILD-DERIVED keys against the same fresh three-leg union (any child
      // order_number × parent asin already known = the bundle exists).
      if (toBundle.length > 0) {
        const liveKeysAll = new Set<string>();
        for (const o of live) {
          for (const k of matchKeysForOrder(o)) {
            liveKeysAll.add(`${k.orderNumber.trim()} ${k.asin.trim().toUpperCase()}`);
          }
        }
        for (const b of toBundle) {
          const asin = String(b.asin ?? "");
          const nums: string[] = Array.isArray(b.orderNumbers) ? b.orderNumbers : [];
          const dup = nums.some((n) => liveKeysAll.has(`${String(n).trim()} ${asin.trim().toUpperCase()}`));
          if (dup) {
            results.push({ action: "create_bundle", order_number: nums[0] ?? "", asin, outcome: "skipped_already_in_velocity" });
            continue;
          }
          try {
            await createBundleOrder(b);
            results.push({ action: "create_bundle", order_number: nums[0] ?? "", asin, outcome: "created" });
            createdBundleAsins.add(asin.toUpperCase());
          } catch (err: any) {
            results.push({ action: "create_bundle", order_number: nums[0] ?? "", asin, outcome: "failed", error: err?.message ?? String(err) });
          }
        }
      }

      // §11 Part B.2 (2026-09-21): ONE fresh /inbound read after the bundle
      // creates, to capture the new parents' identity while they are still
      // list-visible (their children are only serialized on the list legs).
      // A failed capture is AMBER in the results — never a failure of the
      // create, which already succeeded at Velocity; the next run captures
      // it as long as the bundle is still list-visible.
      if (createdBundleAsins.size > 0) {
        try {
          const after = await fetchAllKnownOrders();
          const fresh = recordableBundles(after).filter((r) => createdBundleAsins.has(r.asin.toUpperCase()));
          const rec = await recordBundleIdentities(fresh);
          results.push({
            action: "record_identity", scope: "post_create",
            written: rec.written, errors: rec.errors,
            outcome: rec.errors.length === 0 && rec.written === fresh.length ? "captured" : "capture_incomplete",
            expected: fresh.length,
          });
        } catch (err: any) {
          results.push({
            action: "record_identity", scope: "post_create", outcome: "capture_failed",
            error: err?.message ?? String(err),
            note: "bundle creates SUCCEEDED; identity will be captured on the next run while the bundle is still list-visible",
          });
        }
      }

      // Updates: per-order PUT with only the changed fields.
      for (const u of toUpdate) {
        const current = live.find((o) => o.order_id === u.order_id);
        if (!current) { results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, outcome: "failed", error: "order_id not found in Velocity" }); continue; }
        if (String(current.status ?? "").toLowerCase() !== "inbound") {
          results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, outcome: "skipped_not_actionable", status: current.status }); continue;
        }
        const body = putBodyFromDiffs(u.diffs ?? []);
        if (Object.keys(body).length === 0) { results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, outcome: "skipped_no_fields" }); continue; }
        // Pack-math pre-validation on the MERGED post-update state — skip a
        // doomed PUT rather than send it (Velocity enforces divisibility).
        const soldAs = String(body.sold_as ?? current.sold_as ?? "").toLowerCase();
        const qty = Number(body.quantity ?? current.quantity);
        const upp = body.units_per_pack ?? current.units_per_pack;
        if (soldAs && soldAs !== "individual") {
          const uppN = Number(upp);
          if (!Number.isInteger(uppN) || uppN <= 0 || !Number.isInteger(qty) || qty % uppN !== 0) {
            results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, outcome: "skipped_invalid_pack_math", quantity: qty, units_per_pack: upp }); continue;
          }
        }
        // Velocity's PUT is full-replace (first live PUT nulled the omitted
        // date → NOT NULL violation). Echo the order's current values for the
        // documented-safe set, overridden by the approved changes. Never
        // fulfilledBy; never cogs/listPrice (cost privacy).
        const putBody = {
          date: current.date,
          retailer: current.retailer ?? "",
          orderNumber: String(current.order_number ?? ""),
          itemName: current.item_name ?? "",
          asin: current.asin,
          amazonSKU: current.amazon_sku ?? "",
          sold_as: current.sold_as ?? "",
          units_per_pack: current.units_per_pack ?? null,
          // ECHO ONLY — full-replace PUT nulls fulfillment_type if omitted.
          // Always the order's CURRENT value; a change can never originate
          // here (quantity-only audit; spread of `body` cannot contain it).
          fulfilledBy: current.fulfillment_type,
          // Their handler iterates trackingNumbers — omitting it 500s with
          // "'NoneType' object is not iterable". Echo current (usually []).
          trackingNumbers: current.trackings ?? [],
          ...body,
        };
        try {
          await updateInboundOrder(u.order_id, putBody);
          results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, asin: u.asin, outcome: "updated", fields: Object.keys(body), echoed: Object.keys(putBody).filter((k) => !(k in body)) });
        } catch (err: any) {
          results.push({ action: "update", order_id: u.order_id, order_number: u.order_number, outcome: "failed", error: err?.message ?? String(err) });
        }
      }

      const outcomes = results.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {} as Record<string, number>);
      log(`Velocity execute: ${JSON.stringify(outcomes)}`, "velocity-reconcile");
      return { results, outcomes };
    });
  });

  // SellerBoard COGS export (interim bandage until the Actuals audit). Read-only:
  // no DB, no SC. Inputs = uploaded SB products template (multipart "file") +
  // the Orders sheet. Returns JSON { filename, csv, summary } so the client can
  // build the download AND show the summary; full detail is logged server-side.
  app.post("/api/export/sellerboard-cogs", upload.single("file"), async (req: Request, res: Response) => {
    if (!req.file) { res.status(400).json({ message: "No template file uploaded (field 'file')" }); return; }

    try {
      const { rows, summary, details } = await buildSellerboardCogs(req.file.buffer);
      const csv = serializeSbCsv(rows);
      const filename = `sb-cogs-${formatYMD(todayLocal())}.csv`;
      const s = summary.skips;
      // Row-accounting identity — every Orders row read lands exactly once.
      const accounted = summary.blankAsinRows + s.excludedByStatus + s.badOrMissingDate +
        s.excludedNonYtd + s.badOrZeroCost + s.badQty + summary.includedRows;
      log(
        `SellerBoard COGS export: ${summary.rowsEmitted} rows, ${summary.distinctAsins} ASINs, ` +
        `${summary.distinctPeriods} periods, template ${summary.templateRowsLoaded} rows ` +
        `(read=${summary.templateRowsRead} dropped=${summary.templateRowsDropped} dupes=${summary.templateDupeRows}); ` +
        `orders rawRowsRead=${summary.rawRowsRead} blankAsin=${summary.blankAsinRows} ` +
        `excludedByStatus=${s.excludedByStatus} badDate=${s.badOrMissingDate} nonYtd=${s.excludedNonYtd} ` +
        `badCost=${s.badOrZeroCost} badQty=${s.badQty} included=${summary.includedRows} ` +
        `(identity remainder=${summary.rawRowsRead - accounted}); ` +
        `sameDateMerged=${s.sameDateMerged} fractionalCollapsed=${s.fractionalCollapsed} ` +
        `fractionalRounded=${s.fractionalRounded} notInSb=${s.notInSb} [${details.notInSbAsins.join(", ")}] ` +
        `inSbNoUsableSku=${s.inSbNoUsableSku} [${details.inSbNoUsableSkuAsins.join(", ")}]` +
        (details.merges.length ? ` merges=${JSON.stringify(details.merges)}` : "") +
        (details.badQtyRows.length ? ` badQtyRows=${JSON.stringify(details.badQtyRows)}` : "") +
        (details.fractionalCollapsed.length ? ` fractionalCollapsed=${JSON.stringify(details.fractionalCollapsed)}` : "") +
        (details.fractionalRounded.length ? ` fractionalRounded=${JSON.stringify(details.fractionalRounded)}` : ""),
        "sellerboard-cogs",
      );
      res.json({
        filename,
        csv,
        summary: {
          emitted: summary.rowsEmitted,
          asins: summary.distinctAsins,
          periods: summary.distinctPeriods,
          rawRowsRead: summary.rawRowsRead,
          blankAsinRows: summary.blankAsinRows,
          includedRows: summary.includedRows,
          templateRowsLoaded: summary.templateRowsLoaded,
          templateRowsDropped: summary.templateRowsDropped,
          skips: {
            excludedByStatus: s.excludedByStatus,
            badDate: s.badOrMissingDate,
            excludedNonYtd: s.excludedNonYtd,
            badCost: s.badOrZeroCost,
            badQty: s.badQty,
            sameDateMerged: s.sameDateMerged,
            fractionalCollapsed: s.fractionalCollapsed,
            fractionalRounded: s.fractionalRounded,
            notInSb: s.notInSb,
            inSbNoUsableSku: s.inSbNoUsableSku,
          },
          notInSbAsins: details.notInSbAsins,
          inSbNoUsableSkuAsins: details.inSbNoUsableSkuAsins,
          badQtyRows: details.badQtyRows.map((r) => ({ asin: r.asin, date: r.date, rawQty: r.rawQty, mode: r.mode })),
          fractionalCollapsed: details.fractionalCollapsed,
          fractionalRounded: details.fractionalRounded,
        },
      });
    } catch (err: any) {
      log(`SellerBoard COGS export error: ${err?.message ?? err}`, "sellerboard-cogs");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Amazon Sourcing Cost export. No SP-API exists for sourcing cost (verified
  // against the SP-API model + feed-type lists, Aug 2026), so this is a
  // fill-in-place transform on Amazon's own workbook: upload the file from
  // "Bulk Update" on the Manage Your Sourcing Cost page, get it back with
  // "Seller New Cost" populated for every ASIN purchased in the selected range.
  // Cost = actual_cogs, po_sheet-sourced only. Returns JSON
  // { filename, xlsxBase64, summary } so the client builds the download AND
  // shows the accounting; full detail is logged server-side.
  app.post("/api/export/sourcing-cost", upload.single("file"), async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!req.file) { res.status(400).json({ message: "No workbook uploaded (field 'file')" }); return; }

    const from = parseYMDLocal(req.body?.from);
    const to = parseYMDLocal(req.body?.to);
    if (!from || !to) { res.status(400).json({ message: "from/to must be YYYY-MM-DD" }); return; }
    if (from.getTime() > to.getTime()) { res.status(400).json({ message: "from must not be after to" }); return; }

    try {
      const { buffer, summary, details } = await buildSourcingCost(req.file.buffer, from, to);
      const filename = sourcingCostFilename(from, to);
      const s = summary.skips;
      // Row-accounting identity — every PO sheet row read lands exactly once.
      const accounted = summary.blankAsinRows + s.excludedByStatus + s.badOrMissingDate +
        s.excludedOutOfRange + summary.includedRows;
      log(
        `Sourcing cost export ${formatYMD(from)}..${formatYMD(to)}: ` +
        `${summary.rowsWritten} rows written across ${summary.asinsWritten} ASINs ` +
        `(workbook ${summary.workbookRowsRead} rows / ${summary.workbookAsins} ASINs over ${summary.sheetsScanned} sheet(s)); ` +
        `PO sheet rawRowsRead=${summary.rawRowsRead} blankAsin=${summary.blankAsinRows} ` +
        `excludedByStatus=${s.excludedByStatus} badDate=${s.badOrMissingDate} ` +
        `outOfRange=${s.excludedOutOfRange} included=${summary.includedRows} ` +
        `(identity remainder=${summary.rawRowsRead - accounted}); ` +
        `purchasedAsins=${summary.purchasedAsins} withPoCogs=${summary.asinsWithPoCogs} ` +
        `noCogsRow=${s.noCogsRow} [${details.noCogsRowAsins.join(", ")}] ` +
        `notPoSourced=${s.notPoSourced} [${details.notPoSourcedAsins.map((x) => `${x.asin}:${x.source ?? "null"}`).join(", ")}] ` +
        `badCost=${s.badCost} [${details.badCostAsins.map((x) => `${x.asin}:${x.cogs}`).join(", ")}] ` +
        `notInWorkbook=${s.notInWorkbook} [${details.notInWorkbookAsins.join(", ")}] ` +
        `alreadyApproved=${s.alreadyApproved} [${details.alreadyApprovedAsins.join(", ")}] ` +
        `wouldLowerApproved=${s.wouldLowerApproved} ` +
        `[${details.wouldLowerAsins.map((x) => `${x.asin}:${x.approved}>${x.cost}`).join(", ")}]` +
        (details.written.length ? ` written=${JSON.stringify(details.written)}` : ""),
        "sourcing-cost",
      );

      // History is recorded at GENERATION time — Seller Central gives no upload
      // receipt, so this logs what we produced, not what Amazon accepted. A
      // history write failure must not lose the user their file.
      try {
        await recordSourcingCostExport({
          filename,
          rangeStart: formatYMD(from),
          rangeEnd: formatYMD(to),
          purchasedAsins: summary.purchasedAsins,
          asinsWritten: summary.asinsWritten,
          rowsWritten: summary.rowsWritten,
        });
      } catch (histErr: any) {
        log(`Sourcing cost export: history write failed (file still returned): ${histErr?.message ?? histErr}`, "sourcing-cost");
      }

      res.json({
        filename,
        xlsxBase64: buffer.toString("base64"),
        summary: {
          from: formatYMD(from),
          to: formatYMD(to),
          rowsWritten: summary.rowsWritten,
          asinsWritten: summary.asinsWritten,
          purchasedAsins: summary.purchasedAsins,
          asinsWithPoCogs: summary.asinsWithPoCogs,
          sheetsScanned: summary.sheetsScanned,
          workbookRowsRead: summary.workbookRowsRead,
          workbookAsins: summary.workbookAsins,
          rawRowsRead: summary.rawRowsRead,
          blankAsinRows: summary.blankAsinRows,
          includedRows: summary.includedRows,
          skips: {
            excludedByStatus: s.excludedByStatus,
            badDate: s.badOrMissingDate,
            outOfRange: s.excludedOutOfRange,
            noCogsRow: s.noCogsRow,
            notPoSourced: s.notPoSourced,
            badCost: s.badCost,
            notInWorkbook: s.notInWorkbook,
            alreadyApproved: s.alreadyApproved,
            wouldLowerApproved: s.wouldLowerApproved,
          },
          noCogsRowAsins: details.noCogsRowAsins,
          notPoSourcedAsins: details.notPoSourcedAsins,
          badCostAsins: details.badCostAsins,
          notInWorkbookAsins: details.notInWorkbookAsins,
          alreadyApprovedAsins: details.alreadyApprovedAsins,
          wouldLowerAsins: details.wouldLowerAsins,
          written: details.written,
        },
      });
    } catch (err: any) {
      log(`Sourcing cost export error: ${err?.message ?? err}`, "sourcing-cost");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Export history — what we've generated, newest first. Filenames carry their
  // own date range, so the list is self-describing.
  app.get("/api/export/sourcing-cost/history", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      res.json({ exports: await listSourcingCostExports(50) });
    } catch (err: any) {
      log(`Sourcing cost history error: ${err?.message ?? err}`, "sourcing-cost");
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  app.post("/api/sync/sourcing-sheet", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!credPath || !fs.existsSync(credPath)) {
      res.status(400).json({ message: "Google credentials file not found" });
      return;
    }
    if (!process.env.SOURCING_SHEET_ID) {
      res.status(400).json({ message: "SOURCING_SHEET_ID not configured" });
      return;
    }

    const dryRun = String(req.query.dryRun ?? "").toLowerCase() === "true";

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const result = await syncSourcingSheet(
        async (newInputs) => {
          // fromCsvUpload=true so estimated_cogs gets persisted via the dedicated CSV write path
          await runAnalyzeAndStream(newInputs, res, mainCatalogSink, () => null, true, {}, "sourcing");
        },
        (plan) => {
          res.write(JSON.stringify({ type: "sync_summary", data: { ...plan, dryRun } }) + "\n");
        },
        { dryRun },
      );
      res.write(JSON.stringify({ type: "complete", data: result }) + "\n");
      res.end();
    } catch (err: any) {
      log(`Sourcing sheet sync error: ${err.message}`, "sheets");
      // Headers already sent — emit error in stream rather than HTTP status
      res.write(JSON.stringify({ type: "error", data: { message: err.message } }) + "\n");
      res.end();
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

  // === DA-3: revival of catalog-deleted-then-restored ASINs ===
  //
  // Standing-state predicate (matches DA-2's auto-dead write):
  //   status='dead' AND status_reason='catalog_deleted' AND is_catalog_deleted=false
  // Meaning: "dead BECAUSE catalog-deleted, but the catalog has been restored."
  // Parked ASINs and dead-for-other-reasons are never offered for auto-revival.

  app.get("/api/asins/revival-candidates", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      const result = await query(`
        SELECT asin, title, brand
        FROM asins
        WHERE status = 'dead'
          AND status_reason = 'catalog_deleted'
          AND is_catalog_deleted = FALSE
        ORDER BY added_at DESC
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/asins/revive", async (req: Request, res: Response) => {
    const { asins: asinList } = req.body as { asins?: string[] };
    if (!asinList || !Array.isArray(asinList) || asinList.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      // Server-side predicate guard lives in the WHERE clause — atomic, no
      // TOCTOU window. A stale or malicious payload that included a parked
      // ASIN, a dead-for-another-reason ASIN, or one still flagged catalog-
      // deleted, simply won't match — no flip, no error. RETURNING tells us
      // which ASINs actually flipped, so the UI can show honest feedback
      // when something didn't qualify.
      const result = await query(
        `UPDATE asins
           SET status = 'active', status_reason = NULL, status_changed_at = NOW()
         WHERE asin = ANY($1::text[])
           AND status = 'dead'
           AND status_reason = 'catalog_deleted'
           AND is_catalog_deleted = FALSE
         RETURNING asin`,
        [asinList],
      );
      const revived: string[] = result.rows.map((r: any) => r.asin);
      const skipped = asinList.filter((a) => !revived.includes(a));
      res.json({ revived, skipped });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === 2D-3: Offer-add preview (dry-run only) ===
  //
  // DRY-RUN ONLY ENDPOINT. The orchestrator is invoked with dryRun=true
  // unconditionally — there is NO server-side path that fires a live
  // putListingsItem in this round. The live-write endpoint is DA-4.
  //
  // For each input ASIN:
  //   0. Probe gating LIVE for the selection (scheduler decision 9, 2026-10-13;
  //      INLINE since 2026-10-16 — no jobs row): the same probeGatingForAsins
  //      component 8 runs, same writes to eligibility_status /
  //      gating_checked_at, same rate limiter. The pre-filter below then reads
  //      this minute's value, not the daily pass's. An ASIN whose probe fails
  //      keeps its stored value (fail closed) and is listed in notes.gating.
  //      Confirmed necessary by the 2026-10-16 test (script/probe-gated-submit.ts):
  //      putListingsItem ACCEPTS a brand-gated ASIN and creates a SKU — the
  //      restrictions check is the only thing that says no.
  //   1. Pre-filter against locally-known is_catalog_deleted / eligibility_status
  //      (cheap UX; the orchestrator re-checks via SP-API for anything that passes)
  //   2. For submittable ASINs, load isHazmat + a placeholder price
  //   3. Call offerAddForAsin with dryRun=true → returns OfferAddResult
  //
  // Streams { type: "result", data } — the structured response the preview
  // dialog renders directly — or { type: "error", message }.
  app.post("/api/offer-add/preview", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const sellerId = process.env.SP_API_SELLER_ID;
    if (!sellerId) { res.status(503).json({ message: "SP_API_SELLER_ID not configured" }); return; }
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }

    await respondLongSync(res, async () => {
      // Step 0 — gating probe, inline (decision 9). Same writer as component 8.
      const gating = await probeGatingForAsins(asins.map((a) => String(a).trim().toUpperCase()), { query: (sql, params) => query(sql, params) });
      const gatingErrors = Object.fromEntries(Object.entries(gating.outcomes).filter(([, o]) => o.startsWith("error")));
      log(`Offer-add preview gating probe (${asins.length} ASINs): updated=${gating.counts.updated} yes=${gating.counts.yes} no=${gating.counts.no} flips=${gating.counts.flips} error=${gating.counts.error + gating.counts.missing_row}`, "offer-add");

      // PREVIEW uses the SAME submitOfferAddBatch pipeline as live submit,
      // with phase4Mode="preview" so phase 4 assembles the payload but skips
      // PUT. This guarantees preview == submit by construction (one code path).
      const submitRows = await loadSubmitRows(asins);
      const settings = await loadSettingsForSubmit();
      const inboundRow = await query(`SELECT value FROM settings WHERE key='include_inbound_shipping'`);
      const includeInboundShipping = inboundRow.rows[0]?.value === "true" || inboundRow.rows[0]?.value === true;
      const skusRes = await query(`SELECT sku FROM asin_skus`);
      const allExistingSkus = skusRes.rows.map((r: any) => String(r.sku));

      const submitResult = await submitOfferAddBatch(submitRows, {
        queryFn: (sql, params) => query(sql, params),
        sellerId,
        settings,
        includeInboundShipping,
        allExistingSkus,
        productRegistry: makeProductRegistryRepo((sql, params) => query(sql, params)),
        phase4Mode: "preview", // do everything EXCEPT the live PUT
      });

      // Map SubmitOutcome → OfferAddResult shape for UI compat (the preview
      // dialog already understands "preview" outcome with payload).
      const perAsin = submitResult.perAsin.map(({ asin, outcome }) => ({
        asin,
        outcome: mapSubmitOutcomeToOfferAddResult(outcome),
      }));

      // Excluded rows carry the stamp so the dialog can say "gated as of …".
      const stampByAsin = new Map(submitRows.map((r) => [r.asin, r.gating_checked_at ?? null]));
      return {
        preFilter: { excluded: submitResult.preFilter.excluded.map((e) => ({ ...e, gatingCheckedAt: stampByAsin.get(e.asin) ?? null })) },
        perAsin,
        notes: {
          priceSource: "Resolved via getItemOffers + Rule 1/2 (same path as submit)",
          productNumber: "Real NNN from batch allocator (same path as submit)",
          gating: `Probed live for the selection just now (inline, same writer as component 8): ${gating.counts.yes} eligible, ${gating.counts.no} gated, ${gating.counts.error + gating.counts.missing_row} probe error(s) — stored value kept for those`,
          gatingErrors,
          liveWrites: submitResult.notes.liveWrites,
        },
      };
    });
  });

  // === 2D-4 substep 4: LIVE submit endpoint ===
  //
  // This is the FIRST endpoint that fires real putListingsItem calls.
  // It expects the preview endpoint to have already run for review; the
  // server still re-classifies authoritatively (no trust in client-side state).
  //
  // Body: { asins: string[] } — typically the ASINs the user reviewed in preview
  //                              and clicked Confirm for.
  // Response: { preFilter, perAsin: [{ asin, outcome }], notes }
  //
  // CRITICAL: dryRun=FALSE is set inside submitOfferAddBatch's phase 4. The
  // route doesn't carry a dryRun flag — calling this endpoint IS the consent.
  // If you want a dry-run preview, use POST /api/offer-add/preview instead.
  app.post("/api/offer-add/submit", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const sellerId = process.env.SP_API_SELLER_ID;
    if (!sellerId) { res.status(503).json({ message: "SP_API_SELLER_ID not configured" }); return; }
    const { asins, skuOverrides } = (req.body ?? {}) as { asins?: string[]; skuOverrides?: Record<string, string> };
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }

    try {
      // Use the SAME loaders as preview — single source of truth.
      const submitRows = await loadSubmitRows(asins);
      const settings = await loadSettingsForSubmit();
      const inboundRow = await query(`SELECT value FROM settings WHERE key='include_inbound_shipping'`);
      const includeInboundShipping = inboundRow.rows[0]?.value === "true" || inboundRow.rows[0]?.value === true;
      const skusRes = await query(`SELECT sku FROM asin_skus`);
      const allExistingSkus = skusRes.rows.map((r: any) => String(r.sku));

      log(`Offer-add SUBMIT (LIVE) for ${asins.length} ASIN(s): ${asins.join(", ")}`, "offer-add");

      const result = await submitOfferAddBatch(submitRows, {
        queryFn: (sql, params) => query(sql, params),
        sellerId,
        settings,
        includeInboundShipping,
        allExistingSkus,
        skuOverrides,
        productRegistry: makeProductRegistryRepo((sql, params) => query(sql, params)),
        // phase4Mode defaults to "live" — REAL putListingsItem fires here.
        // selfHealWrite omitted for now — resurrection's selfHeal writes to asins
        // table; submit path doesn't need it for the live submission itself.
      });

      log(`Offer-add SUBMIT complete: ${result.notes.submittedCount} created, ${result.notes.failedCount} failed, ${result.notes.skippedCount} skipped`, "offer-add");

      // §19 auto verify after submit — fires only when ≥1 submission was
      // ACCEPTED (kind "created"); fire-and-forget, never delays the response.
      const createdPairs = result.perAsin
        .filter((p) => p.outcome.kind === "created")
        .map((p) => ({ asin: p.outcome.asin, sku: (p.outcome as any).sku as string }));
      if (createdPairs.length > 0) {
        scheduleBatchVerify(sellerId, createdPairs);
      }

      res.json(result);
    } catch (err: any) {
      log(`Offer-add submit error: ${err.message}`, "offer-add");
      res.status(500).json({ message: err.message });
    }
  });

  // === §18 Relist: re-create a deleted listing under its original SKU ===
  //
  // Body: { items: [{asin, sku}], openOnCreate?: boolean, dryRun?: boolean }
  // The pipeline lives in server/relist.ts (shared with script/relist.ts).
  app.post("/api/listings/relist", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const sellerId = process.env.SP_API_SELLER_ID;
    if (!sellerId) { res.status(503).json({ message: "SP_API_SELLER_ID not configured" }); return; }
    const { items, openOnCreate, dryRun } = (req.body ?? {}) as {
      items?: Array<{ asin?: string; sku?: string }>; openOnCreate?: boolean; dryRun?: boolean;
    };
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ message: "No items provided — expected [{asin, sku}]" }); return;
    }
    const cleaned = items.map((it) => ({ asin: String(it.asin ?? "").trim().toUpperCase(), sku: String(it.sku ?? "").trim() }));
    if (cleaned.some((it) => !it.asin || !it.sku)) {
      res.status(400).json({ message: "Every item needs both asin and sku" }); return;
    }
    await respondLongSync(res, async () => {
      const { result, createdPairs } = await runRelist(cleaned, {
        sellerId, openOnCreate: openOnCreate === true, dryRun: dryRun === true,
        log: (m) => log(m, "offer-add"),
      });
      if (!dryRun && createdPairs.length > 0) scheduleBatchVerify(sellerId, createdPairs);
      return result;
    });
  });

  // === Post-submit verification ledger ===
  //
  // On-demand (no job infra). Verify sweeps pending/processing/stale rows
  // through SC, paced + fail-closed (throttled rows stay unchanged). Amazon
  // async processing is slow (hours), so this is expected to run the morning
  // after a batch; re-running is safe/idempotent.
  app.post("/api/submissions/verify", async (_req: Request, res: Response) => {
    const sellerId = process.env.SP_API_SELLER_ID;
    if (!sellerId) { res.status(400).json({ error: "SP_API_SELLER_ID not set" }); return; }
    try {
      const summary = await verifyPending(sellerId, { closeAfterCreate: (r) => closeAfterCreate(query as any, sellerId, r) });
      const needsAttention = await listNeedsAttention();
      res.json({ summary, needsAttention });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "verify failed" });
    }
  });

  // Unverified count (toolbar chip) + the needs-attention list (failed, stale,
  // and LIVE-with-review-flags — surfaced, not JSONB-only).
  app.get("/api/submissions/unverified", async (_req: Request, res: Response) => {
    try {
      res.json({
        count: await getUnverifiedCount(),
        needsAttention: await listNeedsAttention(),
        inFlight: await listInFlight(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "query failed" });
    }
  });

  // Manual resolution of a stale/ambiguous row: live | failed | deleted.
  app.post("/api/submissions/:id/resolve", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const verdict = req.body?.verdict as "live" | "failed" | "deleted";
    if (!["live", "failed", "deleted"].includes(verdict)) {
      res.status(400).json({ error: "verdict must be live | failed | deleted" }); return;
    }
    try {
      // The verdict re-probes the ASIN (§19, 2026-10-10) — the outcome is
      // surfaced so the caller can see what SC actually said, including
      // `skipped_transient` when the probe was throttled and the flag
      // therefore did not move.
      const { flagOutcome } = await resolveSubmissionManual(id, verdict);
      res.json({ ok: true, flagOutcome });
    } catch (err: any) {
      const msg = err?.message ?? "resolve failed";
      res.status(/already resolved|not found/.test(msg) ? 409 : 500).json({ error: msg });
    }
  });

  // §6 item 7: single-ASIN current-issues recheck. Runs the listings
  // reconcile STAGE scoped to one ASIN (2026-10-09) — it used to call
  // syncLiveOffers, the last surviving caller of that module, which wrote the
  // flag with no ledger anywhere. live-offer-sync.ts is deleted; this is the
  // same runFullScopePass the Refresh stage uses, so there is one
  // implementation and every write here is ledgered (§18 A2).
  // Read-only vs the ledger. Returns the fresh row fields for in-place update.
  app.post("/api/asins/:asin/recheck-issues", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const asin = String(req.params.asin ?? "").trim();
    if (!asin) { res.status(400).json({ message: "ASIN required" }); return; }
    try {
      const report = await runFullScopePass({ dryRun: false, asinFilter: new Set([asin]) });
      const row = (await query(
        `SELECT has_live_offer, current_issues, issues_checked_at FROM asins WHERE asin = $1`, [asin],
      )).rows[0];
      res.json({
        probed: report.phaseA.asins + report.phaseB.asins,
        transient: report.phaseA.transientSkipped + report.phaseB.transientSkipped,
        outcome: report.outcomes[asin] ?? null,
        hasLiveOffer: row?.has_live_offer ?? null,
        currentIssues: row?.current_issues ?? null,
        issuesCheckedAt: row?.issues_checked_at ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? "recheck failed" });
    }
  });

  // §18 manual full-scope listing scan (item 8 + 8c). NDJSON progress
  // stream. dryRun REQUIRED as an explicit query param (no fail-open default
  // — ?dryRun=1 probes read-only with ZERO writes; ?dryRun=0 is the live
  // run). Body {asins?} = selection-aware scope.
  app.post("/api/listings/full-scope-pass", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (!process.env.SP_API_SELLER_ID) { res.status(503).json({ message: "SP_API_SELLER_ID not configured" }); return; }
    const dryRunRaw = String(req.query.dryRun ?? "");
    if (dryRunRaw !== "1" && dryRunRaw !== "0") {
      res.status(400).json({ message: "dryRun=1 or dryRun=0 required (explicit — no default)" }); return;
    }
    const dryRun = dryRunRaw === "1";
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const asinFilter = asins && asins.length > 0 ? new Set(asins) : undefined;
    // §18 phase c on this entry point is OPT-IN (?phaseC=1), and ?onlyPhaseC=1
    // runs it alone — the dry-run gate and the "re-run, expect 0" check both
    // want the account-list diff without a full-catalog reconcile.
    const onlyPhaseC = String(req.query.onlyPhaseC ?? "") === "1";
    const phaseC = onlyPhaseC || String(req.query.phaseC ?? "") === "1";
    res.setHeader("Content-Type", "application/x-ndjson");
    const emit = (ev: Record<string, any>) => res.write(JSON.stringify(ev) + "\n");
    try {
      log(`Full-scope pass ${dryRun ? "DRY-RUN" : "LIVE"} started (${asinFilter ? asinFilter.size + " selected" : "full catalog"}${onlyPhaseC ? ", phase c ONLY" : phaseC ? ", with phase c" : ""})`, "full-scope");
      const startedAt = new Date();
      const report = await runFullScopePass({
        dryRun, asinFilter, emit, phaseC, onlyPhaseC,
        onboard: onboardScDiscoveries,
      });

      // §18 A2: a flag write with no ledger row must be impossible BY
      // CONSTRUCTION. This endpoint returned its outcomes in the HTTP
      // response and persisted nothing — so a reconcile run here left the
      // flips provable only from a transcript someone happened to keep. The
      // 2026-10-13 full-catalog backfill ran before this was fixed; its 8
      // flips are evidenced by the pass report and a before/after DB diff
      // rather than by refresh_runs.
      //
      // Dry runs write no ledger row, matching every other dry-run path.
      if (!dryRun) {
        const a = report.phaseA, b = report.phaseB, c = report.phaseC;
        await query(
          `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes)
           VALUES ($1, NOW(), 'manual', 'listings', $2, $3, $4::jsonb, $5::jsonb)`,
          [
            startedAt,
            asinFilter ? "subset" : "full",
            a.asins + b.asins,
            JSON.stringify({
              probed: a.asins + b.asins, live: a.live, no_offer: a.noOffer,
              transient: a.transientSkipped + b.transientSkipped,
              flips: a.flips.length, repoints: a.repoints.length,
              discoveries: a.discoveries.length + b.discovered.length,
              no_listing: b.noListing,
              ...(c ? { sc_asins: c.scAsins, onboarded: c.onboarded.length,
                        ...(c.incomplete ? { sc_list_incomplete: 1 } : {}) } : {}),
            }),
            JSON.stringify(report.outcomes),
          ],
        ).catch((err: any) => log(`refresh_runs write failed for full-scope pass: ${err?.message ?? err}`, "full-scope"));
      }
      emit({ type: "complete", report });
    } catch (err: any) {
      emit({ type: "error", message: err?.message ?? "full-scope pass failed" });
    }
    res.end();
  });

  // §19 bulk manual verdicts: single-row semantics per id; already-terminal
  // rows are skipped and reported, never a batch failure.
  app.post("/api/submissions/resolve-bulk", async (req: Request, res: Response) => {
    const { ids, verdict } = (req.body ?? {}) as { ids?: string[]; verdict?: string };
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids[] required" }); return;
    }
    if (!["live", "failed", "deleted"].includes(verdict ?? "")) {
      res.status(400).json({ error: "verdict must be live | failed | deleted" }); return;
    }
    try {
      const result = await resolveSubmissionsBulk(ids.map(String), verdict as any);
      log(`Bulk resolve (${verdict}): ${result.resolved.length} resolved, ${result.skipped.length} skipped`, "submissions");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "bulk resolve failed" });
    }
  });

  // §19 dismiss (acknowledge): hide terminal needs-attention rows. Terminal-
  // only (guarded in the repo's WHERE); non-terminal ids come back as skipped.
  // Hides, never deletes — issues/review_flags stay in the ledger.
  app.post("/api/submissions/dismiss-flags", async (req: Request, res: Response) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids[] required" }); return;
    }
    try {
      const result = await dismissFlags(ids.map(String));
      log(`Dismiss flags: ${result.dismissed.length} acknowledged, ${result.skipped.length} skipped (non-terminal/unknown)`, "submissions");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "dismiss failed" });
    }
  });

  // === 2D-2: Legend approvals (legend_pending → approved) ===
  //
  // List approved brands — used by the legend approval dialog's merge-target
  // dropdown. Fetched fresh each dialog open (no client-side cache) so newly-
  // approved brands from a prior batch appear as targets in the current one.
  app.get("/api/sku-legend/brands", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      const r = await query(
        `SELECT id AS "legendId", raw_value AS "rawValue", code
           FROM sku_legend
          WHERE type='brand' AND status='approved'
          ORDER BY raw_value`,
      );
      res.json(r.rows);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Bulk approve — handles approve_new / approve_in_place / merge per item.
  // Server-side ordering, dependency tracking, per-item atomicity. See
  // server/sku-legend-approval.ts for the orchestration contract.
  app.post("/api/sku-legend/approve", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { items } = (req.body ?? {}) as { items?: ApprovalItem[] };
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ message: "No items provided" }); return;
    }
    // Single client + outer transaction. Each action uses a SAVEPOINT so
    // failed items roll back their own writes without affecting siblings.
    // An uncaught orchestrator-level error rolls back the whole batch
    // (per-item errors are caught and surfaced in results — they don't throw).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const handlers = makeProductionHandlers(client);
      const results = await processBulkApproval(items, handlers);
      await client.query("COMMIT");
      res.json({ results });
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      log(`Bulk legend approval error: ${err.message}`, "sku-legend");
      res.status(500).json({ message: err.message });
    } finally {
      client.release();
    }
  });

  // === Park / unpark (was Archive — SPEC §14, 2026-09-07) ===
  // Legacy route name kept (scripts); the body's `archive` flag now means
  // park. Reason cleared either way — parked has no machine reason here.
  app.put("/api/asins/archive", async (req: Request, res: Response) => {
    const { asins: asinList, archive } = req.body as { asins: string[]; archive: boolean };
    if (!asinList || !Array.isArray(asinList) || asinList.length === 0) {
      res.status(400).json({ message: "No ASINs provided" });
      return;
    }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(
        `UPDATE asins SET status = $2, status_reason = NULL, status_changed_at = NOW() WHERE asin = ANY($1::text[])`,
        [asinList, archive ? "parked" : "active"],
      );
      res.json({ count: asinList.length, archived: archive });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Mark dead / revive (SPEC §14, 2026-09-07) ===
  // status 'dead' requires a reason (preset ip_complaint / not_sourceable or
  // free text); 'active' (revive) clears it. 'parked' goes through the
  // park route above.
  app.put("/api/asins/status", async (req: Request, res: Response) => {
    const { asins: asinList, status, reason } = req.body as { asins?: string[]; status?: string; reason?: string };
    if (!asinList || !Array.isArray(asinList) || asinList.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }
    if (status !== "dead" && status !== "active") {
      res.status(400).json({ message: "status must be 'dead' or 'active' (park via /api/asins/archive)" }); return;
    }
    if (status === "dead" && (!reason || !String(reason).trim())) {
      res.status(400).json({ message: "marking dead requires a reason" }); return;
    }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      await query(
        `UPDATE asins SET status = $2, status_reason = $3, status_changed_at = NOW() WHERE asin = ANY($1::text[])`,
        [asinList, status, status === "dead" ? String(reason).trim() : null],
      );
      res.json({ count: asinList.length, status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Tags ===
  app.get("/api/tags", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json([]); return; }
    try {
      // §20 render order: ungrouped tags (tag_group NULL) first,
      // alphabetical; then each GROUP in the order below, its tags by
      // sort_order.
      //
      // Group order is EXPLICIT, not alphabetical (2026-10-13). Alphabetical
      // put OTHER before SEASONAL, and "Other" belongs last — it is the
      // leftovers bucket. A group not in this list sorts after the named
      // ones, alphabetically, so adding a group degrades gracefully instead
      // of landing in the middle.
      const result = await query(
        `SELECT id, name, color, tag_group, sort_order FROM tags
         ORDER BY (tag_group IS NOT NULL),
                  CASE tag_group
                    WHEN 'BLOCKERS'  THEN 1
                    WHEN 'MARK DEAD' THEN 2
                    WHEN 'SEASONAL'  THEN 3
                    WHEN 'OTHER'     THEN 4
                    ELSE 5
                  END,
                  tag_group,
                  sort_order NULLS LAST, name`
      );
      res.json(result.rows);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // §20: the ONE tag writer. The row tag picker calls it with {name} only and
  // gets a random palette colour, unchanged. The filter dropdown (2026-10-13)
  // additionally passes an explicit colour and an optional group — both
  // optional, so the picker's contract is untouched and there is still one
  // create path rather than two that can drift.
  app.post("/api/tags", async (req: Request, res: Response) => {
    const { name, color: colorRaw, tagGroup } = req.body as { name?: string; color?: string; tagGroup?: string | null };
    if (!name || !name.trim()) { res.status(400).json({ message: "Tag name required" }); return; }
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    // Name uniqueness is case-insensitive on the TRIMMED value, and an
    // existing tag is RETURNED rather than erroring — the picker depends on
    // that (type an existing name, get the tag back and attach it).
    const trimmed = name.trim();
    // Any #RRGGBB is accepted now (2026-10-13), not just the ten-swatch
    // palette — §20 requires 17+ distinct colours and the palette cannot
    // supply them. The format is validated STRICTLY so nothing but a hex
    // literal reaches a style attribute; an arbitrary string would.
    //
    // Normalised to uppercase so #ef4444 and #EF4444 are the same colour for
    // the uniqueness check below, rather than two rows that look identical.
    const HEX = /^#[0-9a-fA-F]{6}$/;
    let color: string;
    if (colorRaw != null && colorRaw !== "") {
      if (!HEX.test(colorRaw)) {
        res.status(400).json({ message: "color must be a #RRGGBB hex value" });
        return;
      }
      color = colorRaw.toUpperCase();
    } else {
      color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)].toUpperCase();
    }
    const group = typeof tagGroup === "string" && tagGroup.trim() ? tagGroup.trim() : null;
    try {
      const existing = await query(`SELECT id, name, color, tag_group, sort_order FROM tags WHERE LOWER(name) = LOWER($1)`, [trimmed]);
      if (existing.rows.length > 0) { res.json(existing.rows[0]); return; }

      // §20 "all colours distinct" is ENFORCED here (2026-10-13), not just
      // documented. The colour is the only thing separating two chips at a
      // glance on a row, so a repeat makes two different tags read as one.
      // Checked case-insensitively — both sides are stored uppercase, but a
      // row predating that normalisation may not be.
      const clash = await query(`SELECT name FROM tags WHERE UPPER(color) = $1 LIMIT 1`, [color]);
      if (clash.rows.length > 0) {
        res.status(400).json({ message: `color already in use by ${clash.rows[0].name}` });
        return;
      }
      // sort_order within a group: append. NULL for ungrouped, matching the
      // ORDER BY in GET /api/tags (ungrouped sorts by name).
      const result = await query(
        // $3 is cast to ::text at EVERY use. Without that, postgres sees it
        // as a value, a CASE operand and a comparison operand and refuses:
        // "inconsistent types deduced for parameter $3".
        `INSERT INTO tags (name, color, tag_group, sort_order)
         VALUES ($1, $2, $3::text,
                 CASE WHEN $3::text IS NULL THEN NULL
                      ELSE (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tags WHERE tag_group = $3::text) END)
         RETURNING id, name, color, tag_group, sort_order`,
        [trimmed, color, group]
      );
      res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // §20 deletion cascade: asin_tags has ON DELETE CASCADE, so removing the tag
  // row removes its associations and leaves the ASINs themselves untouched.
  // Returns the number of ASINs that lost the tag so the caller can report it.
  //
  // Added 2026-10-13 with the filter-dropdown management UI — there was no
  // tag delete endpoint before; tags could only be removed with SQL.
  app.delete("/api/tags/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const tag = await query(`SELECT id, name FROM tags WHERE id = $1`, [id]);
      if (tag.rows.length === 0) { res.status(404).json({ message: "Tag not found" }); return; }
      const n = (await query(`SELECT count(*)::int AS n FROM asin_tags WHERE tag_id = $1`, [id])).rows[0]?.n ?? 0;
      await query(`DELETE FROM tags WHERE id = $1`, [id]);
      res.json({ ok: true, name: tag.rows[0].name, asinsAffected: n });
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

  // §6 Lead Source inline edit. §14 USER-CONTROLLED: this and the INSERT
  // paths (CSV upload, sourcing sync, bulk promote) are the only writers —
  // Analyze, Product Info and Prices & Stock never touch it.
  //
  // Single-select: null clears it. An unrecognised value is REJECTED rather
  // than coerced — the DB CHECK would reject it anyway, and a 400 naming the
  // allowed set is more useful than a constraint-violation 500.
  app.put("/api/asins/:asin/lead-source", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { leadSource } = req.body as { leadSource?: string | null };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const value = leadSource == null || leadSource === "" ? null : normalizeLeadSource(leadSource);
    if (leadSource != null && leadSource !== "" && value == null) {
      res.status(400).json({ message: `lead_source must be one of: ${LEAD_SOURCES.join(", ")}` });
      return;
    }
    try {
      const r = await query(`UPDATE asins SET lead_source = $2 WHERE asin = $1 RETURNING lead_source`, [asin, value]);
      if (r.rowCount === 0) { res.status(404).json({ message: "ASIN not found" }); return; }
      res.json({ ok: true, leadSource: r.rows[0].lead_source ?? null });
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

  // Promos (promo_notes) — same pattern as notes. MANUAL EDIT ONLY (§14):
  // analyze and re-syncs never write this field; sourcing sync touches it
  // solely on the new-ASIN INSERT branch. Empty/whitespace → NULL, never ''.
  app.put("/api/asins/:asin/promos", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { promo_notes } = req.body as { promo_notes?: string | null };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (promo_notes != null && typeof promo_notes !== "string") {
      res.status(400).json({ message: "promo_notes must be a string or null" }); return;
    }
    const value = typeof promo_notes === "string" && promo_notes.trim() ? promo_notes.trim() : null;
    try {
      await query(`UPDATE asins SET promo_notes = $2 WHERE asin = $1`, [asin, value]);
      res.json({ ok: true, promoNotes: value });
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

  // === Sourcing type ===
  app.put("/api/asins/:asin/sourcing-type", async (req: Request, res: Response) => {
    const { asin } = req.params;
    const { is_wholesale, is_oa } = req.body as { is_wholesale?: boolean; is_oa?: boolean };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const sets: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      if (is_wholesale !== undefined) { sets.push(`is_wholesale = $${idx++}`); vals.push(!!is_wholesale); }
      if (is_oa !== undefined) { sets.push(`is_oa = $${idx++}`); vals.push(!!is_oa); }
      if (sets.length === 0) { res.status(400).json({ message: "No fields to update" }); return; }
      vals.push(asin);
      await query(`UPDATE asins SET ${sets.join(", ")} WHERE asin = $${idx}`, vals);
      const row = await query(`SELECT is_wholesale, is_oa FROM asins WHERE asin = $1`, [asin]);
      res.json({ isWholesale: row.rows[0]?.is_wholesale ?? false, isOa: row.rows[0]?.is_oa ?? false });
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
      // created_by dropped by migration 050 (always NULL, never written).
      const result = await query(`SELECT id, name, description, config, is_default, created_at FROM view_presets ORDER BY is_default DESC, name`);
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
        `SELECT available_fba, reserved, inbound_shipped + inbound_receiving AS inbound FROM inventory_snapshots WHERE asin_id = $1 ORDER BY snapshot_at DESC LIMIT 1`,
        [asinId]
      );
      const estRow = await query(`SELECT cogs FROM asin_estimates WHERE asin = $1`, [asin]);
      // On-order figures from the PO tables (patch asins-on-order-from-pos §3.3).
      const pl = (await loadAsinPipeline((sql, params) => query(sql, params), [String(asin)])).get(String(asin).toUpperCase()) ?? EMPTY_PIPELINE;
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
          on_order: pl.on_order,
          at_prep: pl.at_prep,
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

  const runAnalyzeCore: RunAnalyzeCore = async function (
    asins: AsinInput[],
    emit: (chunk: string) => void,
    progressPrefix: (i: number) => string | null,
    fromCsvUpload: boolean,
    sink: AnalyzeSink,
    opts: { dryRun?: boolean } = {},
  ) {
    const dryRun = opts.dryRun === true;
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 2000;

    const allResults: Map<string, AsinResult> = new Map();
    const retryQueue: { input: AsinInput; attempt: number; result: AsinResult }[] = [];

    // ── §11 Product Info batched pre-fetch (2026-09-07) ─────────────────────
    // Catalog via searchCatalogItems (20/call, 40 ASINs/s) and fees via the
    // batch feesEstimate (20/call, 10/s) replace the per-ASIN 1 rps loops
    // (~37 min full catalog → ~7 min, gating-bound). Prices are NOT fetched:
    // Prices & Stock owns them; fees use the STORED price via
    // getFeePriceForAsin, and no stored price → fees skipped
    // (skipped_no_price), never a fallback-price estimate.
    const runStartedAt = new Date();
    const rateBaseline = rateLimitStats(); // per-run deltas, same as Prices & Stock
    const asinList = asins.map((a) => a.asin);
    const catalogMap = await fetchCatalogBatch(asinList);

    const storedRows = await pool.query(
      `SELECT a.asin, a.is_hazmat, a.gating_checked_at, a.hazmat_checked_at,
              e.lowest_fba_price, e.buy_box_price, e.lowest_price, e.bsr_category, e.eligibility_status,
              e.sellers_fba, e.sellers_fbm
         FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin
        WHERE a.asin = ANY($1::text[])`,
      [asinList],
    );
    const storedByAsin = new Map<string, any>(storedRows.rows.map((r: any) => [r.asin, r]));

    const num = (v: any) => (v != null ? parseFloat(v) : null);
    const storedPricing = (asin: string): AsinResult["pricingData"] => {
      const r = storedByAsin.get(asin);
      return {
        lowestFbaPrice: num(r?.lowest_fba_price), buyBoxPrice: num(r?.buy_box_price),
        buyBoxFulfillment: null, lowestPrice: num(r?.lowest_price),
        avg30DayPrice: null, avg90DayPrice: null,
        numberOfSellers: null, sellersFba: r?.sellers_fba ?? null, sellersFbm: r?.sellers_fbm ?? null,
      };
    };

    const feeItems: Array<{ asin: string; price: number; category?: string | null }> = [];
    const feesSkippedNoPrice = new Set<string>();
    for (const asin of asinList) {
      const { price, isFallback } = getFeePriceForAsin(storedPricing(asin));
      if (isFallback) feesSkippedNoPrice.add(asin);
      else feeItems.push({ asin, price, category: storedByAsin.get(asin)?.bsr_category ?? null });
    }
    const feesMap = await fetchFeesBatch(feeItems);

    // §11 (2026-10-07): Product Info probes EVERYTHING in its working set.
    // The 30-day gating/hazmat scope is GONE — no threshold constant, no
    // staleness predicate, no per-stage scope sets, no reuse-stored branch.
    // (Named without the old identifiers on purpose: the gate greps for them.)
    // Its assumption
    // ("gating rarely flips inside 30 days") was wrong: B00P0OYZ66 flipped in
    // under 3 days and AF served the stale 'yes' because no probe was ever
    // allowed to replace it. A shorter window would be the same bug, smaller.
    // gating_checked_at / hazmat_checked_at remain as probe STAMPS only.
    //
    // Per-ASIN outcomes for ALL FOUR stages, in the Prices & Stock shape
    // (Record<string, string>, ASIN -> outcome, failure message appended as
    // price-sync.ts:198 does). Until now every Product Info stage wrote
    // outcomes = '{}', so which ASIN a run touched could not be proven from
    // the ledger — the same disease as a skip.
    const stageCounts: Record<string, Record<string, number>> = {
      catalog: { updated: 0, absent: 0, inconclusive: 0, error: 0 },
      fees: { updated: 0, skipped_no_price: feesSkippedNoPrice.size, error: 0 },
      gating: { updated: 0, error: 0 },
      hazmat: { updated: 0, error: 0 },
      // §11 (2026-10-11): the listings reconcile runs here too, filled in
      // after the per-ASIN loop from runFullScopePass's own report.
      listings: { probed: 0, live: 0, no_offer: 0, transient: 0, flips: 0, discoveries: 0 },
    };
    const stageOutcomes: Record<string, Record<string, string>> = {
      catalog: {}, fees: {}, gating: {}, hazmat: {}, listings: {},
    };
    // fees' missing-input skip is recorded up front — it is decided before the
    // loop, from the stored price, and is the ONE surviving skip (a missing
    // INPUT, not a freshness heuristic).
    for (const asin of Array.from(feesSkippedNoPrice)) stageOutcomes.fees[asin] = "skipped_no_price";

    // Which stamps each ASIN earned from a `kind: "ok"` probe. The stamp
    // WRITE happens later, in writeResult, behind the sink's INSERT — see
    // ProbeStampWrite. This map is the hand-off; nothing else reads it.
    const probeStamps = new Map<string, { gating: boolean; hazmat: boolean }>();
    const stampsFor = (asin: string): ProbeStampWrite | null => {
      const s = probeStamps.get(asin);
      if (!s || (!s.gating && !s.hazmat)) return null;
      return {
        gating: s.gating,
        hazmat: s.hazmat,
        // A stamp that did not land demotes `updated` -> `error` for that
        // stage. The counts move with the outcome so the two can never
        // disagree, and Retry failed re-asks the ASIN (error: prefix).
        // Guarded on the CURRENT outcome because writeResult can run twice
        // for one ASIN (the partial first-pass write, then the retry
        // `_update`); an ungated decrement would double-count.
        onError: (msg: string) => {
          for (const stage of ["gating", "hazmat"] as const) {
            if (!s[stage]) continue;
            if (stageOutcomes[stage][asin] !== "updated") continue;
            stageCounts[stage].updated--;
            stageCounts[stage].error++;
            stageOutcomes[stage][asin] = `error: stamp write failed: ${msg}`;
          }
        },
      };
    };

    for (let i = 0; i < asins.length; i++) {
      const input = asins[i];

      const prefix = progressPrefix(i);
      const progressAsin = prefix ? `${prefix} ${input.asin}` : input.asin;
      emit(
        JSON.stringify({
          type: "progress",
          data: { current: i + 1, total: asins.length, asin: progressAsin },
        }) + "\n"
      );

      let result: AsinResult;

      try {
        // ── batch lookups (§11 Product Info, 2026-09-07) ──
        const pricingData = storedPricing(input.asin); // Prices & Stock owns prices
        const stored = storedByAsin.get(input.asin);

        const catEntry = catalogMap.get(input.asin);
        let catalogData: AsinResult["catalogData"];
        if (catEntry?.kind === "parsed") {
          stageCounts.catalog.updated++;
          stageOutcomes.catalog[input.asin] = "updated";
          catalogData = catEntry.data as AsinResult["catalogData"];
        } else if (catEntry?.kind === "absent") {
          // DA-2 batch analogue of the 404: absent from a COMPLETE response.
          stageCounts.catalog.absent++;
          stageOutcomes.catalog[input.asin] = "absent";
          catalogData = { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null, isDangerousGood: null, isCatalogDeleted: true } as any;
        } else {
          // thrown call → inconclusive for every ASIN in it — fail-closed.
          stageCounts.catalog.inconclusive++;
          stageOutcomes.catalog[input.asin] = "inconclusive";
          catalogData = { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null, isDangerousGood: null, isCatalogDeleted: null } as any;
        }

        // gating + hazmat: probe EVERY ASIN in the working set, every time
        // (§11, 2026-10-07). The stored value is the starting point only so a
        // dry run (which probes nothing) still renders something truthful.
        let eligibilityData: AsinResult["eligibilityData"] = { status: (stored?.eligibility_status as any) ?? "check" };
        let hazmatFlag: boolean | null = stored?.is_hazmat ?? null;
        if (!dryRun) {
          // §11 (2026-10-07): a FAILED probe writes NOTHING — no fallback
          // value, no stamp move — and records error:<msg>. The stored value
          // stands until a probe succeeds; a throttle is not evidence that a
          // known `no` became unknown. Retry failed picks these up.
          const eligProbe = await getEligibility(input.asin);
          if (eligProbe.kind === "ok") {
            eligibilityData = { status: eligProbe.status };
            stageCounts.gating.updated++;
            stageOutcomes.gating[input.asin] = "updated";
            // Stamp is EARNED here, WRITTEN in writeResult — the asins row
            // may not exist yet (§14, 2026-10-09).
            probeStamps.set(input.asin, { ...(probeStamps.get(input.asin) ?? { gating: false, hazmat: false }), gating: true });
          } else {
            // eligibilityData keeps the STORED status (set above). The
            // asin_estimates write is an unconditional overwrite, so writing
            // the stored value back is a no-op; the stamp is NOT touched.
            stageCounts.gating.error++;
            stageOutcomes.gating[input.asin] = `error: ${eligProbe.message}`;
            log(`Gating probe failed for ${input.asin}: ${eligProbe.message}`, "analyzer");
          }

          const hzProbe = await getInboundHazmat(input.asin);
          if (hzProbe.kind === "ok") {
            hazmatFlag = hzProbe.isHazmat;
            stageCounts.hazmat.updated++;
            stageOutcomes.hazmat[input.asin] = "updated";
            probeStamps.set(input.asin, { ...(probeStamps.get(input.asin) ?? { gating: false, hazmat: false }), hazmat: true });
          } else {
            // hazmatFlag keeps the stored value; is_hazmat is COALESCE'd on
            // write anyway, and the stamp is NOT touched.
            stageCounts.hazmat.error++;
            stageOutcomes.hazmat[input.asin] = `error: ${hzProbe.message}`;
            log(`Hazmat probe failed for ${input.asin}: ${hzProbe.message}`, "analyzer");
          }
        }
        catalogData.isHazmat = hazmatFlag;

        let feesData: AsinResult["feesData"] = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
        const feeEntry = feesMap.get(input.asin);
        if (feeEntry?.kind === "parsed") {
          feesData = feeEntry.fees;
          stageCounts.fees.updated++;
          stageOutcomes.fees[input.asin] = "updated";
        } else if (feeEntry?.kind === "error") {
          stageCounts.fees.error++;
          stageOutcomes.fees[input.asin] = `error: ${feeEntry.message ?? "unknown"}`;
          log(`Fees error for ${input.asin}: ${feeEntry.message}`, "analyzer");
        }

        result = buildResult(input, pricingData, catalogData, feesData, false, eligibilityData);
        if (feesSkippedNoPrice.has(input.asin)) (result as any)._feesSkippedNoPrice = true;
      } catch (err: any) {
        log(`Error processing ${input.asin}: ${err.message}\n${err.stack}`, "analyzer");
        result = {
          asin: input.asin,
          cogs: input.cogs,
          estimatedCogs: null,
          actualCogs: null,
          buyLink: input.buyLink ?? null,
          prepOverride: null,
          storageOverride: null,
          supplierSku: input.supplierSku ?? null,
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
          await writeResult(emit, allResults, input.asin, result, false, fromCsvUpload, input.notes ?? null, input.promoNotes ?? null, sink, input.tags ?? null, stampsFor(input.asin), input.leadSource ?? null);
        }
      } else {
        await writeResult(emit, allResults, input.asin, result, false, fromCsvUpload, input.notes ?? null, input.promoNotes ?? null, sink, input.tags ?? null, stampsFor(input.asin), input.leadSource ?? null);
      }

      // Tags and notes both ride inside writeResult now — tags AFTER the
      // asins INSERT commits (2026-09-27), notes atomically on the INSERT
      // branch for new ASINs / appendNotesForAsin (dedup) for existing. Both
      // were fire-and-forget once; notes lost ~152 rows in a 7-day window and
      // tags lost every CSV tag on a brand-new ASIN.

      // No inter-batch sleep: the loop makes no unpaced API calls — the only
      // remaining per-ASIN calls (scoped gating/hazmat) go through the rate
      // limiter, which paces at the wire (§11, 2026-09-07).
    }

    if (retryQueue.length > 0) {
      log(`Starting retry phase: ${retryQueue.length} ASINs to retry`, "retry");

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const currentBatch = retryQueue.filter((r) => r.attempt === attempt);
        if (currentBatch.length === 0) break;

        log(`Retry attempt ${attempt}: ${currentBatch.length} ASINs`, "retry");
        await delay(RETRY_DELAY);

        emit(
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
              // Hazmat comes from COMMINGLING, not the catalog fetch. Retries
              // never re-probe COMMINGLING, so carry the first-pass value.
              catalogData.isHazmat = item.result.catalogData.isHazmat;
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
              await writeResult(emit, allResults, item.input.asin, finalResult, allResults.has(item.input.asin), fromCsvUpload, item.input.notes ?? null, item.input.promoNotes ?? null, sink, item.input.tags ?? null, stampsFor(item.input.asin), item.input.leadSource ?? null);
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
              await writeResult(emit, allResults, item.input.asin, errorResult, allResults.has(item.input.asin), fromCsvUpload, item.input.notes ?? null, item.input.promoNotes ?? null, sink, item.input.tags ?? null, stampsFor(item.input.asin), item.input.leadSource ?? null);
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
          await writeResult(emit, allResults, item.input.asin, errorResult, false, fromCsvUpload, item.input.notes ?? null, item.input.promoNotes ?? null, sink, item.input.tags ?? null, stampsFor(item.input.asin), item.input.leadSource ?? null);
        }
      }
      if (uncalculated.length > 0) {
        log(`=== RETRY SUMMARY: ${uncalculated.length} ASINs still uncalculated: ${uncalculated.join(", ")} ===`, "retry");
      }
    }

    // ── §11 listings reconcile (2026-10-11) ────────────────────────────────
    // §18 principle 2: every sync that touches an ASIN re-probes it. This is
    // the SAME runFullScopePass the Prices & Stock listings stage runs —
    // one implementation, never a parallel copy — scoped to Product Info's
    // working set. Before this an ASIN could be fully re-synced here while
    // has_live_offer kept whatever a previous run left behind.
    //
    // Dry-run probes and reports identically but writes nothing, exactly as
    // the pass's own dryRun does.
    try {
      // §18 phase c here ONLY when the working set is the full catalog
      // (§11). A selection-scoped Product Info run reconciles the selection;
      // pulling 41 pages of account listings for three ASINs would be noise.
      const totalAsins = Number(
        (await query(`SELECT count(*)::int AS n FROM asins`)).rows[0]?.n ?? 0,
      );
      const fullCatalog = totalAsins > 0 && asinList.length >= totalAsins;
      const lr = await runFullScopePass({
        dryRun,
        asinFilter: new Set(asinList),
        phaseC: fullCatalog,
        onboard: onboardScDiscoveries,
        emit: (ev) => emit(JSON.stringify({ type: "progress", data: { current: ev.done ?? 0, total: ev.total ?? 0, asin: `Listings: ${ev.asin ?? ev.phase ?? ""}` } }) + "\n"),
      });
      stageCounts.listings = {
        probed: lr.phaseA.asins + lr.phaseB.asins,
        live: lr.phaseA.live, no_offer: lr.phaseA.noOffer,
        transient: lr.phaseA.transientSkipped + lr.phaseB.transientSkipped,
        flips: lr.phaseA.flips.length,
        discoveries: lr.phaseA.discoveries.length + lr.phaseB.discovered.length,
      };
      stageOutcomes.listings = lr.outcomes;
    } catch (err: any) {
      // A failed stage does not abort the others (§11). Record it against
      // the stage rather than losing the whole run.
      log(`Product Info listings reconcile failed: ${err?.message ?? err}`, "analyzer");
      stageCounts.listings.error = (stageCounts.listings.error ?? 0) + 1;
      stageOutcomes.listings["_stage"] = `error: ${err?.message ?? err}`;
    }

    // ── §11 Product Info run ledger + summary (2026-09-07) ──────────────────
    // Same machinery as Prices & Stock: one refresh_runs row per stage
    // (catalog / fees / gating / hazmat), rate-limit deltas via the caller's
    // stream, per-ASIN outcomes.
    //
    // Dry-run writes no ledger rows and lists EVERY ASIN in scope under every
    // stage (§11, 2026-10-07). There is no "which ASINs the 30-day rule would
    // probe" set any more — the rule is gone, so the answer is always "all of
    // them", which is what `scope` says.
    emit(JSON.stringify({
      type: "product_info_summary",
      data: {
        dryRun,
        stages: stageCounts,
        rateLimits: rateLimitStatsSince(rateBaseline),
        ...(dryRun ? { scope: asinList } : { outcomes: stageOutcomes }),
      },
    }) + "\n");
    if (!dryRun) {
      for (const [stage, counts] of Object.entries(stageCounts)) {
        try {
          await query(
            // Per-ASIN outcomes, same shape as the Prices & Stock stages
            // (§11, 2026-10-07 — this used to be a hardcoded '{}').
            `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes)
             VALUES ($1, NOW(), 'manual', $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [runStartedAt, stage, "subset", asinList.length, JSON.stringify(counts),
             JSON.stringify(stageOutcomes[stage as keyof typeof stageOutcomes] ?? {})],
          );
        } catch (err: any) {
          log(`refresh_runs write failed for Product Info stage ${stage}: ${err?.message ?? err}`, "refresh");
        }
      }
    }
  };
  runAnalyzeCoreRef = runAnalyzeCore;

  // ── New-ASIN onboarding (§11, 2026-09-09) ────────────────────────────
  // ONE shared sequence for every path that inserts new ASINs (upload,
  // sourcing sheet, extension, backfill, SC discovery, Bulk Calc promote).
  // Scheduler v1 (2026-10-15): the rows are created with the user-supplied
  // fields only (insertOnly — COGS, buy link, notes, promo, supplier SKU,
  // lead source, tags) and ONE Refresh job is enqueued for them with the
  // daily block included. Its own stage order is gone: catalog, hazmat,
  // gating, prices, fees and everything else come from the job, in the
  // one fixed order, ledgered under trigger `onboarding`. No insert path
  // may call runAnalyzeCore directly.
  async function onboardNewAsins(
    asins: AsinInput[],
    emit: (chunk: string) => void,
    sink: AnalyzeSink,
    // 'sc_discovery' added 2026-10-11 (§18 phase c, migration 046): the ASIN
    // came from the SC account list, not from an upload/sheet/extension.
    trigger: "upload" | "sourcing" | "extension" | "backfill" | "sc_discovery",
    progressPrefix: (i: number) => string | null = () => null,
  ): Promise<{ jobId: number | null }> {
    // Dedupe (2026-10-18): exactly this ASIN set was onboarded in the last 10 minutes —
    // refused, not re-run (nothing inserted, no job). The page clears its pending upload.
    const dup = await findRecentSameOnboarding(asins.map((a) => a.asin), (sql, params) => query(sql, params)).catch(() => null);
    if (dup) {
      emit(JSON.stringify({ type: "job_duplicate", data: { jobId: dup.id, status: dup.status, asins: asins.length } }) + "\n");
      log(`Onboarding (${trigger}): refused — the same ${asins.length} ASIN(s) were onboarded as job #${dup.id} (${dup.status}) within ${ONBOARDING_DEDUPE_MINUTES} min`, "refresh");
      return { jobId: null };
    }
    await insertNewAsinRows(asins, emit, sink, progressPrefix);
    let jobId: number | null = null;
    try {
      // Only rows that actually exist get a job; an ASIN that failed to
      // insert is logged with the reason and not re-enqueued by this call.
      const wanted = asins.map((a) => a.asin.toUpperCase());
      const present = new Set((await query(`SELECT asin FROM asins WHERE asin = ANY($1::text[])`, [wanted])).rows.map((r: any) => String(r.asin)));
      const missing = wanted.filter((a) => !present.has(a));
      if (missing.length > 0) log(`Onboarding (${trigger}): ${missing.length} ASIN(s) not inserted (no asins row after insert) — not enqueued: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`, "refresh");
      const r = await enqueueOnboardingJob(wanted.filter((a) => present.has(a)));
      if (r.covered.length > 0) log(`Onboarding (${trigger}): ${r.covered.length} ASIN(s) already covered by a queued/running onboarding job — not re-enqueued`, "refresh");
      if (r.job) {
        jobId = r.job.id;
        emit(JSON.stringify({ type: "job_queued", data: { jobId: r.job.id, asins: r.enqueued.length } }) + "\n");
        log(`Onboarding (${trigger}): ${asins.length} row(s) created; refresh job #${r.job.id} queued for ${r.enqueued.length}`, "refresh");
      } else {
        log(`Onboarding (${trigger}): ${asins.length} row(s) created; nothing to enqueue`, "refresh");
      }
    } catch (err: any) {
      log(`Onboarding (${trigger}): rows created but the refresh job could not be queued — run Refresh for them: ${err?.message ?? err}`, "refresh");
    }
    return { jobId };
  }
  // The INSERT half of onboarding: the rows, user-supplied fields only
  // (insertOnly). Shared with the sales component's onboarding (below), which
  // inserts per report chunk and enqueues ONE job for all of them at the end.
  async function insertNewAsinRows(
    asins: AsinInput[],
    emit: (chunk: string) => void,
    sink: AnalyzeSink,
    progressPrefix: (i: number) => string | null = () => null,
  ): Promise<void> {
    const allResults = new Map<string, AsinResult>();
    const blankPricing: AsinResult["pricingData"] = {
      lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null,
      avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null,
    };
    const blankCatalog = { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null, isDangerousGood: null, isCatalogDeleted: null } as AsinResult["catalogData"];
    const blankFees: AsinResult["feesData"] = { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
    for (let i = 0; i < asins.length; i++) {
      const input = asins[i];
      const prefix = progressPrefix(i);
      emit(JSON.stringify({ type: "progress", data: { current: i + 1, total: asins.length, asin: prefix ? `${prefix} ${input.asin}` : input.asin } }) + "\n");
      const result = buildResult(input, blankPricing, blankCatalog, blankFees, false, { status: "check" });
      await writeResult(emit, allResults, input.asin, result, false, true, input.notes ?? null, input.promoNotes ?? null, sink, input.tags ?? null, null, input.leadSource ?? null, true);
    }
  }
  onboardNewAsinsRef = onboardNewAsins;

  // Sales onboarding (2026-10-16): an ASIN the orders report names that AF
  // does not have at all. Same insert path as every other onboarding, tag
  // "Sales import" for provenance (the SC-discovery precedent — lead_source
  // is user-controlled and CHECK-constrained, §14, so it stays NULL). The
  // sales component calls this per report chunk, before the chunk's upsert,
  // and enqueues ONE Refresh job for all of them when the sync ends.
  async function onboardSalesAsins(asins: string[]): Promise<void> {
    if (asins.length === 0) return;
    const inputs: AsinInput[] = asins.map((asin) => ({
      asin,
      cogs: 0,                       // placeholder for the shape, never stored (fromCsvUpload=false)
      buyLink: null,
      prepOverride: null,
      storageOverride: null,
      tags: ["Sales import"],        // §20; applied after the INSERT by writeResult
      notes: null,
      promoNotes: null,
      supplierSku: null,
      addedAtRaw: null,
    } as AsinInput));
    await insertNewAsinRows(inputs, () => {}, mainCatalogSink);
    log(`Onboarding (sales): ${asins.length} row(s) created from the orders report: ${asins.slice(0, 20).join(", ")}${asins.length > 20 ? "…" : ""}`, "refresh");
  }
  onboardSalesAsinsRef = onboardSalesAsins;

  // §18 Part B phase c (2026-10-11): onboard the ASINs SC has that AF does
  // not. Injected into runFullScopePass so full-scope-pass.ts never imports
  // this module.
  //
  // Goes through onboardNewAsins — the ONE insert path (§14) — so these rows
  // get Product Info -> prices -> fees exactly like a CSV upload, on one
  // stream. The buy link / supplier / tag are INSERT-BRANCH ONLY: AsinInput
  // carries them, upsertAsinResult writes them on INSERT and never on
  // conflict, which is the same precedent as the sourcing sync's promo_notes
  // and bulk promote's buy_link. Phase c only ever sees ASINs with no row,
  // so there is nothing to overwrite — but the guarantee is structural, not
  // circumstantial.
  async function onboardScDiscoveries(rows: OnboardResolution[]): Promise<void> {
    if (rows.length === 0) return;
    const inputs: AsinInput[] = rows.map((r) => ({
      asin: r.asin,
      cogs: 0,                       // never a synthetic zero in the DB — see below
      buyLink: r.buyLink,
      prepOverride: null,
      storageOverride: null,
      tags: ["SC import"],           // §20; applied after the INSERT by writeResult
      notes: null,
      promoNotes: null,
      supplierSku: null,
      addedAtRaw: null,
    } as AsinInput));

    // fromCsvUpload=false: cogs 0 here is a placeholder for the AsinInput
    // shape, NOT a value to store. upsertCsvCogs is the only thing that would
    // persist it and it is gated on fromCsvUpload, so estimated_cogs stays
    // NULL and the UI renders $0.00 from nothing — §18 phase c step 2.
    await onboardNewAsins(inputs, () => {}, mainCatalogSink, "sc_discovery");

    // (in_catalog retired 2026-10-15, migration 052 — the discovery latch it
    // set here was read by nothing; has_live_offer below is the fact.)
    const asins = rows.map((r) => r.asin);

    // supplier rides the INSERT branch too, derived from the buy link the
    // same way the Buy Link column edit derives it.
    for (const r of rows) {
      if (!r.supplier) continue;
      await query(`UPDATE asins SET supplier = $2 WHERE asin = $1 AND supplier IS NULL`, [r.asin, r.supplier])
        .catch((err: any) => log(`Phase c: supplier write failed for ${r.asin}: ${err?.message ?? err}`, "full-scope"));
    }

    // asin_skus for every SKU SC returned, primary per the existing rules
    // (amzn.gr.* never primary; first real SKU bootstraps when none exists).
    for (const r of rows) {
      const real = r.skus.filter((sku) => !sku.toLowerCase().startsWith("amzn.gr."));
      for (let i = 0; i < r.skus.length; i++) {
        await query(
          `INSERT INTO asin_skus (asin_id, sku, is_primary)
           SELECT id, $2, $3 FROM asins WHERE asin = $1
           ON CONFLICT (asin_id, sku) DO NOTHING`,
          [r.asin, r.skus[i], r.skus[i] === real[0]],
        ).catch((err: any) => log(`Phase c: asin_skus insert failed for ${r.asin}/${r.skus[i]}: ${err?.message ?? err}`, "full-scope"));
      }
      if (real[0]) {
        await query(`UPDATE asins SET primary_sku = $2 WHERE asin = $1 AND primary_sku IS NULL`, [r.asin, real[0]])
          .catch(() => {});
      }
    }

    // The FLAG, through the A2 primitive, outcome `onboarded` (§18 A2). The
    // ASIN is listed by construction — it came from the account list, which
    // is A1-filtered — so this is a verdict, not a guess.
    const onboardOutcomes: Record<string, string> = {};
    for (const r of rows) {
      await writeLiveOfferVerdict(
        {
          asin: r.asin, prevFlag: null, listed: true,
          buyable: false,   // §23: BUYABLE comes from a per-SKU probe, not the
                            // account list; the next reconcile fills it in.
          issues: [], event: "onboarded",
          detail: `SKUs ${r.skus.join(", ")} · COGS ${r.cogsSource} · link ${r.buyLinkSource}`,
        },
        { query: (sql, params) => query(sql, params), outcomes: (a, o) => { onboardOutcomes[a] = o; } },
      );
    }

    // upsertAsinResult's INSERT branch always writes estimated_cogs from
    // AsinInput.cogs, tagged 'csv'. Phase c has no COGS to supply, so the 0
    // placeholder landed as a synthetic 0.00 labelled as a CSV upload —
    // exactly what §18 phase c step 2 forbids ("COGS stays NULL; no
    // synthetic zero stored"). Found on the first live run (2026-10-13).
    //
    // Cleared here rather than by changing upsertAsinResult, whose INSERT
    // behaviour the CSV/sourcing/extension paths all depend on. The guard is
    // tight enough that it can only undo what this onboarding just wrote: a
    // 0 value, sourced 'csv', on an ASIN this call created. It runs BEFORE
    // the PO sync so a PO'd ASIN still gets its real COGS.
    await query(
      `UPDATE asin_estimates SET estimated_cogs = NULL, estimated_cogs_source = NULL
        WHERE asin = ANY($1::text[]) AND estimated_cogs = 0 AND estimated_cogs_source = 'csv'`,
      [asins],
    ).catch((err: any) => log(`Phase c: synthetic-COGS clear failed: ${err?.message ?? err}`, "full-scope"));

    // COGS: ASINs with Orders-sheet rows get the real PO sync, scoped to
    // them, so actual_cogs / cogs_source='po_sheet' / prep_override land the
    // same way they do for any PO'd ASIN. No Orders rows → COGS stays NULL.
    const poAsins = rows.filter((r) => r.cogsSource === "po_sheet").map((r) => r.asin);
    if (poAsins.length > 0) {
      await runSheetsSync(new Set(poAsins))
        .catch((err: any) => log(`Phase c: scoped PO sync failed: ${err?.message ?? err}`, "full-scope"));
    }

    log(`Phase c onboarded ${rows.length} ASIN(s): ${rows.map((r) => `${r.asin}(${r.cogsSource}/${r.buyLinkSource})`).join(", ")}`, "full-scope");
  }

  onboardScDiscoveriesRef = onboardScDiscoveries;

  // Thin streaming wrapper for the main-catalog endpoints. The sink is
  // required here too — each endpoint names mainCatalogSink explicitly.
  // fromCsvUpload=true routes through onboardNewAsins (§11): the set may
  // contain brand-new ASINs, which Product Info alone would leave
  // priceless. Existing ASINs in the set just get a fresh price+fee pass.
  async function runAnalyzeAndStream(
    asins: AsinInput[],
    res: Response,
    sink: AnalyzeSink,
    progressPrefix: (i: number) => string | null = () => null,
    fromCsvUpload = false,
    opts: { dryRun?: boolean } = {},
    trigger: "upload" | "sourcing" = "upload",
  ) {
    if (fromCsvUpload && !opts.dryRun && asins.length > 0) {
      await onboardNewAsins(asins, (chunk) => res.write(chunk), sink, trigger, progressPrefix);
      return;
    }
    await runAnalyzeCore(asins, (chunk) => res.write(chunk), progressPrefix, fromCsvUpload, sink, opts);
  }

  // (runPostAnalyzeBackgroundSyncs removed 2026-10-15: the unledgered
  // full-catalog PO sync + suppression sync are components 9 and 18.)

  // Analyze a user-supplied list of ASINs (typically from a fresh CSV upload).
  app.post("/api/analyze", async (req: Request, res: Response) => {
    const { asins: asinsRaw } = req.body as { asins: AsinInput[] };

    if (!asinsRaw || !Array.isArray(asinsRaw) || asinsRaw.length === 0) {
      res.status(400).json({ message: "No ASINs provided" });
      return;
    }
    // §21 asymmetry guard, NARROWED to dateAdded (2026-09-27). The MAIN
    // upload path parses promos + dateAdded via the shared mapper.
    //   promos — NOW WRITTEN, insert-only, exactly like notes. Reversed
    //     because a CSV that carries a discount code per row is the same kind
    //     of user-supplied field as Notes, and dropping it silently was
    //     indistinguishable from the tags bug reported the same day. The
    //     sourcing sheet keeps Col O for the ASINs it owns; these two writers
    //     don't collide because the CSV value only lands on INSERT — an
    //     existing ASIN's promo_notes is never touched from here.
    //   dateAdded — still dropped: `asins` has no backdatable added_at column
    //     (that is a §21 bulk-only field), so there is nothing to write it to.
    const asins: AsinInput[] = asinsRaw.map((a) => ({ ...a, addedAtRaw: null }));

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // §11 Product Info dry-run (2026-09-07): batch catalog + fees fetched
    // and reported, gating/hazmat scope listed, ZERO writes (no-op sink, no
    // checked_at stamps, no upload prices pre-pass, no background syncs).
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    if (dryRun) {
      const nullSink: AnalyzeSink = { persistResult: async () => {}, persistTags: async () => {}, persistProbeStamps: async () => {} } as any;
      await runAnalyzeAndStream(asins, res, nullSink, () => null, false, { dryRun: true });
      res.write(JSON.stringify({ type: "complete" }) + "\n");
      res.end();
      return;
    }

    // CSV upload: rows created with their COGS etc., then ONE refresh job
    // queued for them (scheduler v1). The PO-sheet and suppression syncs
    // that used to fire here are components 9 and 18 of that job.
    await runAnalyzeAndStream(asins, res, mainCatalogSink, () => null, true);
    res.write(JSON.stringify({ type: "complete" }) + "\n");
    res.end();
  });

  // Analyze all active ASINs from the DB in server-side batches of 100.
  // Used when re-analyzing the full catalog — avoids "request entity too large"
  // because the ASIN list is never sent in the request body.
  app.post("/api/analyze/all", async (req: Request, res: Response) => {
    // Scheduler v1 (2026-10-15): thin enqueuer for one more release, then
    // deleted. A full refresh (daily block included) for the given ASINs.
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const job = await enqueueJob({ trigger: "manual", includeDaily: true, scopeAsins: asins?.length ? asins : null, requestedBy: req.session?.userId ?? null });
    res.status(202).json({ job, deprecated: "POST /api/jobs" });
  });

  // === Prices: status (staleness indicator) + on-demand refresh ===
  app.get("/api/prices/status", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.json({ lastRefreshedAt: null }); return; }
    try {
      const row = await query(
        `SELECT MAX(e.fetched_at) AS last_refreshed
         FROM asin_estimates e
         JOIN asins a ON a.asin = e.asin
         WHERE a.status = 'active'`
      );
      const ts = row.rows[0]?.last_refreshed;
      res.json({ lastRefreshedAt: ts ? new Date(ts).toISOString() : null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/prices/refresh", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const { asins } = (req.body ?? {}) as { asins?: string[] };
    const filter = asins && asins.length > 0 ? new Set(asins) : undefined;

    try {
      const summary = await refreshPrices(async (p) => {
        res.write(JSON.stringify({ type: "progress", data: p }) + "\n");
      }, filter);
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
    // actual_cogs is PO-sync-only (§2, enforced 2026-08-30): the body param is
    // IGNORED — this was the sole writer of cogs_source='manual', now legacy/
    // unwritable. Estimated handling unchanged.
    const { estimated_cogs } = req.body as { estimated_cogs?: number };
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    if (estimated_cogs == null) {
      res.status(400).json({ message: "Provide estimated_cogs (actual_cogs is PO-sync-only and ignored)" }); return;
    }
    try {
      const sets: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      {
        if (typeof estimated_cogs !== "number" || !isFinite(estimated_cogs) || estimated_cogs < 0) {
          res.status(400).json({ message: "estimated_cogs must be a non-negative number" }); return;
        }
        sets.push(`estimated_cogs = $${idx++}`, `estimated_cogs_source = $${idx++}`);
        vals.push(estimated_cogs, "manual");
      }
      vals.push(asin);
      await query(`UPDATE asin_estimates SET ${sets.join(", ")} WHERE asin = $${idx}`, vals);
      const row = await query(`SELECT estimated_cogs, estimated_cogs_source, actual_cogs, cogs_source FROM asin_estimates WHERE asin = $1`, [asin]);
      const r = row.rows[0];
      res.json({
        estimatedCogs: r?.estimated_cogs != null ? parseFloat(r.estimated_cogs) : null,
        estimatedCogsSource: r?.estimated_cogs_source ?? null,
        actualCogs: r?.actual_cogs != null ? parseFloat(r.actual_cogs) : null,
        cogsSource: r?.cogs_source ?? null,
      });
    } catch (err: any) {
      log(`COGS update error for ${asin}: ${err.message}`, "cogs");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/asins/:asin/cogs/reset", async (req: Request, res: Response) => {
    const asin = String(req.params.asin ?? "");
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }

    try {
      // Clear the manual override first so the PO sync path can write to this ASIN.
      await query(
        `UPDATE asin_estimates SET cogs = NULL, cogs_source = NULL WHERE asin = $1`,
        [asin],
      );

      // The newest PO cost for this ASIN from the AF PO tables (po-af-owned §2.4).
      const { data: sheetData } = await loadAfAsinCostMap(query as any, [asin]);
      const entry = sheetData.get(asin);
      if (entry?.cogs != null) {
        await query(
          `UPDATE asin_estimates SET cogs = $2, actual_cogs = $2, cogs_source = 'po_sheet' WHERE asin = $1`,
          [asin, entry.cogs],
        );
        res.json({ cogs: entry.cogs, actualCogs: entry.cogs, cogsSource: "po_sheet" });
      } else {
        res.json({ cogs: null, cogsSource: null });
      }
    } catch (err: any) {
      log(`COGS reset error for ${asin}: ${err.message}`, "cogs");
      res.status(500).json({ message: err.message });
    }
  });

  // === Sync Est. COGS from PO — single ASIN ===
  app.post("/api/asins/:asin/cogs/sync-from-po", async (req: Request, res: Response) => {
    const asin = String(req.params.asin ?? "");
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const { data: sheetData } = await loadAfAsinCostMap(query as any, [asin]); // AF PO tables (po-af-owned §2.4)
      const entry = sheetData.get(asin);
      if (entry?.cogs == null) {
        res.json({ synced: false, message: "No PO data found for this ASIN" }); return;
      }
      await query(
        `UPDATE asin_estimates SET estimated_cogs = $2, estimated_cogs_source = 'po_sheet' WHERE asin = $1`,
        [asin, entry.cogs],
      );
      res.json({ synced: true, estimatedCogs: entry.cogs, estimatedCogsSource: "po_sheet" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Bulk Sync Est. COGS from PO ===
  app.post("/api/cogs/bulk-sync-from-po", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { asins: asinList } = req.body as { asins?: string[] };
    if (!asinList || !Array.isArray(asinList) || asinList.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }
    try {
      const { data: sheetData } = await loadAfAsinCostMap(query as any, asinList); // AF PO tables (po-af-owned §2.4)
      let synced = 0;
      let skipped = 0;
      for (const asin of asinList) {
        const entry = sheetData.get(asin);
        if (entry?.cogs == null) { skipped++; continue; }
        // Only overwrite manual/csv sources — po_sheet is already in sync
        const estCheck = await query(`SELECT estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [asin]);
        const src = estCheck?.rows?.[0]?.estimated_cogs_source;
        if (src === "po_sheet") { continue; } // already synced
        await query(
          `UPDATE asin_estimates SET estimated_cogs = $2, estimated_cogs_source = 'po_sheet' WHERE asin = $1`,
          [asin, entry.cogs],
        );
        synced++;
      }
      res.json({ synced, skipped });
    } catch (err: any) {
      log(`Bulk COGS sync error: ${err.message}`, "cogs");
      res.status(500).json({ message: err.message });
    }
  });

  // === PO module frame (docs/po-module-v1-frame-plan.md §3) ===
  //
  // READ-ONLY: the frame has no write endpoints (the importer is a script).
  // Rollups are computed in the query, never stored. units_received uses
  // SUM over line items' qty_received — an all-NULL group sums to NULL
  // (SQL semantics), which the UI renders as an em-dash, never 0.
  app.get("/api/pos", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const q = typeof req.query.search === "string" ? req.query.search.trim() : "";
    // §6.3: the Status token filter became the Action Items filter (any-of).
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
    const supplier = typeof req.query.supplier === "string" ? req.query.supplier.trim() : "";
    const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
    // §5 / D3: Status filter = open | closed | all; default view = Open only.
    const closedRaw = typeof req.query.closed === "string" ? req.query.closed.trim().toLowerCase() : "open";
    const closed = closedRaw === "closed" ? "closed" : closedRaw === "all" ? "all" : "open";
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const PAGE_SIZE = 25;

    const conds: string[] = [];
    const params: any[] = [];
    const add = (cond: string, val: any) => { params.push(val); conds.push(cond.replace("$?", `$${params.length}`)); };
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conds.push(`(p.order_id ILIKE $${n}
        OR EXISTS (SELECT 1 FROM po_asins a WHERE a.po_id = p.id AND a.asin ILIKE $${n})
        OR EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id AND l.product_name ILIKE $${n}))`);
    }
    // Action Items filter: any-of over action_items[] (values never contain
    // commas). Both facets accept comma-separated multi-selects: OR within a
    // facet, AND across facets.
    if (action) {
      const wanted = action.split(",").map((x) => x.trim());
      const items = wanted.filter((x) => (ACTION_ITEMS as readonly string[]).includes(x));
      // "Review Velocity" is derived (SPEC §26) — OR'd in from po_tracking.
      const review = wanted.includes(REVIEW_VELOCITY);
      const any: string[] = [];
      if (items.length > 0) { params.push(items); any.push(`EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id AND l.action_items && $${params.length}::text[])`); }
      if (review) any.push(REVIEW_VELOCITY_EXISTS_SQL);
      // The pack-size items are derived from po_asins (2026-10-29).
      if (wanted.includes(PACK_SIZE_MISSING)) any.push(PACK_SIZE_MISSING_EXISTS_SQL);
      if (wanted.includes(PACK_SIZE_MISMATCH)) any.push(PACK_SIZE_MISMATCH_EXISTS_SQL);
      if (wanted.includes(RECEIVING_MISMATCH)) any.push(RECEIVING_MISMATCH_EXISTS_SQL);
      if (wanted.includes(EXTRA_UNITS_SHIPPED)) any.push(EXTRA_UNITS_EXISTS_SQL);
      if (any.length > 0) conds.push(`(${any.join(" OR ")})`);
    }
    if (supplier) {
      const list = supplier.split(",").map((x) => x.trim()).filter(Boolean);
      if (list.length > 0) { params.push(list); conds.push(`p.supplier = ANY($${params.length}::text[])`); }
    }
    if (from) add(`p.order_date >= $?`, from);
    if (to) add(`p.order_date <= $?`, to);
    if (closed === "open") conds.push(`p.closed_at IS NULL`);
    else if (closed === "closed") conds.push(`p.closed_at IS NOT NULL`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    try {
      const total = (await query(`SELECT COUNT(*)::int AS n FROM purchase_orders p ${where}`, params)).rows[0].n;
      const rows = (await query(
        `SELECT p.*,
                ${PO_ACTION_ITEMS_SQL} AS line_action_items,
                ${REVIEW_VELOCITY_REASONS_SQL} AS review_velocity_reasons,
                (SELECT COUNT(*)::int FROM po_asins a WHERE a.po_id = p.id) AS asin_count,
                (SELECT COALESCE(SUM(a.qty), 0)::float8 FROM po_asins a WHERE a.po_id = p.id) AS units_ordered,
                (SELECT SUM(l.qty_received)::float8 FROM po_line_items l WHERE l.po_id = p.id) AS units_received,
                (p.notes IS NOT NULL
                  OR EXISTS (SELECT 1 FROM po_asins a WHERE a.po_id = p.id AND a.notes IS NOT NULL)
                  OR EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id AND l.notes IS NOT NULL)) AS has_notes
           FROM purchase_orders p
           ${where}
          ORDER BY p.order_date DESC, p.created_at DESC, p.id DESC
          LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        params,
      )).rows;
      // Expand by ASIN (§3.3): the list is paginated 25/page, so the page's
      // po_asins rows ride the payload (one extra query) — Expand All needs
      // no further fetch. Same rows as the detail tab (po-queries.ts).
      const asinRows = await loadPoAsinRows((sql, params) => query(sql, params), rows.map((r: any) => String(r.id)));
      const asinsByPo = new Map<string, any[]>();
      for (const a of asinRows) { const k = String(a.po_id); if (!asinsByPo.has(k)) asinsByPo.set(k, []); asinsByPo.get(k)!.push(a); }
      for (const r of rows) {
        r.asins = asinsByPo.get(String(r.id)) ?? [];
        // Row-level Status: the PO's Action Items = union over its lines (read-only here).
        r.action_items = unionActionItems([r.line_action_items]); delete r.line_action_items;
      }
      // Filter options for the toolbar: suppliers (distinct across the whole
      // table) + the fixed Action Items list in display order (§6.1).
      const suppliers = (await query(`SELECT DISTINCT supplier FROM purchase_orders ORDER BY supplier`)).rows.map((r: any) => r.supplier);
      // Shipment reconciliation §5.3: the Unmatched badge = open Velocity lines + ambiguous Velocity shipments.
      const unmatchedCount = (await query(
        `SELECT (SELECT COUNT(*)::int FROM shipment_unmatched WHERE resolved_at IS NULL AND dismissed_at IS NULL) + (SELECT COUNT(*)::int FROM velocity_shipments WHERE sc_match = 'ambiguous') AS n`,
      )).rows[0].n;
      res.json({ pos: rows, total, page, pageSize: PAGE_SIZE, suppliers, actionItems: DISPLAY_ACTION_ITEMS, closed, unmatchedCount });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Full PO detail (frame step 4): PO + po_asins (computed total_cost,
  // joined thumbnail from asins where present) + line items grouped under
  // their po_asin_id. Summary rollups + invoice_file_name computed in the
  // response, never stored. invoice_file_name is built from THIS PO's own
  // date/supplier/orderID — the mockup's cross-wired filename regression is
  // exactly what that rule guards.
  app.get("/api/pos/:id", async (req: Request, res: Response, next: NextFunction) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = typeof req.params.id === "string" ? req.params.id : "";
    // A PO id is a UUID. Anything else is a fixed path registered later
    // (/api/pos/unmatched) — hand it on instead of failing the uuid cast
    // (that 500'd the Unmatched panel, found 2026-10-18).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { next(); return; }
    try {
      const poRes = await query(`SELECT p.*, ${PO_ACTION_ITEMS_SQL} AS line_action_items, ${REVIEW_VELOCITY_REASONS_SQL} AS review_velocity_reasons FROM purchase_orders p WHERE p.id = $1`, [id]);
      if (poRes.rows.length === 0) { res.status(404).json({ message: "PO not found" }); return; }
      const po = poRes.rows[0];
      po.action_items = unionActionItems([po.line_action_items]); delete po.line_action_items;

      // §4 column model: the same rows the POs page nests (po-queries.ts) —
      // derived Canceled/Returned, the six stored ASIN quantities, shipments.
      const asinRows = await loadPoAsinRows((sql, params) => query(sql, params), [id]);

      const lineRows = (await query(
        `SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY po_asin_id, position, id`,
        [id],
      )).rows.map((l: any) => normalizeLineQty(l)); // numeric(10,2) → numbers (migration 062)
      const linesByAsin = new Map<string, any[]>();
      for (const l of lineRows) {
        const key = String(l.po_asin_id ?? "");
        if (!linesByAsin.has(key)) linesByAsin.set(key, []);
        linesByAsin.get(key)!.push(l);
      }
      const asins = asinRows.map((a: any) => ({ ...a, lines: linesByAsin.get(String(a.id)) ?? [] }));
      const orphanLines = linesByAsin.get("") ?? []; // po_asin_id NULL (SET NULL on delete) — none expected in the frame

      // Summary rollups (computed, never stored). units_received: SUM over
      // line qty_received — all-NULL stays NULL → em-dash, never 0.
      const num = (v: any) => (v == null ? null : parseFloat(v));
      const unitsOrdered = Math.round(asinRows.reduce((t: number, a: any) => t + (Number(a.qty) || 0), 0) * 100) / 100;
      const recVals = lineRows.map((l: any) => l.qty_received).filter((v: any) => v != null);
      const unitsReceived = recVals.length === 0 ? null : recVals.reduce((t: number, v: any) => t + Number(v), 0);
      const nonNullCosts = asinRows.filter((a: any) => a.total_cost != null);
      const cogsTotal = nonNullCosts.reduce((t: number, a: any) => t + (num(a.total_cost) ?? 0), 0);
      // pg DATE → JS Date (midnight local): build YYYY-MM-DD from local
      // components — String()/toISOString() would garble or TZ-shift it.
      const od = po.order_date instanceof Date ? po.order_date : new Date(po.order_date);
      const ymd = `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, "0")}-${String(od.getDate()).padStart(2, "0")}`;
      const invoiceFileName = `${ymd}_${po.supplier}_${po.order_id}`;

      res.json({
        po: { ...po, invoice_file_name: invoiceFileName },
        summary: {
          asin_count: asinRows.length,
          units_ordered: unitsOrdered,
          units_received: unitsReceived,
          order_total: po.order_total,
          // All-NULL cost set → null → the strip renders a muted em-dash,
          // never $0.00 (canceled #DIV/0! orders).
          cogs_total: nonNullCosts.length === 0 ? null : cogsTotal.toFixed(2),
        },
        asins,
        orphanLines,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === PO status + quantities (patch §5, §4.2) ===
  // The ONLY writers of closed_at / closed_by, the manual qty columns and
  // po_asin_shipments (AF-owned, SPEC §14). Every quantity or shipment
  // change re-runs the auto-close rule for its PO.
  const poQuery = (sql: string, params?: any[]) => query(sql, params);
  // One PO edit = one transaction (po-af-owned §3): the field writes, the
  // derived ASIN qty, the edit-log rows and the auto-close re-run commit
  // together or not at all.
  async function withPoTx<T>(fn: (q: typeof poQuery) => Promise<T>): Promise<T> {
    const client = await (pool as any).connect();
    try {
      await client.query("BEGIN");
      const out = await fn((sql: string, params?: any[]) => client.query(sql, params));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally { client.release(); }
  }
  const sendEdit = async (res: Response, run: () => Promise<EditResult>) => {
    try {
      const r = await run();
      const [po] = (await query(`SELECT p.id, p.closed_at, p.closed_by FROM purchase_orders p WHERE p.id = $1`, [r.poId])).rows;
      res.json({ ...r, po });
    } catch (err: any) {
      if (err instanceof EditError) { res.status(err.status).json({ message: err.message }); return; }
      if (err?.code === "23505") { res.status(409).json({ message: "a PO with this supplier and order # already exists" }); return; }
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  };
  const uid = (req: Request): number | null => req.session?.userId ?? null;

  // === AF-owned editing (patch po-af-owned §3, 2026-10-18) ===
  // Header (edit drawer), product lines (add / edit / remap / remove), ASIN
  // rows; one po_edit_log row per changed field; auto-close re-run.
  app.patch("/api/pos/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendEdit(res, () => withPoTx((q) => editPoHeader(q, String(req.params.id ?? ""), req.body, uid(req))));
  });
  app.post("/api/pos/:id/lines", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendEdit(res, () => withPoTx((q) => addLine(q, String(req.params.id ?? ""), req.body, uid(req))));
  });
  app.patch("/api/pos/lines/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendEdit(res, () => withPoTx((q) => editLine(q, String(req.params.id ?? ""), req.body, uid(req))));
  });
  app.delete("/api/pos/lines/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendEdit(res, () => withPoTx((q) => removeLine(q, String(req.params.id ?? ""), uid(req))));
  });
  app.patch("/api/pos/asin-rows/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendEdit(res, () => withPoTx((q) => editAsinRow(q, String(req.params.id ?? ""), req.body, uid(req))));
  });
  // New PO form (po-af-owned §4): the body is shared/po-form.ts's PoFormState.
  app.post("/api/pos", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const r = await withPoTx((q) => createPoFromForm(q, req.body, uid(req)));
      res.status(201).json(r);
    } catch (err: any) {
      if (err instanceof EditError) { res.status(err.status).json({ message: err.message }); return; }
      if (err?.code === "23505") { res.status(409).json({ message: "a PO with this supplier and order # already exists" }); return; }
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });
  app.get("/api/pos/asin-lookup", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try { res.json({ rows: await lookupAsins(poQuery, typeof req.query.q === "string" ? req.query.q : "") }); }
    catch (err: any) { res.status(500).json({ message: err.message }); }
  });
  // §5 guards: what the PO detail's Cancel PO / Delete PO need to know
  // (FBA shipments block both; units still at Velocity are named on delete).
  app.get("/api/pos/:id/guards", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try { res.json(await loadPoGuards(poQuery, String(req.params.id ?? ""))); }
    catch (err: any) { res.status(err instanceof EditError ? err.status : 500).json({ message: err.message }); }
  });
  const sendGuarded = async (res: Response, run: () => Promise<unknown>) => {
    try { res.json(await run()); }
    catch (err: any) { res.status(err instanceof EditError ? err.status : 500).json({ message: err?.message ?? String(err) }); }
  };
  app.delete("/api/pos/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendGuarded(res, () => withPoTx((q) => deletePo(q, String(req.params.id ?? ""), uid(req))));
  });
  app.post("/api/pos/:id/cancel", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    await sendGuarded(res, () => withPoTx((q) => cancelPo(q, String(req.params.id ?? ""), uid(req))));
  });
  app.post("/api/pos/shipments/:id/reassign", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const target = String(b.po_asin_id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(target)) { res.status(400).json({ message: "po_asin_id (the target ASIN row) is required" }); return; }
    await sendGuarded(res, () => withPoTx((q) => reassignShipment(q, String(req.params.id ?? ""), target, b.units, uid(req))));
  });
  app.get("/api/pos/:id/history", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try { res.json({ history: await loadPoHistory(poQuery, String(req.params.id ?? "")) }); }
    catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Action Items (row-level Status §2.1, 2026-10-17): they live on the
  // product line. The ASIN editor sends the desired union — added items go
  // onto every line of the ASIN, removed items come off every line; the
  // product editor replaces one line's array. The PO-level array is no longer
  // written (the POs page shows the union read-only). Each change re-runs the
  // auto-close rule (b: no line carries an action item).
  app.patch("/api/pos/asin-rows/:id/action-items", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    const v = normalizeActionItems((req.body ?? {}).action_items);
    if (!v.ok) { res.status(400).json({ message: v.error }); return; }
    try {
      const pa = (await query(`SELECT po_id FROM po_asins WHERE id = $1`, [id])).rows[0];
      if (!pa) { res.status(404).json({ message: "ASIN row not found" }); return; }
      const lines = (await query(`SELECT id, action_items FROM po_line_items WHERE po_asin_id = $1`, [id])).rows;
      if (lines.length === 0) { res.status(409).json({ message: "this ASIN row has no product lines to carry action items" }); return; }
      const before = new Map(lines.map((l: any) => [String(l.id), l.action_items]));
      for (const [lineId, items] of Array.from(asinWriteThrough(lines, v.value).entries())) {
        await query(`UPDATE po_line_items SET action_items = $2::text[] WHERE id = $1`, [lineId, items]);
        await logEdits(poQuery, String(pa.po_id), uid(req), "line", lineId, changedFields({ action_items: before.get(lineId) }, { action_items: items }));
      }
      const close = await evaluateAutoClose(String(pa.po_id), poQuery);
      const [row] = await loadPoAsinRows(poQuery, [String(pa.po_id)]).then((rows) => rows.filter((x: any) => String(x.id) === id));
      res.json({ row, close });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // "Extra units shipped" cleared by hand — a note is required (Maria 2026-10-29).
  app.post("/api/pos/asin-rows/:id/extra-units/clear", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const out = await withPoTx((q) => clearExtraUnits(q, String(req.params.id ?? ""), (req.body ?? {}).note, uid(req)));
      res.status(out.status).json(out.body);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.patch("/api/pos/lines/:id/action-items", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    const v = normalizeActionItems((req.body ?? {}).action_items);
    if (!v.ok) { res.status(400).json({ message: v.error }); return; }
    try {
      const prev = (await query(`SELECT action_items FROM po_line_items WHERE id = $1`, [id])).rows[0];
      const r = await query(`UPDATE po_line_items SET action_items = $2::text[] WHERE id = $1 RETURNING po_id`, [id, v.value]);
      if (r.rowCount === 0) { res.status(404).json({ message: "product line not found" }); return; }
      await logEdits(poQuery, String(r.rows[0].po_id), uid(req), "line", id, changedFields({ action_items: prev?.action_items }, { action_items: v.value }));
      const close = await evaluateAutoClose(String(r.rows[0].po_id), poQuery);
      res.json({ ok: true, close });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // "Mark canceled" on an ASIN row (§2.2): every line mapped to the ASIN gets
  // qty_canceled = qty_ordered; the ASIN's Canceled re-derives (÷ N for a
  // bundle). AF-owned (po-af-owned §2.1): Sync POs never touches it again.
  // Refused while the row has units shipped to FBA (§5.1).
  app.post("/api/pos/asin-rows/:id/cancel", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    try {
      const pa = (await query(`SELECT po_id FROM po_asins WHERE id = $1`, [id])).rows[0];
      if (!pa) { res.status(404).json({ message: "ASIN row not found" }); return; }
      try { await assertAsinRowCancelable(poQuery, id); } catch (e: any) { res.status(e instanceof EditError ? e.status : 500).json({ message: e.message }); return; } // §5.1
      const r = await query(`UPDATE po_line_items SET qty_canceled = qty_ordered WHERE po_asin_id = $1 AND qty_ordered IS NOT NULL AND qty_canceled IS DISTINCT FROM qty_ordered RETURNING id, qty_ordered`, [id]);
      for (const l of r.rows) await logEdits(poQuery, String(pa.po_id), uid(req), "line", String(l.id), [{ field: "qty_canceled", old: null, new: asLogText(l.qty_ordered) }]);
      const close = await evaluateAutoClose(String(pa.po_id), poQuery);
      const [row] = await loadPoAsinRows(poQuery, [String(pa.po_id)]).then((rows) => rows.filter((x: any) => String(x.id) === id));
      res.json({ row, close, linesCanceled: r.rowCount ?? 0 });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Manual Closed toggle (POs table col 1 / PO Details), with the user as closed_by.
  app.patch("/api/pos/:id/closed", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    const closed = (req.body ?? {}).closed;
    if (typeof closed !== "boolean") { res.status(400).json({ message: "closed must be a boolean" }); return; }
    try {
      const exists = (await query(`SELECT id, closed_at FROM purchase_orders WHERE id = $1`, [id])).rows[0];
      if (!exists) { res.status(404).json({ message: "PO not found" }); return; }
      await setPoClosedManually(id, closed, req.session?.userId ?? null, poQuery);
      if ((exists.closed_at != null) !== closed) await logEdits(poQuery, id, uid(req), "po", id, [{ field: "closed", old: exists.closed_at != null ? "Closed" : "Open", new: closed ? "Closed" : "Open" }]);
      const po = (await query(`SELECT p.id, p.closed_at, p.closed_by, ${PO_ACTION_ITEMS_SQL} AS action_items FROM purchase_orders p WHERE p.id = $1`, [id])).rows[0];
      res.json({ po });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Manual quantity edits on an ASIN row: At CQG Warehouse, Lost/damaged by us, Shipped by Supplier.
  app.patch("/api/pos/asin-rows/:id/quantities", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = []; const vals: any[] = [id];
    for (const col of MANUAL_QTY_COLUMNS) {
      if (!(col in body)) continue;
      const p = parseQtyInput(body[col]);
      if (!p.ok) { res.status(400).json({ message: `${col}: ${p.error}` }); return; }
      vals.push(p.value); sets.push(`${col as ManualQtyColumn} = $${vals.length}`);
    }
    if (sets.length === 0) { res.status(400).json({ message: `nothing to update (allowed: ${MANUAL_QTY_COLUMNS.join(", ")})` }); return; }
    try {
      const prev = (await query(`SELECT * FROM po_asins WHERE id = $1`, [id])).rows[0];
      const r = await query(`UPDATE po_asins SET ${sets.join(", ")} WHERE id = $1 RETURNING po_id`, vals);
      if (r.rowCount === 0) { res.status(404).json({ message: "ASIN row not found" }); return; }
      const poId = String(r.rows[0].po_id);
      const edits: Record<string, unknown> = {}; sets.forEach((s, i) => { edits[s.split(" = ")[0]] = vals[i + 1]; });
      await logEdits(poQuery, poId, uid(req), "asin", id, changedFields(prev ?? {}, edits));
      const close = await evaluateAutoClose(poId, poQuery);
      const [row] = await loadPoAsinRows(poQuery, [poId]).then((rows) => rows.filter((x: any) => String(x.id) === id));
      res.json({ row, close });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Manual shipment rows (§4.2) — the trigger keeps Shipped FBA / Received by Amazon in step.
  // Manual shipment row (home-shipped POs, ≈1%): velocity_shipment_id =
  // manual:<uuid>, the FBA ids typed by hand (patch shipment-reconciliation §2).
  app.post("/api/pos/asin-rows/:id/shipments", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const id = String(req.params.id ?? "");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(b.fba_shipment_ids) ? b.fba_shipment_ids : String(b.fba_shipment_ids ?? "").split(/[,\s]+/);
    const fbaIds = Array.from(new Set(rawIds.map((x) => String(x ?? "").trim().toUpperCase()).filter(Boolean)));
    const shipped = parseQtyInput(b.qty_shipped);
    if (!shipped.ok || shipped.value == null) { res.status(400).json({ message: "qty_shipped must be a non-negative number" }); return; }
    const received = parseQtyInput(b.qty_received);
    if (!received.ok) { res.status(400).json({ message: `qty_received: ${received.error}` }); return; }
    const shippedAt = typeof b.shipped_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.shipped_at) ? b.shipped_at : null;
    try {
      const pa = (await query(`SELECT po_id FROM po_asins WHERE id = $1`, [id])).rows[0];
      if (!pa) { res.status(404).json({ message: "ASIN row not found" }); return; }
      await query(
        `INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, fba_shipment_ids, qty_shipped, qty_received, shipped_at, source, sc_match)
         VALUES ($1, 'manual:' || uuid_generate_v4()::text, $2::text[], $3, $4, $5, 'manual', 'none')`,
        [id, fbaIds, shipped.value, received.value, shippedAt],
      );
      await logEdits(poQuery, String(pa.po_id), uid(req), "shipment", id, [{ field: "manual shipment added", old: null, new: `${shipped.value} → ${fbaIds.join(", ") || "no FBA id"}` }]);
      const close = await evaluateAutoClose(String(pa.po_id), poQuery);
      const [row] = await loadPoAsinRows(poQuery, [String(pa.po_id)]).then((rows) => rows.filter((x: any) => String(x.id) === id));
      res.status(201).json({ row, close });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Only manual rows can be removed by hand — a Velocity-sourced row would be
  // recreated by the next Sync Shipments; its truth lives at Velocity.
  app.delete("/api/pos/shipments/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const sid = String(req.params.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(sid)) { res.status(400).json({ message: "invalid shipment id" }); return; }
    try {
      const cur = (await query(`SELECT source FROM po_asin_shipments WHERE id = $1`, [sid])).rows[0];
      if (!cur) { res.status(404).json({ message: "shipment not found" }); return; }
      if (cur.source !== "manual") { res.status(400).json({ message: "only manual shipment rows can be removed; Velocity rows are sync-owned" }); return; }
      const r = await query(`DELETE FROM po_asin_shipments s USING po_asins pa WHERE s.id = $1 AND pa.id = s.po_asin_id RETURNING pa.id AS po_asin_id, pa.po_id, s.qty_shipped, s.fba_shipment_ids`, [sid]);
      if (r.rowCount === 0) { res.status(404).json({ message: "shipment not found" }); return; }
      const poId = String(r.rows[0].po_id); const paId = String(r.rows[0].po_asin_id);
      await logEdits(poQuery, poId, uid(req), "shipment", paId, [{ field: "manual shipment removed", old: `${asLogText(r.rows[0].qty_shipped)} → ${(r.rows[0].fba_shipment_ids ?? []).join(", ") || "no FBA id"}`, new: null }]);
      const close = await evaluateAutoClose(poId, poQuery);
      const [row] = await loadPoAsinRows(poQuery, [poId]).then((rows) => rows.filter((x: any) => String(x.id) === paId));
      res.json({ row, close });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Shipment reconciliation (patch docs/claude_spec-patch-shipment-reconciliation.md §5) ===
  //
  // Sync Shipments (D3): component A (Velocity) then component B (Seller
  // Central), sequentially, as a direct call — Velocity + SP-API inbound
  // reads, not refresh work, so no lane (rule C). If A fails, B still runs
  // against what is stored; both outcomes come back. ?dryRun=true computes
  // both plans and writes nothing. After a live run the auto-close rule
  // (§5.4) is re-evaluated for every touched PO.
  app.post("/api/pos/sync-shipments", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const dryRun = String(req.query.dryRun ?? "") === "true";
    await respondLongSync(res, async () => {
      let velocity: VelocitySyncResult | { error: string };
      let sc: ScSyncResult | { error: string };
      try {
        velocity = await syncVelocityShipments({ dryRun });
        const c = velocity.counts;
        log(`Shipment sync A ${dryRun ? "DRY RUN" : "live"}: shipments ${c.shipments} (fetched ${c.shipmentsFetched}), lines ${c.lines} matched ${c.linesMatched} (order-only ${c.linesMatchedOrderOnly}) no_order ${c.linesNoOrder} po_not_found ${c.linesPoNotFound}; rows +${c.rowsInserted} ~${c.rowsUpdated} =${c.rowsUnchanged}; manual kept ${c.manualRowsKept} split drift ${c.manualSplitDrift}; unmatched new ${c.unmatchedNew} resolved ${c.unmatchedResolved}; at_prep set ${c.atPrepSet} cleared ${c.atPrepCleared}; POs ${c.posTouched}`, "shipments");
      } catch (err: any) {
        log(`Shipment sync A error: ${err.message}`, "shipments");
        velocity = { error: err?.message ?? String(err) };
      }
      try {
        sc = await syncScShipments({ dryRun });
        const c = sc.counts;
        log(`Shipment sync B ${dryRun ? "DRY RUN" : "live"}: SC listed ${c.scShipmentsListed} velocity ${c.scShipmentsVelocity} items fetched ${c.scShipmentsItemsFetched}; velocity shipments ${c.velocityShipments} matched ${c.matched} (minute ${c.matchedByMinute}, overlap ${c.matchedByOverlap}) ambiguous ${c.ambiguous} unmatched ${c.unmatched}; rows fba ${c.rowsFbaIdsUpdated} received ${c.rowsReceivedUpdated} over-received ${c.overReceivedRows} unchanged ${c.rowsUnchanged}; POs ${c.posTouched}`, "shipments");
      } catch (err: any) {
        log(`Shipment sync B error: ${err.message}`, "shipments");
        sc = { error: err?.message ?? String(err) };
      }
      const autoClose = { evaluated: 0, closed: 0, reopened: 0 };
      if (!dryRun) {
        const touched = new Set<string>([...("touchedPoIds" in velocity ? velocity.touchedPoIds : []), ...("touchedPoIds" in sc ? sc.touchedPoIds : [])]);
        for (const poId of Array.from(touched)) {
          const out = await evaluateAutoClose(poId, poQuery);
          autoClose.evaluated++; if (out.changed === "closed") autoClose.closed++; else if (out.changed === "reopened") autoClose.reopened++;
        }
      }
      return { dryRun, velocity, sc, autoClose };
    });
  });

  // Unmatched panel (§5.3): open Velocity lines (no_order / po_not_found) and
  // the rare ambiguous SC match. Nothing else lands here by design.
  // PO matching patch §6: visible = unresolved and not dismissed; each line
  // carries its ranked candidates (Col P / §4), its nearest miss, and whether
  // its Velocity retailer maps to an AF supplier (else "Map → supplier").
  app.get("/api/pos/unmatched", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const all = (await query(
        `SELECT u.id, u.velocity_shipment_id, u.velocity_order_id, u.reason, u.created_at, v.shipped_at::text AS shipped_at,
                u.line->>'order_number' AS order_number, u.line->>'retailer' AS retailer, u.line->>'asin' AS asin, u.line->>'amazon_sku' AS amazon_sku,
                u.line->>'item_name' AS item_name, u.line->>'sold_as' AS sold_as, (u.line->>'units_per_pack')::numeric AS units_per_pack, (u.line->>'quantity_shipped')::numeric AS quantity_shipped,
                u.candidates, u.nearest_miss, u.dismissed_at, u.dismiss_note
           FROM shipment_unmatched u JOIN velocity_shipments v ON v.id = u.velocity_shipment_id
          WHERE u.resolved_at IS NULL
          ORDER BY v.shipped_at DESC NULLS LAST, u.created_at, u.id`,
      )).rows;
      const aliases = await loadAliases(poQuery);
      const suppliers = (await query(`SELECT DISTINCT supplier FROM purchase_orders`)).rows.map((r: any) => String(r.supplier));
      for (const l of all) l.retailer_unmapped = resolveRetailer(l.retailer, aliases, suppliers).kind === "unresolved";
      const lines = all.filter((l: any) => !l.dismissed_at);
      const dismissed = all.filter((l: any) => l.dismissed_at);
      const ambiguous = (await query(
        `SELECT v.id, v.shipped_at::text AS shipped_at, (SELECT COUNT(*)::int FROM po_asin_shipments s WHERE s.velocity_shipment_id = v.id) AS rows
           FROM velocity_shipments v WHERE v.sc_match = 'ambiguous' ORDER BY v.shipped_at DESC, v.id`,
      )).rows;
      res.json({ lines, dismissed, ambiguous, count: lines.length + ambiguous.length });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Bulk dismiss (§6): hidden, listed under "Dismissed (N)", never deleted.
  app.post("/api/pos/unmatched/dismiss", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const ids = Array.isArray((req.body ?? {}).ids) ? (req.body.ids as unknown[]).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : [];
    if (ids.length === 0) { res.status(400).json({ message: "ids are required" }); return; }
    const note = String((req.body ?? {}).note ?? "").trim() || null; // optional (2026-10-29)
    try {
      const r = await query(`UPDATE shipment_unmatched SET dismissed_at = now(), dismiss_note = $2 WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL AND dismissed_at IS NULL`, [ids, note]);
      res.json({ dismissed: r.rowCount ?? 0 });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // "Map → supplier" (§3.1, §6): a Velocity retailer string → an AF supplier (source 'manual').
  app.post("/api/supplier-aliases", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const alias = String((req.body ?? {}).alias ?? "").trim();
    const supplier = String((req.body ?? {}).supplier ?? "").trim();
    if (!alias || !supplier) { res.status(400).json({ message: "alias and supplier are required" }); return; }
    try {
      const known = (await query(`SELECT 1 FROM purchase_orders WHERE supplier = $1 LIMIT 1`, [supplier])).rows.length > 0;
      if (!known) { res.status(400).json({ message: `unknown supplier ${supplier}` }); return; }
      await setAlias(poQuery, alias, supplier, "manual");
      res.json({ alias: alias.toLowerCase(), supplier });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Picker search: PO ASIN rows by order # / ASIN / supplier.
  app.get("/api/pos/asin-rows/search", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) { res.json({ rows: [] }); return; }
    try {
      // The text matches literally (_ and % escaped); a Velocity _N / -N
      // shipment suffix also finds the base order (CAR118805142_1 → CAR118805142).
      // Velocity-eligible POs first; a Home or pre-start PO is still listed
      // (free-text override) but carries the reason as a warning (2026-10-29).
      const start = await readVelocityStartDate(query);
      const rows = (await query(
        `SELECT pa.id, pa.asin, pa.asin_name, pa.qty, pa.units_per_pack, p.order_id, p.supplier, p.order_date::text AS order_date, p.ships_to
           FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
          WHERE p.order_id ILIKE $1 ESCAPE '\\' OR pa.asin ILIKE $1 ESCAPE '\\' OR p.supplier ILIKE $1 ESCAPE '\\' OR p.order_id ILIKE $3 ESCAPE '\\'
          ORDER BY (p.ships_to = 'home' OR ($2::date IS NOT NULL AND p.order_date < $2::date)), p.order_date DESC, p.order_id, pa.asin, pa.id LIMIT 20`, [likeContains(q), start, likeContains(stripShipmentSuffix(q))],
      )).rows;
      for (const r of rows) { const why = velocityIneligible(r, start); r.velocity_warning = why ? ineligibleText(why, start) : null; }
      res.json({ rows });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // "Link to PO ASIN": the line becomes a Velocity-sourced shipment row on the
  // chosen ASIN row (ASIN qty = units ÷ that row's units_per_pack), the
  // unmatched record is stamped resolved and remembered, so later syncs keep
  // the mapping (component A honours resolved_po_asin_id). Received fills on
  // the next Sync Shipments.
  app.post("/api/pos/unmatched/:id/link", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      const b = req.body ?? {};
      const out = await withPoTx((q) => linkUnmatchedLine(q, String(req.params.id ?? ""), String(b.po_asin_id ?? "").trim(), { confirmOvershoot: b.confirm_overshoot === true, note: b.note, userId: uid(req) }));
      res.status(out.status).json(out.body);
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // === Bulk Profit Calculator (SPEC §21) ===
  //
  // Isolated from the main catalog: these endpoints write to bulk_lists /
  // bulk_list_asins only (see server/bulk-lists.ts header for the full list
  // of deliberately-absent write sites). The refresh endpoint runs the same
  // runAnalyzeCore fetch with the bulk sink swapped in and NEVER calls
  // runPostAnalyzeBackgroundSyncs.

  // Create a list from a parsed CSV (client runs /api/parse-file +
  // /api/parse-mapped first, same as the main upload flow).
  app.post("/api/bulk-lists", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { name, sourceFilename, asins } = (req.body ?? {}) as {
      name?: string; sourceFilename?: string; asins?: AsinInput[];
    };
    const listName = (name ?? "").trim();
    if (!listName) { res.status(400).json({ message: "List name is required" }); return; }
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      res.status(400).json({ message: "No ASINs provided" }); return;
    }
    try {
      const created = await createBulkList(listName, sourceFilename?.trim() || null, asins);
      log(`Bulk list created: "${created.name}" (${created.asinCount} ASINs, ${created.skippedInvalid} invalid skipped)`, "bulk");
      res.json(created);
    } catch (err: any) {
      log(`Bulk list create error: ${err.message}`, "bulk");
      res.status(400).json({ message: err.message });
    }
  });

  app.get("/api/bulk-lists", async (_req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    try {
      res.json(await listBulkLists());
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/bulk-lists/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    try {
      const found = await getBulkListWithRows(listId);
      if (!found) { res.status(404).json({ message: "List not found" }); return; }
      res.json(found);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/api/bulk-lists/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const name = ((req.body ?? {}).name ?? "").trim();
    if (!name) { res.status(400).json({ message: "List name is required" }); return; }
    try {
      const renamed = await renameBulkList(listId, name);
      if (!renamed) { res.status(404).json({ message: "List not found" }); return; }
      res.json({ id: listId, name });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/bulk-lists/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    try {
      const deleted = await deleteBulkList(listId);
      if (!deleted) { res.status(404).json({ message: "List not found" }); return; }
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // "Refresh Prices" — re-run analyze for the list, persisting to
  // bulk_list_asins only. NDJSON stream, same shape as /api/analyze.
  // §21 bulk run (2026-09-09): registry-backed pipeline — prices → fees →
  // catalog → gating/hazmat via the shared passes with the bulk writer.
  // Continues to completion after client disconnect (SPEC §21 lifecycle
  // decision); one run per list (409 while busy); re-attach via the status
  // route below.
  app.post("/api/bulk-lists/:id/refresh", async (req: Request, res: Response) => {
    // Scheduler v1 (2026-10-15): enqueues a bulk-target job (decision 5).
    // scope 'failed' (default) = failed + never-fetched rows; 'all' = every
    // row; asins = Retry failed. 202 + the job; the status route re-attaches.
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const body = (req.body ?? {}) as { scope?: "failed" | "all"; asins?: string[] };
    try {
      const r = await enqueueBulkRefresh(listId, { scope: body.scope === "all" ? "all" : "failed", asins: body.asins, requestedBy: req.session?.userId ?? null });
      if (r.kind === "busy") { res.status(409).json({ message: `A refresh for this list is already ${r.status} (job #${r.jobId}).` }); return; }
      if (r.kind === "empty") { res.status(404).json({ message: "List not found or empty" }); return; }
      res.status(202).json({ job: r.job, ahead: r.ahead });
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // §21 Promote to database (2026-09-09): the ONE user-initiated bulk →
  // main write. Per-ASIN transactions; existing ASINs (any status) skipped.
  app.post("/api/bulk-lists/:id/promote", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asins = (req.body ?? {}).asins;
    if (!Array.isArray(asins) || asins.length === 0) {
      res.status(400).json({ message: "asins is required — promotion acts on an explicit selection, never a whole list" }); return;
    }
    try {
      const results = await promoteBulkAsins(listId, asins.map(String));
      const counts = {
        added: results.filter((r) => r.outcome === "added").length,
        already_in_database: results.filter((r) => r.outcome === "already_in_database").length,
        error: results.filter((r) => r.outcome === "error").length,
      };
      // Scheduler v1: a promoted ASIN is onboarded like any other insert —
      // one refresh job for the rows that were just created.
      let jobId: number | null = null;
      const added = results.filter((r) => r.outcome === "added").map((r) => r.asin);
      if (added.length > 0) {
        try {
          const r = await enqueueOnboardingJob(added, { requestedBy: req.session?.userId ?? null });
          jobId = r.job?.id ?? null;
          if (r.covered.length > 0) log(`Promote: ${r.covered.length} ASIN(s) already covered by a queued/running onboarding job — not re-enqueued`, "bulk");
        } catch (err: any) {
          log(`Promote: ${added.length} row(s) created but the refresh job could not be queued: ${err?.message ?? err}`, "bulk");
        }
      }
      res.json({ counts, results, jobId });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Re-attach point: the list's active job (queued/running) or its most
  // recent terminal job; 204 when there is none.
  app.get("/api/bulk-lists/:id/refresh/status", async (req: Request, res: Response) => {
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    try {
      const state = await bulkRefreshStatus(listId);
      if (!state) { res.status(204).end(); return; }
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  });

  // Manual COGS inline edit for a bulk-list row. Guarantees (§21):
  // bulk_list_asins ONLY — never asin_estimates; estimated_cogs_source is
  // always 'manual'; scoped to the (list, asin) row, 404 on no match.
  // Response shape mirrors PUT /api/asins/:asin/cogs so CogsEditor's
  // onChanged plumbing is shared.
  app.put("/api/bulk-lists/:id/asins/:asin/cogs", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const { estimated_cogs } = (req.body ?? {}) as { estimated_cogs?: number };
    if (typeof estimated_cogs !== "number" || !isFinite(estimated_cogs) || estimated_cogs < 0) {
      res.status(400).json({ message: "estimated_cogs must be a non-negative number" }); return;
    }
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET estimated_cogs = $3, estimated_cogs_source = 'manual'
         WHERE list_id = $1 AND asin = $2
         RETURNING estimated_cogs, estimated_cogs_source`,
        [listId, asin, estimated_cogs],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      const r = updated.rows[0];
      res.json({
        estimatedCogs: r.estimated_cogs != null ? parseFloat(r.estimated_cogs) : null,
        estimatedCogsSource: r.estimated_cogs_source ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Manual Supplier SKU inline edit for a bulk-list row. Same guarantees:
  // bulk_list_asins ONLY. Empty string clears the value.
  app.put("/api/bulk-lists/:id/asins/:asin/supplier-sku", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).supplier_sku;
    if (raw != null && typeof raw !== "string") {
      res.status(400).json({ message: "supplier_sku must be a string or null" }); return;
    }
    const supplierSku = raw ? String(raw).trim().slice(0, 100) || null : null;
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET supplier_sku = $3
         WHERE list_id = $1 AND asin = $2
         RETURNING supplier_sku`,
        [listId, asin, supplierSku],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ supplierSku: updated.rows[0].supplier_sku ?? null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // §21 user-controlled inline edits (2026-09-04) — bulk_list_asins only,
  // same contract as supplier-sku above: CSV or manual, sink never writes.

  // Buy link edit — supplier is DERIVED (cleanBuyLink + extractDomain, the
  // main path's exact normalization). Clearing nulls BOTH. No free-text
  // supplier override exists: one source of truth, the URL.
  app.put("/api/bulk-lists/:id/asins/:asin/buy-link", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).buy_link;
    if (raw != null && typeof raw !== "string") { res.status(400).json({ message: "buy_link must be a string or null" }); return; }
    const cleaned = raw ? cleanBuyLink(String(raw)) : null;
    const supplier = cleaned ? extractDomain(cleaned) : null;
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET buy_link = $3, supplier = $4 WHERE list_id = $1 AND asin = $2 RETURNING buy_link, supplier`,
        [listId, asin, cleaned, supplier],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ buyLink: updated.rows[0].buy_link ?? null, supplier: updated.rows[0].supplier ?? null });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Bulk-local free-text tags (§21 isolation: never tags/asin_tags).
  app.put("/api/bulk-lists/:id/asins/:asin/tags", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).tags;
    if (raw != null && typeof raw !== "string") { res.status(400).json({ message: "tags must be a comma-delimited string or null" }); return; }
    const tags = raw ? String(raw).split(",").map((x: string) => x.trim()).filter((x: string) => x.length > 0) : [];
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET tags = $3 WHERE list_id = $1 AND asin = $2 RETURNING tags`,
        [listId, asin, tags.length > 0 ? tags : null],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ tags: updated.rows[0].tags ?? [] });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // §21 bulk-local Last Reviewed (2026-09-10) — same gesture as the main
  // page's review-link clicks; stamps NOW(); bulk table only.
  app.put("/api/bulk-lists/:id/asins/:asin/last-reviewed", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET last_reviewed_at = NOW() WHERE list_id = $1 AND asin = $2 RETURNING last_reviewed_at`,
        [listId, asin],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ lastReviewedAt: updated.rows[0].last_reviewed_at });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // §21 bulk-local Notes (2026-09-08) — same contract as promos: manual
  // edit only, the bulk sink never touches it.
  app.put("/api/bulk-lists/:id/asins/:asin/notes", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).notes;
    if (raw != null && typeof raw !== "string") { res.status(400).json({ message: "notes must be a string or null" }); return; }
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET notes = $3 WHERE list_id = $1 AND asin = $2 RETURNING notes`,
        [listId, asin, raw ? String(raw).trim() || null : null],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ notes: updated.rows[0].notes ?? null });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/bulk-lists/:id/asins/:asin/promos", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).promo_notes;
    if (raw != null && typeof raw !== "string") { res.status(400).json({ message: "promo_notes must be a string or null" }); return; }
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET promo_notes = $3 WHERE list_id = $1 AND asin = $2 RETURNING promo_notes`,
        [listId, asin, raw ? String(raw).trim() || null : null],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ promoNotes: updated.rows[0].promo_notes ?? null });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Backdate Date Added (M/D/YYYY as local midnight, or ISO; bad value 400s
  // here — the CSV path's silent NOW() fallback applies only at import).
  app.put("/api/bulk-lists/:id/asins/:asin/date-added", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const listId = typeof req.params.id === "string" ? req.params.id : "";
    const asin = (typeof req.params.asin === "string" ? req.params.asin : "").toUpperCase();
    const raw = (req.body ?? {}).added_at;
    if (typeof raw !== "string" || !raw.trim()) { res.status(400).json({ message: "added_at is required (M/D/YYYY or ISO)" }); return; }
    const parsed = parseAddedAt(raw);
    if (!parsed) { res.status(400).json({ message: `unparseable date: ${raw}` }); return; }
    try {
      const updated = await query(
        `UPDATE bulk_list_asins SET added_at = $3 WHERE list_id = $1 AND asin = $2 RETURNING added_at`,
        [listId, asin, parsed],
      );
      if ((updated.rowCount ?? 0) === 0) { res.status(404).json({ message: "Row not found in list" }); return; }
      res.json({ addedAt: updated.rows[0].added_at });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // Set-based `in_database` check — the single sanctioned read from the main
  // catalog (§21): an EXISTS against asins.asin, computed at render time,
  // never stored. Deliberately NOT the one-at-a-time /api/asins/check/:asin.
  app.post("/api/asins/in-database", async (req: Request, res: Response) => {
    if (!isDbAvailable()) { res.status(503).json({ message: "Database not available" }); return; }
    const { asins } = (req.body ?? {}) as { asins?: string[] };
    if (!asins || !Array.isArray(asins)) {
      res.status(400).json({ message: "asins array is required" }); return;
    }
    if (asins.length > 10000) {
      res.status(400).json({ message: "Too many ASINs (max 10000)" }); return;
    }
    try {
      const cleaned = asins
        .map((a) => String(a ?? "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a));
      const found = await query(
        `SELECT asin FROM asins WHERE asin = ANY($1::text[])`,
        [cleaned],
      );
      res.json({ present: found.rows.map((r: any) => r.asin) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}
