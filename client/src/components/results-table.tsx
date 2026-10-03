import { useMemo, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipPortal } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExternalLink, AlertTriangle, ArrowUp, ArrowDown, Copy, Check, Lock, Unlock, ShoppingBag, Pencil, ShoppingCart, SearchX, Clock } from "lucide-react";

import {
  type AsinResult,
  type PriceSource,
  type Settings,
  type ColumnId,
  type ColumnDef,
  ALL_COLUMNS,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  extractDomain,
  calculateMaxCogs,
  appliesDgHazmatSurcharge,
} from "@shared/schema";

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const lineRef = useRef<HTMLDivElement>(null);
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => { if (lineRef.current) lineRef.current.style.background = "hsl(var(--primary) / 0.5)"; }}
      onMouseLeave={() => { if (lineRef.current) lineRef.current.style.background = "transparent"; }}
      style={{ position: "absolute", right: -3, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 10 }}
    >
      <div
        ref={lineRef}
        style={{
          position: "absolute",
          right: 3,
          top: "15%",
          bottom: "15%",
          width: 2,
          borderRadius: 1,
          background: "transparent",
          transition: "background 0.15s",
        }}
      />
    </div>
  );
}

const DEFAULT_COL_WIDTHS: Partial<Record<ColumnId, number>> = {
  product: 400, category: 160, brand: 100, supplier: 100,
  stock: 75, availableFba: 80, ordered: 75, fbaStock: 85, reserved: 75, sentToFba: 80, daysLeft: 80,
  cogs: 90, actPrepCost: 85, actUnitsSold: 85, actRefunds: 80, actRefundPct: 80,
  actAvgSalePrice: 100, actRevenue: 95, actProfit: 100, actProfitPerUnit: 90, actRoi: 80, actMargin: 80,
  estCogs: 90, salePrice: 95, profit: 90, margin: 80, roi: 80,
  fbaFee: 85, referralFee: 95, inboundShipping: 100, prep: 85, storage: 105, maxCogs: 90,
  sellersFba: 85, sellers: 80, sellers7d: 85, sellers30d: 90, fba7d: 80, fba30d: 85,
  tags: 100, notes: 100, sourcing: 80, meltable: 85, hazmat: 80, dg: 70, suppressed: 90, dateAdded: 95, lastReviewed: 105,
};
import { type ColumnConfig } from "@/lib/columns";
import { type FilterMode } from "@/components/summary-cards";
import { ColumnFilterButton, NUMERIC_COLS, type ColFilter, type FilterMap, type MultiSelectOption } from "@/components/column-filter";

// Columns whose getRowValue is an ISO timestamp string (2026-09-08) — sort
// comparators should Date.parse these, never string-compare the formatted
// cell. Exported for the pages' sort logic.
export const DATE_VALUE_COLS = new Set<ColumnId>(["dateAdded", "lastReviewed", "priceAge"]);
import { useTagGroups, compareTagKeys } from "@/lib/use-tag-groups";
import { submissionCategory } from "@/lib/submissions-api";
import { TagEditor } from "@/components/tag-editor";
import { NoteEditor } from "@/components/note-editor";

function getSourcingLabel(r: AsinResult): string {
  const w = r.isWholesale ?? false;
  const o = r.isOa ?? false;
  if (w && o) return "W + OA";
  if (w) return "W";
  if (o) return "OA";
  return "";
}

// §6 review stamp. saveUrl override (2026-09-10): Bulk Calc passes its
// bulk-table endpoint — the same gesture must never write to asins there.
function markReviewed(asin: string, onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void, saveUrl?: string) {
  fetch(saveUrl ?? `/api/asins/${asin}/reviewed`, { method: "PUT" }).catch(() => {});
  if (onResultUpdate) {
    onResultUpdate(asin, { lastReviewedAt: new Date().toISOString() });
  }
}

function FaviconLink({
  href,
  src,
  fallback,
  label,
  testId,
  onLinkClick,
}: {
  href: string;
  src: string;
  fallback: string;
  label: string;
  testId: string;
  onLinkClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-5 h-5 rounded hover:bg-muted transition-colors"
          data-testid={testId}
          onClick={(e) => { e.stopPropagation(); onLinkClick?.(); }}
        >
          <img
            src={src}
            alt={label}
            width={16}
            height={16}
            className="w-4 h-4 object-contain"
            onError={(e) => {
              const img = e.currentTarget;
              img.style.display = "none";
              const span = img.nextElementSibling as HTMLElement | null;
              if (span) span.style.display = "inline";
            }}
          />
          <span
            className="text-[9px] font-bold text-muted-foreground leading-none"
            style={{ display: "none" }}
          >
            {fallback}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p className="text-xs">{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// Cache Keepa image load status across renders
const keepaCache = new Map<string, "loading" | "loaded" | "error">();

function KeepaLink({ asin, testId, onReviewed, reviewedSaveUrl }: { asin: string; testId: string; onReviewed?: () => void; reviewedSaveUrl?: string }) {
  const [show, setShow] = useState(false);
  const [imgStatus, setImgStatus] = useState<"loading" | "loaded" | "error">(keepaCache.get(asin) ?? "loading");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLAnchorElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepaUrl = `https://graph.keepa.com/pricehistory.png?asin=${asin}&domain=1&range=365&width=800&height=300&bb=1`;

  function handleMouseEnter() {
    clearTimeout(hideTimer.current);
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const graphWidth = 800;
      const graphHeight = 300;
      const gap = 8;
      let top = rect.top - graphHeight - gap;
      if (top < 8) top = rect.bottom + gap;
      let left = rect.left - graphWidth / 2 + rect.width / 2;
      if (left < 8) left = 8;
      if (left + graphWidth > window.innerWidth - 8) left = window.innerWidth - graphWidth - 8;
      setPos({ top, left });
    }
    // Only start loading if not already cached
    if (!keepaCache.has(asin)) {
      setImgStatus("loading");
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => { keepaCache.set(asin, "loaded"); setImgStatus("loaded"); };
      img.onerror = () => { keepaCache.set(asin, "error"); setImgStatus("error"); };
      img.src = keepaUrl;
    }
    setShow(true);
  }

  function handleMouseLeave() {
    // Small delay to avoid flicker on accidental mouse-out
    hideTimer.current = setTimeout(() => setShow(false), 150);
  }

  return (
    <>
      <a
        ref={ref}
        href={`https://keepa.com/#!product/1-${asin}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center w-5 h-5 rounded hover:bg-muted transition-colors"
        data-testid={testId}
        onClick={(e) => { e.stopPropagation(); markReviewed(asin, undefined, reviewedSaveUrl); onReviewed?.(); }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <img
          src="https://keepa.com/favicon.ico"
          alt="Keepa"
          width={16}
          height={16}
          className="w-4 h-4 object-contain"
          onError={(e) => {
            const img = e.currentTarget;
            img.style.display = "none";
            const span = img.nextElementSibling as HTMLElement | null;
            if (span) span.style.display = "inline";
          }}
        />
        <span
          className="text-[9px] font-bold text-muted-foreground leading-none"
          style={{ display: "none" }}
        >
          K
        </span>
      </a>
      {show &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
              pointerEvents: "none",
            }}
          >
            {imgStatus === "loading" && (
              <div style={{ width: 800, height: 300, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, border: "1px solid hsl(var(--border))", boxShadow: "0 8px 24px rgba(0,0,0,0.25)", background: "#fff", color: "#888", fontSize: 14 }}>
                Loading Keepa graph...
              </div>
            )}
            {imgStatus === "error" && (
              <div style={{ width: 400, height: 60, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, border: "1px solid hsl(var(--border))", boxShadow: "0 8px 24px rgba(0,0,0,0.25)", background: "#fff", color: "#888", fontSize: 13 }}>
                No Keepa data available
              </div>
            )}
            {imgStatus === "loaded" && (
              <img
                src={keepaUrl}
                alt="Keepa price history"
                referrerPolicy="no-referrer"
                style={{
                  width: 800,
                  height: 300,
                  display: "block",
                  borderRadius: 6,
                  border: "1px solid hsl(var(--border))",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                  background: "#fff",
                }}
              />
            )}
          </div>,
          document.body
        )}
    </>
  );
}

function CopyAsinButton({ asin }: { asin: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(asin).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleCopy}
          className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
          data-testid={`btn-copy-asin-${asin}`}
        >
          {copied
            ? <Check className="h-3 w-3 text-emerald-500" />
            : <Copy className="h-3 w-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">{copied ? "Copied!" : "Copy ASIN"}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface ResultsTableProps {
  results: AsinResult[];
  allResults?: AsinResult[];
  startIndex?: number;
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
  activeFilter: FilterMode;
  buySet: Set<string>;
  onToggleBuy: (asin: string) => void;
  onHoldSet: Set<string>;
  onToggleHold: (asin: string) => void;
  selectedSet?: Set<string>;
  onToggleSelect?: (asin: string) => void;
  onSelectAllPage?: (asins: string[]) => void;
  onClearSelection?: () => void;
  // §21 Bulk Buy List / Hold (2026-10-03): when supplied, the frozen header's
  // cart and clock icons become buttons acting on the checkbox selection.
  // Omitted (analytics, repricer) → the icons stay the plain labels they were.
  onBulkBuy?: () => void;
  onBulkHold?: () => void;
  bulkBuyLabel?: string;   // resolved direction + count, from bulkToggleLabel
  bulkHoldLabel?: string;
  bulkActionsDisabled?: boolean;
  sortCol: ColumnId | null;
  sortDir: "asc" | "desc";
  onSort: (colId: ColumnId) => void;
  includeInboundShipping?: boolean;
  dateRangeLabel?: string;
  colFilters?: FilterMap;
  onFilterApply?: (filter: ColFilter) => void;
  onFilterClear?: (colId: ColumnId) => void;
  onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void;
  onStockClick?: (asin: string) => void;
  // §21 bulk page parameterization — every prop defaults to main-page behavior.
  columns?: ColumnDef[];                                   // column subset (default ALL_COLUMNS)
  productBadge?: (result: AsinResult) => React.ReactNode;  // replaces the has_live_offer icon slot in ProductCell
  cogsSaveUrl?: (asin: string) => string;                  // CogsEditor save target (default PUT /api/asins/:asin/cogs); also disables PO sync
  onSupplierSkuSave?: (asin: string, value: string | null) => Promise<{ supplierSku: string | null }>; // enables inline Supplier SKU editing
  // §21 bulk page user-controlled editors (2026-09-04). When present they
  // REPLACE the main-page editors for their columns — the main TagEditor and
  // the main /api/asins promos endpoint are never used on the bulk page.
  promosSaveUrl?: (asin: string) => string;
  notesSaveUrl?: (asin: string) => string;                 // NoteEditor save target for the Notes cell (§21 bulk: bulk_list_asins.notes, never asins)
  reviewedSaveUrl?: (asin: string) => string;              // markReviewed target (§21 bulk: bulk_list_asins.last_reviewed_at, never asins)
  onBulkTagsSave?: (asin: string, csvText: string | null) => Promise<{ tags: string[] }>;
  onBuyLinkSave?: (asin: string, url: string | null) => Promise<{ buyLink: string | null; supplier: string | null }>;
  onDateAddedSave?: (asin: string, value: string) => Promise<{ addedAt: string }>;
  /** Columns to render with the generic date filter (presets + range) — §21 Bulk Calc opt-in. */
  dateFilterCols?: Set<ColumnId>;
  /** Render the in-database tri-state filter on the Product column header (§21 Bulk Calc). */
  inDbFilterOnProduct?: boolean;
}

// §18/§19 (2026-09-21). An unresolved ledger row means AF submitted an
// offer that Amazon hasn't published yet — the PENDING half of the icon's
// two-part definition. 'stale' counts as unresolved: it aged out of the
// probe ladder without a verdict, so we still can't claim "listed".
const UNRESOLVED_SUBMISSION = new Set(["pending", "processing", "stale"]);
export function isSubmissionPending(result: AsinResult): boolean {
  const s = result.submission?.latest?.status;
  return s != null && UNRESOLVED_SUBMISSION.has(String(s));
}

// When the last submission definitively failed, the "+" should say WHY
// rather than reading like the ASIN was never touched.
export function submissionFailureReason(result: AsinResult): string | null {
  const latest = result.submission?.latest;
  if (!latest || latest.status !== "failed") return null;
  const issue = (latest.issues ?? [])[0];
  const why = issue?.message ? `: ${issue.message}` : issue?.code ? `: ${issue.code}` : "";
  return `Submission failed${why} — Add to SC to retry`;
}

function fmt(value: number | null): string {
  // §6 (2026-09-17 final): money columns render $0.00, never a dash — the
  // row data model already reports 0 (getRowValue), and display must agree
  // with what sort/filter/CSV see.
  if (value == null) return "$0.00";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

// §6 (2026-09-17 final): numeric cells render a plain zero — NORMAL text,
// identical styling to any other number. The muted "no-data" colour from the
// first iteration of this change is gone: absence of order events IS zero
// (provenance A), and the only surviving record-gap signal is the amber
// indicator on the two PO-sheet-derived columns (provenance B).
function numCell(text: string, testId?: string) {
  return <span className="font-mono text-sm" data-testid={testId}>{text}</span>;
}


// §6 null-as-zero (2026-09-17). getRowValue is the ONE value source for
// sort, numeric filters, and CSV export, so the coercion lives HERE, at the
// boundary, rather than in ~25 individual cases where one would eventually be
// missed: any NUMERIC column whose computation yields null reports 0. The
// null/zero distinction survives VISUALLY (muted rendering in renderCell),
// never structurally — that is the point of the change, since a dash made a
// row invisible to "ROI ≤ 0" and unsortable against real values.
export function getRowValue(
  result: AsinResult,
  colId: ColumnId,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping = true,
): number | string | null {
  const v = computeRowValue(result, colId, priceSource, settings, includeInboundShipping);
  if (v == null && NUMERIC_COLS.has(colId)) return 0;
  return v;
}

function computeRowValue(
  result: AsinResult,
  colId: ColumnId,
  priceSource: PriceSource,
  settings: Settings,
  // ONE profit computation (2026-09-09): sort/filter/export consult the
  // same inbound toggle the rendered cells do. Default true = the toggle's
  // own default, NOT a page override — every page passes its live value.
  includeInboundShipping = true,
): number | string | null {
  const { price } = getSelectedPrice(result, priceSource);
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);

  let profitData: ReturnType<typeof calculateProfit> | null = null;
  if (price != null && !result.error && result.estimatedCogs != null) {
    profitData = calculateProfit(
      price, result.estimatedCogs,
      result.feesData.fbaFulfillmentFee ?? 0,
      result.feesData.referralFee ?? 0,
      result.feesData.feesEstimatePrice,
      result.catalogData.weightLbs,
      prep.value,
      storage.value,
      settings,
      includeInboundShipping,
      appliesDgHazmatSurcharge(result),
      result.category ?? null
    );
  }

  switch (colId) {
    case "brand": return result.catalogData.brand;
    case "supplier": return extractDomain(result.buyLink);
    // §6 Buy Link: the FULL url. Supplier above is the derived domain of
    // this same stored value — one field, two accessors, never two writers.
    case "buyLink": return result.buyLink ?? null;
    case "supplierSku": return result.supplierSku ?? null;
    case "cogs": return result.actualCogs ?? null;
    case "estCogs": return result.estimatedCogs ?? null;
    case "salePrice": return price;
    case "profit": return profitData?.profit ?? null;
    case "margin": return profitData?.margin ?? null;
    case "roi": return profitData?.roi ?? null;
    case "fbaFee": return profitData?.totalFbaFee ?? result.feesData.fbaFulfillmentFee;
    case "referralFee": return profitData?.adjustedReferralFee ?? result.feesData.referralFee;
    case "inboundShipping": return profitData?.inboundShipping ?? null;
    case "prep": return prep.value;
    case "storage": return storage.value;
    case "sellersFba": return result.pricingData.sellersFba;
    case "sellers": return (result.pricingData.sellersFba ?? 0) + (result.pricingData.sellersFbm ?? 0) || null;
    case "fba7d": return result.sellersDelta?.fba_7d ?? null;
    case "fba30d": return result.sellersDelta?.fba_30d ?? null;
    case "sellers7d": {
      const f7 = result.sellersDelta?.fba_7d ?? null;
      const m7 = result.sellersDelta?.fbm_7d ?? null;
      if (f7 == null && m7 == null) return null;
      return (f7 ?? 0) + (m7 ?? 0);
    }
    case "sellers30d": {
      const f30 = result.sellersDelta?.fba_30d ?? null;
      const m30 = result.sellersDelta?.fbm_30d ?? null;
      if (f30 == null && m30 == null) return null;
      return (f30 ?? 0) + (m30 ?? 0);
    }
    case "tags": return result.tags?.map((t) => t.name).join(", ") ?? null;
    case "notes": return result.notes ?? null;
    case "promos": return result.promoNotes ?? null;
    case "meltable": return result.isMeltable ? "Yes" : "No";
    case "hazmat": return result.isHazmat == null ? "—" : (result.isHazmat ? "Yes" : "No");
    case "dg": return result.isDangerousGood == null ? "—" : (result.isDangerousGood ? "Yes" : "No");
    case "suppressed": return result.isSearchSuppressed ? "Yes" : "No";
    case "stock": return result.stock?.total ?? null;
    case "availableFba": return result.stock?.available_fba ?? null;
    case "ordered": return result.stock?.ordered ?? null;
    // §6 FBA Stock (2026-09-17): READ the row-model field — one number for
    // sort, filter, CSV, and the cell. Never recomputed here.
    case "fbaStock": return result.fbaStock ?? 0;
    case "reserved": return result.stock?.reserved ?? null;
    case "sentToFba": return result.stock?.inbound ?? null;
    case "actAvgSalePrice": {
      const us = result.actuals?.units_sold ?? 0;
      return us > 0 ? result.actuals!.revenue / us : null;
    }
    case "actPrepCost": return result.prepOverride ?? 0; // $0 with warning when no PO data
    case "daysLeft": {
      const s = result.stock?.total ?? 0;
      const u = result.actuals?.units_sold ?? 0;
      const dis = result.actuals?.days_in_stock ?? 0;
      const dws = result.actuals?.days_with_sales ?? 0;
      const activeDays = dis >= 7 ? dis : dws; // prefer days_in_stock when enough history
      if (u === 0 || activeDays === 0) return null;
      const velocity = u / activeDays;
      return Math.round(s / velocity);
    }
    case "actUnitsSold": return result.actuals?.units_sold ?? null;
    case "actRevenue": return result.actuals?.revenue ?? null;
    case "actRefunds": return result.actuals?.units_refunded ?? null;
    case "actRefundPct": return result.actuals && result.actuals.units_sold > 0
      ? (result.actuals.units_refunded / result.actuals.units_sold) * 100 : null;
    case "actProfit":
    case "actProfitPerUnit":
    case "actMargin":
    case "actRoi": {
      if (!result.actuals || result.actuals.units_sold === 0 || result.actualCogs == null) return null;
      const au = result.actuals.units_sold;
      const ar = result.actuals.revenue;
      const ap = getEffectivePrep(result, settings);
      const as2 = getEffectiveStorage(result, settings);
      const ac = calculateProfit(ar / au, result.actualCogs, result.feesData.fbaFulfillmentFee ?? 0, result.feesData.referralFee ?? 0, result.feesData.feesEstimatePrice, result.catalogData.weightLbs, ap.value, as2.value, settings, true, appliesDgHazmatSurcharge(result), result.category ?? null);
      if (colId === "actProfit") return ac.profit * au;
      if (colId === "actProfitPerUnit") return ac.profit;
      if (colId === "actMargin") return ac.margin;
      return ac.roi;
    }
    case "product": return result.catalogData.title ?? result.asin;
    case "dateAdded": return result.addedAt ?? null;
    case "lastReviewed": return result.lastReviewedAt ?? null;
    case "status": return result.status ?? "active";
    case "priceAge": return result.pricesFetchedAt ?? null;
    case "submission": return submissionCategory(result.submission);
    case "category": return result.category ?? null;
    case "sourcing": return getSourcingLabel(result) || null;
    case "maxCogs": {
      const { price } = getSelectedPrice(result, priceSource);
      const p = getEffectivePrep(result, settings);
      const s2 = getEffectiveStorage(result, settings);
      return calculateMaxCogs(
        price,
        result.feesData.fbaFulfillmentFee,
        result.feesData.referralFee,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        p.value, s2.value, settings, true, appliesDgHazmatSurcharge(result),
        result.category ?? null,
      );
    }
    default: return null;
  }
}

export function ResultsTable({
  results, allResults: allResultsProp, startIndex = 0, priceSource, settings, columnConfig,
  activeFilter, buySet, onToggleBuy, onHoldSet, onToggleHold,
  sortCol, sortDir, onSort,
  includeInboundShipping = true,
  dateRangeLabel,
  colFilters = {},
  onFilterApply,
  onFilterClear,
  onResultUpdate,
  selectedSet = new Set(),
  onToggleSelect,
  onSelectAllPage,
  onClearSelection,
  onBulkBuy,
  onBulkHold,
  bulkBuyLabel,
  bulkHoldLabel,
  bulkActionsDisabled = false,
  onStockClick,
  columns = ALL_COLUMNS,
  productBadge,
  cogsSaveUrl,
  onSupplierSkuSave,
  promosSaveUrl,
  notesSaveUrl,
  reviewedSaveUrl,
  onBulkTagsSave,
  onBuyLinkSave,
  onDateAddedSave,
  dateFilterCols,
  inDbFilterOnProduct,
}: ResultsTableProps) {
  const allResults = allResultsProp ?? results;
  const colMap = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  // Compute multi-select options for tags and supplier from ALL results
  const tagMeta = useTagGroups();
  const tagOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, { color: string; count: number; name: string }>();
    let noTagCount = 0;
    for (const r of allResults) {
      if (!r.tags || r.tags.length === 0) { noTagCount++; continue; }
      for (const t of r.tags) {
        const key = t.name.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { color: t.color, count: 1, name: t.name });
      }
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No tags", count: noTagCount }];
    for (const [key, { color, count, name }] of Array.from(counts.entries()).sort((a, b) => compareTagKeys(a[0], b[0], tagMeta))) {
      opts.push({ value: key, label: name, color, count, group: tagMeta.get(key)?.group ?? undefined });
    }
    return opts;
  }, [allResults, tagMeta]);

  const supplierOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    let noSupplierCount = 0;
    for (const r of allResults) {
      const domain = extractDomain(r.buyLink);
      if (!domain) { noSupplierCount++; continue; }
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No supplier", count: noSupplierCount }];
    for (const [domain, count] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      opts.push({ value: domain, label: domain, count });
    }
    return opts;
  }, [allResults]);

  const categoryOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    let noCatCount = 0;
    for (const r of allResults) {
      const cat = r.category;
      if (!cat) { noCatCount++; continue; }
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No category", count: noCatCount }];
    for (const [cat, count] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      opts.push({ value: cat.toLowerCase(), label: cat, count });
    }
    return opts;
  }, [allResults]);

  // Status filter options (2026-09-07): fixed vocabulary, counts from the
  // loaded set (parked/dead only appear when their toggles are on).
  const statusOptions: MultiSelectOption[] = useMemo(() => {
    let a = 0, pk = 0, dd = 0;
    for (const r of allResults) {
      const s = r.status ?? "active";
      if (s === "dead") dd++; else if (s === "parked") pk++; else a++;
    }
    return [
      { value: "active", label: "Active", count: a },
      { value: "parked", label: "Parked", count: pk },
      { value: "dead", label: "Dead", count: dd },
    ];
  }, [allResults]);

  const sourcingOptions: MultiSelectOption[] = useMemo(() => {
    let wCount = 0, oCount = 0, bothCount = 0, noneCount = 0;
    for (const r of allResults) {
      const w = r.isWholesale ?? false;
      const o = r.isOa ?? false;
      if (w && o) bothCount++;
      else if (w) wCount++;
      else if (o) oCount++;
      else noneCount++;
    }
    return [
      { value: "w", label: "Wholesale", count: wCount },
      { value: "oa", label: "OA", count: oCount },
      { value: "w + oa", label: "Both (W + OA)", count: bothCount },
      { value: "__none__", label: "None", count: noneCount },
    ];
  }, [allResults]);

  // Column resize state — persisted in localStorage
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem("fba-col-widths");
      if (stored) return JSON.parse(stored);
    } catch {}
    return {};
  });
  const resizeRef = useRef<{ colId: string; startX: number; startW: number } | null>(null);
  const widthSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  // Collision boundary for in-cell popups that must flip away from the sticky
  // header. State-backed callback ref (not useRef): a plain ref is null on the
  // first render pass and setting .current never re-renders, so Radix would read
  // null and silently fall back to viewport collision. setScrollEl re-renders
  // once the element mounts, so collisionBoundary reliably gets the container.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Debounced save to localStorage
  const saveWidths = useCallback((widths: Record<string, number>) => {
    clearTimeout(widthSaveTimer.current);
    widthSaveTimer.current = setTimeout(() => {
      localStorage.setItem("fba-col-widths", JSON.stringify(widths));
    }, 300);
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const startW = th.getBoundingClientRect().width;
    resizeRef.current = { colId, startX: e.clientX, startW };

    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const newW = Math.max(50, resizeRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [resizeRef.current!.colId]: newW };
        saveWidths(next);
        return next;
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const visibleCols = useMemo(
    // Column order is locked to schema definition (COLUMN_GROUPS order).
    // User controls visibility only, not ordering.
    () => columns.map((c) => c.id).filter((id) => columnConfig.visible.has(id) && colMap.has(id)),
    [columnConfig, colMap, columns]
  );

  // Filtering and sorting done in home.tsx before pagination. Use results directly.
  const sortedResults = useMemo(() => {
    return results;
  }, [results]);

  if (results.length === 0) return null;

  const frozenColWidth = { rowNum: 36, sel: 32, cart: 32 };
  const selLeft = frozenColWidth.rowNum;
  const cartLeft = selLeft + frozenColWidth.sel;
  const productLeft = cartLeft + frozenColWidth.cart;

  // Columns for headers (exclude "product" — it gets special wide rendering, also exclude old frozen cols)
  const dataCols = visibleCols.filter((id) => id !== "product");
  const productVisible = visibleCols.includes("product");
  // Group band was removed — these are no longer needed

  return (
    <div ref={setScrollEl} className="w-full overflow-auto relative" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <table className="border-collapse text-sm w-full" data-testid="results-table">
        <thead className="sticky top-0 z-20">
          <tr className="table-header-stone">
            <th className="sticky left-0 z-30 table-header-stone text-center text-xs font-medium px-1 py-2" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
              #
            </th>
            <th className="sticky z-30 table-header-stone text-center text-xs font-medium px-1 py-2" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-blue-500 cursor-pointer"
                checked={sortedResults.length > 0 && sortedResults.every((r) => selectedSet.has(r.asin))}
                ref={(el) => {
                  if (el) {
                    const some = sortedResults.some((r) => selectedSet.has(r.asin));
                    const all = sortedResults.length > 0 && sortedResults.every((r) => selectedSet.has(r.asin));
                    el.indeterminate = some && !all;
                  }
                }}
                onChange={(e) => {
                  if (e.target.checked && onSelectAllPage) {
                    onSelectAllPage(sortedResults.map((r) => r.asin));
                  } else if (!e.target.checked && onClearSelection) {
                    onClearSelection();
                  }
                }}
              />
            </th>
            <th className="sticky z-30 table-header-stone text-center text-xs font-medium px-1 py-1" style={{ left: cartLeft, width: frozenColWidth.cart, minWidth: frozenColWidth.cart }}>
              <div className="flex flex-col items-center gap-px">
                {onBulkBuy ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* span wrapper: a disabled button fires no pointer
                          events, so the tooltip would never show the
                          "Select rows first" reason for the disabled state. */}
                      <span className={bulkActionsDisabled ? "cursor-not-allowed" : ""}>
                        <button
                          onClick={onBulkBuy}
                          disabled={bulkActionsDisabled}
                          className="p-0 leading-none disabled:opacity-40 disabled:pointer-events-none"
                          data-testid="btn-bulk-cart"
                          aria-label={bulkBuyLabel}
                        >
                          <ShoppingCart className={`h-3 w-3 ${bulkActionsDisabled ? "text-muted-foreground" : "text-blue-500 hover:text-blue-600"} transition-colors`} />
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">{bulkBuyLabel}</TooltipContent>
                  </Tooltip>
                ) : (
                  <ShoppingCart className="h-3 w-3 text-muted-foreground" />
                )}
                {onBulkHold ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={bulkActionsDisabled ? "cursor-not-allowed" : ""}>
                        <button
                          onClick={onBulkHold}
                          disabled={bulkActionsDisabled}
                          className="p-0 leading-none disabled:opacity-40 disabled:pointer-events-none"
                          data-testid="btn-bulk-hold"
                          aria-label={bulkHoldLabel}
                        >
                          <Clock className={`h-3 w-3 ${bulkActionsDisabled ? "text-muted-foreground" : "text-amber-600 hover:text-amber-700"} transition-colors`} />
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">{bulkHoldLabel}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Clock className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
            </th>
            {/* Product th maxWidth matches the body td (2026-09-08): without
                it the product column was the ONLY column with an unconstrained
                max, so w-full auto-layout dumped all stretch surplus into it
                and its sticky cell painted over the first data column (the
                clipped-Brand screenshot on Bulk Calc, which shows fewer
                columns and therefore more surplus). */}
            {productVisible && (
              <th className="sticky z-30 table-header-stone text-left text-xs font-medium px-2 py-2 relative" style={{ left: productLeft, width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200, maxWidth: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, borderRight: "2px solid hsl(var(--border))" }}>
                Product
                {inDbFilterOnProduct && onFilterApply && onFilterClear && (
                  <ColumnFilterButton
                    colId={"product" as ColumnId}
                    currentFilter={colFilters["product" as ColumnId]}
                    onApply={onFilterApply}
                    onClear={() => onFilterClear("product" as ColumnId)}
                    inDbFilter
                  />
                )}
                <ResizeHandle onMouseDown={(e) => handleResizeStart(e, "product")} />
              </th>
            )}
            {dataCols.map((colId) => {
              const col = colMap.get(colId)!;
              const isActive = sortCol === colId;
              const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
              return (
                <th
                  key={colId}
                  className={`relative cursor-pointer select-none hover:opacity-80 transition-colors px-2 py-2 text-xs font-medium overflow-hidden ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                  style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                  onClick={() => onSort(colId)}
                  data-testid={`header-${colId}`}
                >
                  <span className="inline-flex items-center gap-1 pr-2 overflow-hidden">
                    <span className={`flex flex-col leading-tight ${col.qualifier ? "" : "justify-end"}`}>
                      {col.qualifier && <span className="text-[9px] opacity-60">{col.qualifier}</span>}
                      <span>{col.label}</span>
                    </span>
                    {isActive && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    {onFilterApply && onFilterClear && (
                      <ColumnFilterButton
                        colId={colId}
                        currentFilter={colFilters[colId]}
                        onApply={onFilterApply}
                        onClear={() => onFilterClear(colId)}
                        multiSelectOptions={colId === "tags" ? tagOptions : colId === "supplier" ? supplierOptions : colId === "category" ? categoryOptions : colId === "sourcing" ? sourcingOptions : colId === "status" ? statusOptions : undefined}
                        dateFilter={dateFilterCols?.has(colId)}
                      />
                    )}
                  </span>
                  <ResizeHandle onMouseDown={(e) => { e.stopPropagation(); handleResizeStart(e, colId); }} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedResults.map((result, idx) => {
            const { price, label, isFallback: priceFallback } = getSelectedPrice(result, priceSource);
            const hasError = !!result.error;
            const notAvailable = price == null && !hasError;
            const prep = getEffectivePrep(result, settings);
            const storage = getEffectiveStorage(result, settings);
            const isBuy = buySet.has(result.asin);
            const isHold = onHoldSet.has(result.asin);

            let rowBg = "";
            let profitData: ReturnType<typeof calculateProfit> | null = null;

            if (!hasError && price != null && result.estimatedCogs != null) {
              profitData = calculateProfit(
                price, result.estimatedCogs,
                result.feesData.fbaFulfillmentFee ?? 0,
                result.feesData.referralFee ?? 0,
                result.feesData.feesEstimatePrice,
                result.catalogData.weightLbs,
                prep.value, storage.value, settings,
                includeInboundShipping,
                appliesDgHazmatSurcharge(result),
                result.category ?? null
              );
            }

            if (notAvailable || hasError) {
              rowBg = "opacity-50";
            }

            const isArchived = result.isArchived === true;
            const isSelected = selectedSet.has(result.asin);
            const buyHighlight = isSelected ? "!bg-blue-500/8 dark:!bg-blue-500/12" : "";
            const archivedStyle = isArchived ? "opacity-50" : "";
            const frozenBg = isSelected ? "bg-blue-50 dark:bg-blue-950/30" : "bg-background";

            return (
              <tr
                key={`${result.asin}-${idx}`}
                className={`${rowBg} ${buyHighlight} ${archivedStyle} transition-colors hover:bg-muted/30 table-zebra-stone`}
                data-testid={`row-result-${result.asin}`}
              >
                <td className={`sticky left-0 z-10 text-center text-xs text-muted-foreground px-1 py-1.5 ${frozenBg}`} style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
                  {startIndex + idx + 1}
                </td>
                <td className={`sticky z-10 text-center px-1 py-1.5 ${frozenBg}`} style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
                  <input type="checkbox" checked={selectedSet.has(result.asin)} onChange={() => onToggleSelect?.(result.asin)} className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" data-testid={`checkbox-select-${result.asin}`} />
                </td>
                <td className={`sticky z-10 text-center px-1 py-0.5 ${frozenBg}`} style={{ left: cartLeft, width: frozenColWidth.cart, minWidth: frozenColWidth.cart }}>
                  <div className="flex flex-col items-center gap-px">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => onToggleBuy(result.asin)} className="p-0 leading-none" data-testid={`btn-cart-${result.asin}`}>
                          <ShoppingCart className={`h-3 w-3 ${isBuy ? "text-blue-500 fill-blue-500/20" : "text-muted-foreground/30 hover:text-muted-foreground"} transition-colors`} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs">{isBuy ? "Remove from Buy List" : "Add to Buy List"}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => onToggleHold(result.asin)} className="p-0 leading-none" data-testid={`btn-hold-${result.asin}`}>
                          <Clock className={`h-3 w-3 ${isHold ? "text-amber-600 fill-amber-500/20" : "text-muted-foreground/30 hover:text-muted-foreground"} transition-colors`} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs">{isHold ? "Remove from Hold" : "Put on Hold"}</TooltipContent>
                    </Tooltip>
                  </div>
                </td>
                {productVisible && (
                  <td className={`sticky z-10 px-2 py-1.5 overflow-hidden ${frozenBg}`} style={{ left: productLeft, width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200, maxWidth: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, borderRight: "2px solid hsl(var(--border))" }}>
                    <ProductCell result={result} price={price} settings={settings} onResultUpdate={onResultUpdate} collisionBoundary={scrollEl} productBadge={productBadge} cogsSaveUrl={cogsSaveUrl} reviewedSaveUrl={reviewedSaveUrl} />
                  </td>
                )}
                {dataCols.map((colId) => {
                  const col = colMap.get(colId)!;
                  const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
                  let content;
                  if (colId === "supplierSku" && onSupplierSkuSave) {
                    content = (
                      <SupplierSkuEditor
                        asin={result.asin}
                        value={result.supplierSku ?? null}
                        onSave={onSupplierSkuSave}
                        onSaved={(v) => onResultUpdate?.(result.asin, { supplierSku: v })}
                      />
                    );
                  } else if (colId === "tags" && onBulkTagsSave && onResultUpdate) {
                    // §21 bulk-local free-text tags — the main TagEditor is
                    // NEVER mounted on the bulk page (isolation guarantee).
                    content = (
                      <BulkFieldEditor
                        label="Tags (comma-separated)"
                        display={(result.tags && result.tags.length > 0) ? (
                          <div className="flex flex-wrap gap-1">
                            {result.tags.map((tg) => (
                              <span key={tg.name} className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: tg.color ?? "#64748b" }}>
                                {tg.name}
                              </span>
                            ))}
                          </div>
                        ) : <span className="text-muted-foreground text-sm">-</span>}
                        initial={(result.tags ?? []).map((x) => x.name).join(", ")}
                        onSave={async (text) => {
                          const r = await onBulkTagsSave(result.asin, text);
                          onResultUpdate(result.asin, { tags: r.tags.map((name) => ({ name, color: "#64748b" })) } as any);
                        }}
                      />
                    );
                  } else if (colId === "tags" && onResultUpdate) {
                    content = (
                      <TagEditor
                        asin={result.asin}
                        currentTags={result.tags ?? []}
                        onTagsChanged={(tags) => onResultUpdate(result.asin, { tags })}
                      />
                    );
                  } else if (colId === "stock" && onStockClick && result.stock) {
                    content = (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button className="font-mono text-sm text-primary hover:underline cursor-pointer" onClick={() => onStockClick(result.asin)}>
                            {result.stock.total}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs space-y-0.5">
                          {result.stock.hasSnapshot ? (
                            <>
                              <div>Available (FBA): <span className="font-semibold">{result.stock.available_fba}</span></div>
                              <div>Ordered: <span className="font-semibold">{result.stock.ordered}</span></div>
                              <div>Reserved: <span className="font-semibold">{result.stock.reserved}</span></div>
                              <div>Sent to FBA: <span className="font-semibold">{result.stock.inbound}</span></div>
                            </>
                          ) : (
                            <>
                              <div className="text-muted-foreground">Not yet synced from SC</div>
                              <div>Ordered: <span className="font-semibold">{result.stock.ordered}</span></div>
                            </>
                          )}
                          <div className="text-muted-foreground pt-1">Click for history graph</div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  } else if (colId === "notes" && onResultUpdate) {
                    content = (
                      <NoteEditor
                        asin={result.asin}
                        currentNote={result.notes ?? null}
                        onNoteChanged={(notes) => onResultUpdate(result.asin, { notes })}
                        saveUrl={notesSaveUrl ? notesSaveUrl(result.asin) : undefined}
                      />
                    );
                  } else if (colId === "promos" && onResultUpdate) {
                    // §6: Promos is inline-editable with the exact Notes
                    // interaction. Manual edit only — analyze and re-syncs
                    // never touch promo_notes (§14); sourcing sync writes it
                    // solely on new-ASIN INSERT, so edits are never overwritten.
                    content = (
                      <NoteEditor
                        asin={result.asin}
                        currentNote={result.promoNotes ?? null}
                        onNoteChanged={(promoNotes) => onResultUpdate(result.asin, { promoNotes })}
                        saveUrl={promosSaveUrl ? promosSaveUrl(result.asin) : `/api/asins/${result.asin}/promos`}
                        bodyField="promo_notes"
                        placeholder="Add promo notes..."
                        emptyLabel="+ promo"
                      />
                    );
                  } else if (colId === "supplier" && onBuyLinkSave && onResultUpdate) {
                    // §21 bulk: supplier is DERIVED — the editor edits the
                    // BUY LINK URL; clearing nulls both (dash). No free-text
                    // supplier override exists.
                    content = (
                      <BulkFieldEditor
                        label="Buy link URL (blank clears)"
                        display={(() => {
                          const dom = extractDomain(result.buyLink);
                          return dom ? (
                            <a href={result.buyLink!} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary text-sm hover:underline" onClick={(e) => e.stopPropagation()}>
                              {dom}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : <span className="text-muted-foreground text-sm">-</span>;
                        })()}
                        initial={result.buyLink ?? ""}
                        onSave={async (text) => {
                          const r = await onBuyLinkSave(result.asin, text);
                          onResultUpdate(result.asin, { buyLink: r.buyLink } as any);
                        }}
                      />
                    );
                  } else if (colId === "buyLink" && onResultUpdate) {
                    // §6 Buy Link (2026-10-03): the full URL, inline-editable
                    // through the SAME BuyLinkEditor the Product cell uses —
                    // one writer path, one endpoint. Supplier re-derives from
                    // the saved value on the next render (§14).
                    const u = result.buyLink;
                    content = (
                      <span className="flex items-center gap-0.5 min-w-0">
                        {u ? (
                          u.length > 30 ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <a href={u} target="_blank" rel="noopener noreferrer" className="text-primary text-sm hover:underline truncate cursor-help" onClick={(e) => e.stopPropagation()}>
                                  {u.substring(0, 30) + "..."}
                                </a>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-[300px]">
                                <p className="text-xs break-all">{u}</p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <a href={u} target="_blank" rel="noopener noreferrer" className="text-primary text-sm hover:underline truncate" onClick={(e) => e.stopPropagation()}>{u}</a>
                          )
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                        <BuyLinkEditor
                          asin={result.asin}
                          currentLink={result.buyLink}
                          onChanged={(buyLink) => onResultUpdate(result.asin, { buyLink })}
                        />
                      </span>
                    );
                  } else if (colId === "dateAdded" && onDateAddedSave && onResultUpdate) {
                    content = (
                      <BulkFieldEditor
                        label="Date added (M/D/YYYY)"
                        display={(() => {
                          const ts = result.addedAt;
                          if (!ts) return <span className="text-muted-foreground text-sm">-</span>;
                          const d = new Date(ts);
                          return <span className="text-sm text-muted-foreground">{`${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`}</span>;
                        })()}
                        initial={(() => { const ts = result.addedAt; if (!ts) return ""; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; })()}
                        requireValue
                        onSave={async (text) => {
                          if (!text) return;
                          const r = await onDateAddedSave(result.asin, text);
                          onResultUpdate(result.asin, { addedAt: r.addedAt } as any);
                        }}
                      />
                    );
                  } else if (colId === "sourcing" && onResultUpdate) {
                    const sLabel = getSourcingLabel(result);
                    content = (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-sm">{sLabel || "\u2014"}</span>
                        <SourcingEditor
                          asin={result.asin}
                          isWholesale={result.isWholesale ?? false}
                          isOa={result.isOa ?? false}
                          onChanged={(w, o) => onResultUpdate(result.asin, { isWholesale: w, isOa: o })}
                        />
                      </span>
                    );
                  } else {
                    content = renderCell(colId, result, price, label, hasError, profitData, settings, prep, storage, includeInboundShipping, priceFallback, onResultUpdate);
                  }
                  return (
                    <td key={colId} className={`px-3 py-1.5 overflow-hidden ${col.align === "right" ? "text-right" : ""}`} style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Inline Supplier SKU editor — §21 bulk page only (enabled by the
// onSupplierSkuSave prop; the main table renders the value read-only).
// Empty input clears the value.
// §21 bulk inline editor (2026-09-04): generic display + pencil-popover text
// input. Mirrors SupplierSkuEditor's interaction; used for the bulk page's
// tags / buy-link / date-added cells.
function BulkFieldEditor({
  label,
  display,
  initial,
  onSave,
  requireValue = false,
}: {
  label: string;
  display: React.ReactNode;
  initial: string;
  onSave: (text: string | null) => Promise<void>;
  requireValue?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = val.trim();
    if (requireValue && !trimmed) { setError("value required"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed || null);
      setOpen(false);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {display}
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setVal(initial); setError(null); } }}>
        <PopoverTrigger asChild>
          <button className="text-muted-foreground/40 hover:text-muted-foreground p-0 ml-0.5" onClick={(e) => e.stopPropagation()} title={label}>
            <Pencil className="h-2.5 w-2.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">{label}</label>
            <input type="text" value={val} onChange={(e) => setVal(e.target.value)}
              className="w-full text-sm p-2 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              autoFocus />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setOpen(false)}>Cancel</button>
              <button className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90 disabled:opacity-50" onClick={save} disabled={saving}>
                {saving ? "..." : "Save"}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

function SupplierSkuEditor({
  asin,
  value,
  onSave,
  onSaved,
}: {
  asin: string;
  value: string | null;
  onSave: (asin: string, value: string | null) => Promise<{ supplierSku: string | null }>;
  onSaved: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await onSave(asin, val.trim() || null);
      onSaved(res.supplierSku);
      setOpen(false);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {value
        ? <span className="text-sm font-mono">{value}</span>
        : <span className="text-muted-foreground text-sm">-</span>}
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setVal(value ?? ""); setError(null); } }}>
        <PopoverTrigger asChild>
          <button className="text-muted-foreground/40 hover:text-muted-foreground p-0 ml-0.5" onClick={(e) => e.stopPropagation()} title="Edit Supplier SKU">
            <Pencil className="h-2.5 w-2.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Edit Supplier SKU</label>
            <input type="text" maxLength={100} value={val} onChange={(e) => setVal(e.target.value)}
              className="w-full text-sm p-2 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              autoFocus />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setOpen(false)}>Cancel</button>
              <button className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90 disabled:opacity-50" onClick={save} disabled={saving}>
                {saving ? "..." : "Save"}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

function CogsEditor({
  asin,
  estimatedCogs,
  estimatedCogsSource,
  onChanged,
  saveUrl,
  showPoSync = true,
}: {
  asin: string;
  estimatedCogs: number | null;
  estimatedCogsSource: string | null | undefined;
  onChanged: (updates: Partial<AsinResult>) => void;
  // §21 bulk page: custom save target (bulk_list_asins) + PO sync hidden.
  // Defaults preserve the main-page editor exactly.
  saveUrl?: string;
  showPoSync?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [estVal, setEstVal] = useState(String(estimatedCogs ?? ""));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSyncFromPo = showPoSync && estimatedCogsSource === "manual";

  async function save() {
    const estParsed = parseFloat(estVal);
    if (!estVal.trim() || !isFinite(estParsed) || estParsed < 0) { setError("Enter a non-negative number"); return; }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(saveUrl ?? `/api/asins/${asin}/cogs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimated_cogs: estParsed }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || "Failed"); }
      const data = await res.json();
      onChanged({
        estimatedCogs: data.estimatedCogs,
        estimatedCogsSource: data.estimatedCogsSource,
        cogs: data.estimatedCogs ?? 0,
      });
      setOpen(false);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }

  async function syncFromPo() {
    setError(null);
    setSyncing(true);
    try {
      const res = await fetch(`/api/asins/${asin}/cogs/sync-from-po`, { method: "POST" });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || "Failed"); }
      const data = await res.json();
      if (!data.synced) { setError(data.message || "No PO data found"); setSyncing(false); return; }
      onChanged({
        estimatedCogs: data.estimatedCogs,
        estimatedCogsSource: data.estimatedCogsSource,
        cogs: data.estimatedCogs ?? 0,
      });
      setOpen(false);
    } catch (e: any) { setError(e.message); } finally { setSyncing(false); }
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setEstVal(String(estimatedCogs ?? "")); setError(null); } }}>
      <PopoverTrigger asChild>
        <button className="text-muted-foreground/40 hover:text-muted-foreground p-0 ml-0.5" onClick={(e) => e.stopPropagation()} title="Edit Estimated COGS">
          <Pencil className="h-2.5 w-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Edit Estimated COGS ($)</label>
          <input type="number" step="0.01" min="0" value={estVal} onChange={(e) => setEstVal(e.target.value)}
            className="w-full text-sm p-2 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => e.key === "Enter" && save()} autoFocus />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex items-center justify-between gap-2 pt-1">
            {canSyncFromPo ? (
              <button className="text-xs text-primary hover:underline disabled:opacity-50" onClick={syncFromPo} disabled={syncing || saving}>
                {syncing ? "Syncing..." : "Sync from PO"}
              </button>
            ) : <span />}
            <div className="flex gap-2">
              <button className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setOpen(false)}>Cancel</button>
              <button className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90 disabled:opacity-50" onClick={save} disabled={saving || syncing}>
                {saving ? "..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SourcingEditor({ asin, isWholesale, isOa, onChanged }: {
  asin: string;
  isWholesale: boolean;
  isOa: boolean;
  onChanged: (w: boolean, o: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [w, setW] = useState(isWholesale);
  const [o, setO] = useState(isOa);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/asins/${asin}/sourcing-type`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_wholesale: w, is_oa: o }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      onChanged(data.isWholesale, data.isOa);
      setOpen(false);
    } catch {} finally { setSaving(false); }
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setW(isWholesale); setO(isOa); } }}>
      <PopoverTrigger asChild>
        <button className="text-muted-foreground/40 hover:text-muted-foreground p-0 ml-0.5" onClick={(e) => e.stopPropagation()}>
          <Pencil className="h-2.5 w-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={w} onChange={(e) => setW(e.target.checked)} className="h-3.5 w-3.5 accent-blue-500" />
            Wholesale
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={o} onChange={(e) => setO(e.target.checked)} className="h-3.5 w-3.5 accent-blue-500" />
            Online Arbitrage
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setOpen(false)}>Cancel</button>
            <button className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90" onClick={save} disabled={saving}>
              {saving ? "..." : "Save"}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BuyLinkEditor({ asin, currentLink, onChanged }: { asin: string; currentLink: string | null; onChanged: (buyLink: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(currentLink ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/asins/${asin}/buy-link`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyLink: url.trim() || null }),
      });
      const data = await res.json();
      onChanged(data.buyLink);
      setOpen(false);
    } catch {}
    setSaving(false);
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setUrl(currentLink ?? ""); }}>
      <PopoverTrigger asChild>
        <button className="text-muted-foreground/40 hover:text-muted-foreground p-0 ml-0.5" onClick={(e) => e.stopPropagation()}>
          <Pencil className="h-2.5 w-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="w-full text-sm p-2 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <div className="flex justify-end gap-2 mt-2">
          <button className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setOpen(false)}>Cancel</button>
          <button className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90" onClick={save} disabled={saving}>
            {saving ? "..." : "Save"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CogsDisplay({
  result,
  onResultUpdate,
  cogsSaveUrl,
}: {
  result: AsinResult;
  onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void;
  cogsSaveUrl?: (asin: string) => string; // §21 bulk page — also hides PO sync + PO wording
}) {
  const displayValue = result.estimatedCogs;
  const source = result.estimatedCogsSource;

  return (
    <span className="inline-flex items-center gap-1">
      <span>Est. COGS: {displayValue != null ? fmt(displayValue) : "\u2014"}</span>
      {source === "manual" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center justify-center rounded-sm border border-current text-[9px] font-bold px-1 leading-tight cursor-help text-muted-foreground">M</span>
          </TooltipTrigger>
          <TooltipContent side="top"><p className="text-xs">{cogsSaveUrl ? "Manually entered" : "Manually entered — PO sync skipped"}</p></TooltipContent>
        </Tooltip>
      )}
      {onResultUpdate && (
        <CogsEditor
          asin={result.asin}
          estimatedCogs={result.estimatedCogs ?? null}
          estimatedCogsSource={result.estimatedCogsSource}
          onChanged={(updates) => onResultUpdate(result.asin, updates)}
          saveUrl={cogsSaveUrl ? cogsSaveUrl(result.asin) : undefined}
          showPoSync={!cogsSaveUrl}
        />
      )}
    </span>
  );
}

function ProductCell({ result, price, settings, onResultUpdate, collisionBoundary, productBadge, cogsSaveUrl, reviewedSaveUrl }: { result: AsinResult; price: number | null; settings: Settings; onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void; collisionBoundary?: HTMLElement | null; productBadge?: (result: AsinResult) => React.ReactNode; cogsSaveUrl?: (asin: string) => string; reviewedSaveUrl?: (asin: string) => string }) {
  const title = result.catalogData.title;
  const domain = extractDomain(result.buyLink);
  const stock = result.stock;
  const elig = result.eligibilityData?.status;

  return (
    <div className="flex items-start gap-2">
      {/* Image */}
      <div className="flex-shrink-0 w-[52px] h-[52px]">
        {result.catalogData.imageUrl ? (
          <img
            src={result.catalogData.imageUrl}
            alt={title ?? result.asin}
            className="w-[52px] h-[52px] object-contain rounded"
            loading="lazy"
          />
        ) : (
          <div className="w-[52px] h-[52px] bg-muted rounded flex items-center justify-center text-muted-foreground text-[10px]">N/A</div>
        )}
      </div>

      {/* Text content */}
      <div className="min-w-0 flex-1 space-y-0.5">
        {/* Line 1: ASIN · SKU · in-catalog */}
        <div className="flex items-center gap-1 text-xs">
          <a
            href={`https://amazon.com/dp/${result.asin}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-mono hover:underline"
            onClick={(e) => { e.stopPropagation(); markReviewed(result.asin, onResultUpdate, reviewedSaveUrl?.(result.asin)); }}
          >
            {result.asin}
          </a>
          <CopyAsinButton asin={result.asin} />
          {result.skus && result.skus.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground truncate max-w-[140px] cursor-help">
                  · {result.skus[0]}{result.skus.length > 1 ? ` +${result.skus.length - 1}` : ""}
                </span>
              </TooltipTrigger>
              {result.skus.length > 1 && (
                <TooltipPortal>
                  {/* Portaled to body so it escapes the cell's overflow-hidden,
                      the scroll container's overflow-auto, and the cell's z-10
                      stacking context (the sticky header is z-20/z-30). Flips
                      downward near the sticky header via the container boundary
                      (measured thead height ~61px → 64 padding). */}
                  <TooltipContent
                    side="top"
                    className="text-xs"
                    collisionBoundary={collisionBoundary}
                    collisionPadding={{ top: 64 }}
                  >
                    {result.skus.map((s) => <div key={s}>{s}</div>)}
                  </TooltipContent>
                </TooltipPortal>
              )}
            </Tooltip>
          ) : result.sku ? (
            <span className="text-muted-foreground truncate max-w-[140px]">· {result.sku}</span>
          ) : null}
          <FaviconLink
            href={`https://sas.selleramp.com/sas/lookup?SasLookup[search_term]=${result.asin}&SasLookup[cost_price]=${result.actualCogs ?? result.estimatedCogs ?? ""}&SasLookup[sale_price]=${price ?? ""}`}
            src="https://sas.selleramp.com/images/sas_web_logo_32x32.png"
            fallback="SA"
            label="Open in SellerAmp"
            testId={`link-selleramp-${result.asin}`}
            onLinkClick={() => markReviewed(result.asin, onResultUpdate, reviewedSaveUrl?.(result.asin))}
          />
          <KeepaLink asin={result.asin} testId={`link-keepa-${result.asin}`} reviewedSaveUrl={reviewedSaveUrl?.(result.asin)} onReviewed={() => onResultUpdate?.(result.asin, { lastReviewedAt: new Date().toISOString() })} />
          {result.isMeltable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L8 8l-6 2 4 5-1 6 7-3 7 3-1-6 4-5-6-2z" fill="#60A5FA" fillOpacity="0.15" />
                </svg>
              </TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Meltable</p></TooltipContent>
            </Tooltip>
          )}
          {result.isHazmat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24">
                  <path d="M12 2L2 12l10 10 10-10L12 2z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M12 2L12 9" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 15L12 22" stroke="currentColor" strokeWidth="2" />
                  <rect x="6" y="10.5" width="12" height="3" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              </TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Hazmat</p></TooltipContent>
            </Tooltip>
          )}
          {result.isSearchSuppressed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <SearchX className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <p className="font-medium">Search Suppressed</p>
                {result.suppressionReasons && result.suppressionReasons.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {result.suppressionReasons.map((r, i) => <p key={i}>- {r}</p>)}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          )}
          {/* Live-offer truth (has_live_offer, getListingsItem-derived) — NOT
              in_catalog (a tombstone-latched discovery flag). Checkmark only when
              a live offer is confirmed; "+" for deleted (FALSE) and never-checked
              (NULL) alike. The §21 bulk page swaps this slot for its own badge
              (in_database) via the productBadge render prop. */}
          {productBadge ? productBadge(result) : result.hasLiveOffer === true ? (
            // §18 two-part definition (2026-09-21): TRUE means "submitted
            // (pending)" OR "listed (confirmed)". The §19 ledger row is what
            // distinguishes them — unresolved ⇒ pending style, so the flag
            // never overstates what Amazon has actually published.
            isSubmissionPending(result) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative flex-shrink-0 inline-flex" data-testid={`icon-catalog-pending-${result.asin}`}>
                    <ShoppingBag className="h-3 w-3 text-blue-500/50" />
                    <Clock className="h-2 w-2 text-amber-500 absolute -bottom-0.5 -right-0.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top"><p className="text-xs">Submitted — waiting for Amazon to publish</p></TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ShoppingBag className="h-3 w-3 text-blue-500 flex-shrink-0" data-testid={`icon-catalog-live-${result.asin}`} />
                </TooltipTrigger>
                <TooltipContent side="top"><p className="text-xs">Listed in Seller Central (Active or Inactive)</p></TooltipContent>
              </Tooltip>
            )
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`https://sellercentral.amazon.com/abis/listing/syh/offer?_encoding=UTF8&mons_sel_best_mkid=amzn1.mp.o.ATVPDKIKX0DER&ld=AMZUDP&asin=${result.asin}#offer`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-500 text-[10px] font-bold flex-shrink-0 hover:bg-emerald-500/30"
                  onClick={(e) => e.stopPropagation()}
                >
                  +
                </a>
              </TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">{submissionFailureReason(result) ?? "Not listed — Add to SC"}</p></TooltipContent>
            </Tooltip>
          )}
          {/* Last Reviewed timestamp */}
          {(() => {
            const ts = result.lastReviewedAt;
            if (!ts) return <span className="text-[10px] text-muted-foreground/50 ml-auto">{"\u2014"}</span>;
            const d = new Date(ts);
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            const yyyy = d.getFullYear();
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground/50 ml-auto cursor-help">{`${mm}/${dd}/${yyyy}`}</span>
                </TooltipTrigger>
                <TooltipContent side="top"><p className="text-xs">Last reviewed: {d.toLocaleString()}</p></TooltipContent>
              </Tooltip>
            );
          })()}
        </div>

        {/* Line 2: Title + ungating icon */}
        <div className="flex items-center gap-1">
          {result.status === "dead" && (
            <span className="text-[10px] text-muted-foreground/70 border border-border rounded px-1 flex-shrink-0" data-testid={`tag-dead-${result.asin}`}>
              dead{result.statusReason ? ` · ${result.statusReason}` : ""}
            </span>
          )}
          {title ? (
            <span className="text-sm truncate" title={title}>{title}</span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
          {elig === "yes" && (
            <Tooltip>
              <TooltipTrigger asChild><Unlock className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" /></TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Ungated</p></TooltipContent>
            </Tooltip>
          )}
          {elig === "no" && (
            <Tooltip>
              <TooltipTrigger asChild><Lock className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" /></TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Gated — approval required</p></TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Line 3: Supplier · COGS · Stock */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {domain ? (
            <a href={result.buyLink!} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" onClick={(e) => { e.stopPropagation(); markReviewed(result.asin, onResultUpdate, reviewedSaveUrl?.(result.asin)); }}>
              {domain}
            </a>
          ) : (
            <span>—</span>
          )}
          {onResultUpdate && (
            <BuyLinkEditor
              asin={result.asin}
              currentLink={result.buyLink}
              onChanged={(buyLink) => onResultUpdate(result.asin, { buyLink })}
            />
          )}
          <span>·</span>
          <CogsDisplay result={result} onResultUpdate={onResultUpdate} cogsSaveUrl={cogsSaveUrl} />
          {stock && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">· Stock: {stock.total}</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs space-y-0.5">
                <div>Available (FBA): <span className="font-semibold">{stock.available_fba}</span></div>
                <div>Ordered: <span className="font-semibold">{stock.ordered}</span></div>
                <div>Reserved: <span className="font-semibold">{stock.reserved}</span></div>
                <div>Sent to FBA: <span className="font-semibold">{stock.inbound}</span></div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

      </div>
    </div>
  );
}

export function renderCell(
  colId: ColumnId,
  result: AsinResult,
  price: number | null,
  priceLabel: string,
  hasError: boolean,
  profitData: ReturnType<typeof calculateProfit> | null,
  settings: Settings,
  prep: { value: number; isOverride: boolean },
  storage: { value: number; isOverride: boolean },
  includeInboundShipping = true,
  priceFallback = false,
  onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void,
) {
  switch (colId) {
    case "brand": {
      const brand = result.catalogData.brand;
      if (!brand) return <span className="text-muted-foreground text-sm">-</span>;
      return <span className="text-sm" data-testid={`text-brand-${result.asin}`}>{brand}</span>;
    }

    case "supplierSku":
      return result.supplierSku
        ? <span className="text-sm font-mono">{result.supplierSku}</span>
        : <span className="text-muted-foreground text-sm">-</span>;

    case "supplier": {
      const domain = extractDomain(result.buyLink);
      if (!domain) return <span className="text-muted-foreground text-sm">-</span>;
      return (
        <a
          href={result.buyLink!}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-primary text-sm hover:underline"
          data-testid={`link-supplier-${result.asin}`}
        >
          {domain}
          <ExternalLink className="h-3 w-3" />
        </a>
      );
    }

    // §6 provenance B (2026-09-17): Actual COGS is PO-sheet-derived, so a
    // missing value means "no PO record found" — an unmapped sale or a
    // missing row, not a free product. The number is a first-class $0.00
    // for sort/filter/CSV; the amber indicator is the ONLY marker of the
    // record gap (same pattern as Actual Prep Cost, §3).
    case "cogs": {
      if (result.actualCogs != null) return <span className="font-mono text-sm">{fmt(result.actualCogs)}</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-sm text-amber-500 cursor-help" data-testid={`text-cogs-missing-po-${result.asin}`}>
              {fmt(0)} <AlertTriangle className="inline h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            <p className="text-xs">No PO COGS found. This indicates a missing PO record or unmapped sale. Actual profit/margin/ROI may be overstated.</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    case "estCogs":
      return <span className="font-mono text-sm">{fmt(result.estimatedCogs)}</span>;

    case "salePrice":
      // §21 bulk per-leg outcomes (2026-09-09): explicit vocabulary instead
      // of a synthesized error string. Catalog "absent" renders "Not found"
      // (its own leg); a missing price with a conclusive outcome renders the
      // outcome word, never a bare "Error".
      if (result.priceOutcome != null || result.catalogOutcome != null) {
        if (price != null) return <span className="font-mono text-sm">{fmt(price)}</span>;
        const label = result.catalogOutcome === "absent" ? "Not found"
          : result.priceOutcome === "no_offers" ? "No offers"
          : result.priceOutcome === "restricted" ? "Restricted"
          : result.priceOutcome === "throttled" ? "Throttled"
          : result.priceOutcome === "invalid_asin" ? "Invalid ASIN"
          : result.priceOutcome === "error" ? "Error"
          : result.priceOutcome === "not_found" ? "Not found"
          : null;
        if (label == null) return numCell(fmt(0));
        const benign = label === "No offers";
        const badge = (
          <span className={`flex items-center gap-1 justify-end text-sm ${benign ? "text-muted-foreground" : "text-destructive"}`} data-testid={`text-price-outcome-${result.asin}`}>
            {!benign && <AlertTriangle className="h-3 w-3" />}
            {label}
          </span>
        );
        if (label === "Not found") {
          // Verified 2026-09-09: every "Not found" here is Amazon-side —
          // well-formed ASINs absent from the catalog with pricing 400
          // InvalidInput. Format rejects never reach a row (createBulkList
          // skips them at import as skippedInvalid), so the "rejected
          // before lookup" variant is unreachable for stored rows.
          return (
            <Tooltip>
              <TooltipTrigger asChild>{badge}</TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Not in Amazon's catalog (deactivated or removed)</p></TooltipContent>
            </Tooltip>
          );
        }
        return badge;
      }
      if (hasError) {
        const isRestricted = result.error?.includes("Restricted");
        const isNoData = result.error?.includes("No data") || result.error?.includes("No pricing");
        let errorLabel = "Error";
        if (isRestricted) errorLabel = "Restricted";
        else if (isNoData) errorLabel = "No data";
        return (
          <Tooltip>
            <TooltipTrigger>
              <span className="flex items-center gap-1 justify-end text-destructive text-sm font-medium">
                <AlertTriangle className="h-3 w-3" />
                {errorLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px]">
              <p className="text-xs">{result.error}</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      if (price != null) {
        if (priceFallback) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono text-sm text-amber-500 cursor-help">
                  {fmt(price)} <AlertTriangle className="inline h-3 w-3" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">{priceLabel} — no FBA offers found</p>
              </TooltipContent>
            </Tooltip>
          );
        }
        return <span className="font-mono text-sm">{fmt(price)}</span>;
      }
      // No price and no genuine error (2026-09-09): derive the OUTCOME from
      // row state — same vocabulary as Bulk Calc, never a synthesized
      // failure. Conclusive no_offers = prices NULLed WITH a fetched stamp;
      // never-fetched = a plain dash. (Catalog-deleted rows go status=dead
      // via DA-2 and carry the dead tag — no separate label needed here.)
      if (result.pricesFetchedAt != null) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground text-sm cursor-help" data-testid={`text-price-outcome-${result.asin}`}>No offers</span>
            </TooltipTrigger>
            <TooltipContent side="top"><p className="text-xs">Amazon answered with zero New offers — nothing is for sale (checked {new Date(result.pricesFetchedAt).toLocaleString()})</p></TooltipContent>
          </Tooltip>
        );
      }
      return numCell(fmt(0));

    case "profit":
      return (
        <span className={`font-mono text-sm font-semibold ${
          profitData
            ? profitData.profit >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmt(profitData.profit) : fmt(0)}
        </span>
      );

    case "margin":
      return (
        <span className={`font-mono text-sm ${
          profitData
            ? profitData.margin >= settings.minMarginThreshold
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmtPct(profitData.margin) : fmtPct(0)}
        </span>
      );

    case "roi":
      return (
        <span className={`font-mono text-sm ${
          profitData
            ? profitData.roi >= settings.minRoiThreshold
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmtPct(profitData.roi) : fmtPct(0)}
        </span>
      );

    case "fbaFee": {
      const fbaVal = profitData ? fmt(profitData.totalFbaFee) : fmt(result.feesData.fbaFulfillmentFee);
      // Honest labeling (§14): a weight-estimated fallback fee is visibly
      // provisional, not presented as a real Amazon fee.
      if (result.feeSource === "fallback") {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-sm text-amber-500 cursor-help" data-testid={`text-fbaFee-fallback-${result.asin}`}>
                {fbaVal} <AlertTriangle className="inline h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Estimated from weight — SP-API fee fetch failed; will retry on next analyze</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      // Fee computed at a non-FBA price (2026-09-09): the row has no FBA
      // offer, so the estimate ran at the buy-box/lowest price — same amber
      // honesty indicator as the Sale Price fallback.
      if (result.feesData.fbaFulfillmentFee != null && result.pricingData.lowestFbaPrice == null && (result.pricingData.buyBoxPrice != null || result.pricingData.lowestPrice != null)) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-sm text-amber-500 cursor-help" data-testid={`text-fbaFee-nonfba-${result.asin}`}>
                {fbaVal} <AlertTriangle className="inline h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Fee estimated at the buy-box/lowest price — no FBA offer exists</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="font-mono text-sm">{fbaVal}</span>;
    }

    case "referralFee":
      return (
        <span className="font-mono text-sm">
          {profitData ? fmt(profitData.adjustedReferralFee) : fmt(result.feesData.referralFee)}
        </span>
      );

    case "inboundShipping": {
      if (profitData && profitData.inboundShipping == null) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-sm text-amber-500 cursor-help" data-testid={`text-inboundShipping-${result.asin}`}>
                ? <AlertTriangle className="inline h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Weight unavailable — inbound shipping could not be calculated</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="font-mono text-sm" data-testid={`text-inboundShipping-${result.asin}`}>{fmt(profitData?.inboundShipping ?? 0)}</span>;
    }

    case "prep":
      return (
        <span className="font-mono text-sm">
          {fmt(prep.value)}
          {prep.isOverride && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-primary ml-0.5 cursor-help">*</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Per-ASIN value from uploaded file</p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      );

    case "storage":
      return (
        <span className="font-mono text-sm">
          {fmt(storage.value)}
          {storage.isOverride && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-primary ml-0.5 cursor-help">*</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Per-ASIN value from uploaded file</p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      );

    case "sellersFba":
      return numCell(String(result.pricingData.sellersFba ?? 0));

    case "sellers": {
      const totalSellers = (result.pricingData.sellersFba ?? 0) + (result.pricingData.sellersFbm ?? 0);
      return numCell(String(totalSellers || 0));
    }

    case "fba7d":
    case "fba30d":
    case "sellers7d":
    case "sellers30d": {
      let dv: number | null | undefined;
      if (colId === "fba7d") dv = result.sellersDelta?.fba_7d;
      else if (colId === "fba30d") dv = result.sellersDelta?.fba_30d;
      else if (colId === "sellers7d") dv = result.sellersDelta ? (result.sellersDelta.fba_7d ?? 0) + (result.sellersDelta.fbm_7d ?? 0) : null;
      else dv = result.sellersDelta ? (result.sellersDelta.fba_30d ?? 0) + (result.sellersDelta.fbm_30d ?? 0) : null;
      if (dv == null) return <span className="font-mono text-sm text-muted-foreground">{"\u2013"}</span>;
      if (dv === 0) return <span className="font-mono text-sm text-muted-foreground">0</span>;
      const color = dv < 0 ? "text-emerald-500" : "text-red-500";
      const arrow = dv < 0 ? "\u25BC" : "\u25B2";
      return <span className={`font-mono text-sm ${color}`}>{arrow} {Math.abs(dv)}</span>;
    }

    case "availableFba":
      return numCell(String(result.stock?.available_fba ?? 0));
    case "ordered":
      return numCell(String(result.stock?.ordered ?? 0));
    case "fbaStock":
      return numCell(String(result.fbaStock ?? 0));
    case "reserved":
      return numCell(String(result.stock?.reserved ?? 0));
    case "sentToFba":
      return numCell(String(result.stock?.inbound ?? 0));

    case "actAvgSalePrice": {
      const avgUs = result.actuals?.units_sold ?? 0;
      return numCell(fmt(avgUs > 0 ? result.actuals!.revenue / avgUs : 0));
    }

    case "actPrepCost": {
      const hasPoPrepCost = result.prepOverride != null;
      if (hasPoPrepCost) return <span className="font-mono text-sm">{fmt(result.prepOverride)}</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-sm text-amber-500 cursor-help">
              {fmt(0)} <AlertTriangle className="inline h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            <p className="text-xs">No PO prep cost found. This indicates a missing PO record or unmapped sale. Actual profit/margin/ROI may be overstated.</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    case "tags": {
      const tags = result.tags;
      if (!tags || tags.length === 0) return <span className="text-muted-foreground text-sm">-</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span
              key={t.name}
              className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full font-medium text-white"
              style={{ backgroundColor: t.color ?? "#64748b" }}
            >
              {t.name}
            </span>
          ))}
        </div>
      );
    }

    case "buyLink": {
      // Read-only FALLBACK (contexts with no update handler). With
      // onResultUpdate present the body loop renders the BuyLinkEditor
      // variant instead (§6 inline edit). Truncate+tooltip like notes.
      const u = result.buyLink;
      if (!u) return <span className="text-muted-foreground text-sm">-</span>;
      const link = (
        <a
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {u.length > 30 ? u.substring(0, 30) + "..." : u}
        </a>
      );
      if (u.length <= 30) return link;
      return (
        <Tooltip>
          <TooltipTrigger asChild><span className="cursor-help">{link}</span></TooltipTrigger>
          <TooltipContent side="top" className="max-w-[300px]">
            <p className="text-xs break-all">{u}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    case "notes": {
      const n = result.notes;
      if (!n) return <span className="text-muted-foreground text-sm">-</span>;
      const truncated = n.length > 30 ? n.substring(0, 30) + "..." : n;
      if (n.length > 30) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-muted-foreground cursor-help">{truncated}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px]">
              <p className="text-xs whitespace-pre-wrap">{n}</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="text-sm text-muted-foreground">{n}</span>;
    }

    case "promos": {
      // Read-only FALLBACK (contexts without an update handler) — with
      // onResultUpdate present the body loop renders the NoteEditor variant
      // instead (§6 inline edit). Same truncate+tooltip pattern as notes.
      const p = result.promoNotes;
      if (!p) return <span className="text-muted-foreground text-sm">-</span>;
      const truncated = p.length > 30 ? p.substring(0, 30) + "..." : p;
      if (p.length > 30) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-muted-foreground cursor-help">{truncated}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px]">
              <p className="text-xs whitespace-pre-wrap">{p}</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="text-sm text-muted-foreground">{p}</span>;
    }

    case "meltable":
      return <span className={`text-sm ${result.isMeltable ? "text-blue-400" : "text-muted-foreground"}`}>{result.isMeltable ? "Yes" : "No"}</span>;

    case "hazmat":
      // NULL-window rule: unchecked → muted dash, never a green "No".
      return result.isHazmat == null
        ? <span className="text-sm text-muted-foreground">—</span>
        : <span className={`text-sm ${result.isHazmat ? "text-amber-400" : "text-muted-foreground"}`}>{result.isHazmat ? "Yes" : "No"}</span>;

    case "dg":
      return result.isDangerousGood == null
        ? <span className="text-sm text-muted-foreground">—</span>
        : <span className={`text-sm ${result.isDangerousGood ? "text-amber-400" : "text-muted-foreground"}`}>{result.isDangerousGood ? "Yes" : "No"}</span>;

    case "suppressed":
      return <span className={`text-sm ${result.isSearchSuppressed ? "text-amber-400" : "text-muted-foreground"}`}>{result.isSearchSuppressed ? "Yes" : "No"}</span>;

    case "stock": {
      const s = result.stock;
      if (!s) return numCell("0");
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-sm cursor-help">{s.total}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs space-y-0.5">
            {s.hasSnapshot ? (
              <>
                <div>Available (FBA): <span className="font-semibold">{s.available_fba}</span></div>
                <div>Ordered: <span className="font-semibold">{s.ordered}</span></div>
                <div>Reserved: <span className="font-semibold">{s.reserved}</span></div>
                <div>Sent to FBA: <span className="font-semibold">{s.inbound}</span></div>
              </>
            ) : (
              <>
                <div className="text-muted-foreground">Not yet synced from SC</div>
                <div>Ordered: <span className="font-semibold">{s.ordered}</span></div>
              </>
            )}
          </TooltipContent>
        </Tooltip>
      );
    }

    case "daysLeft": {
      const stk = result.stock?.total ?? 0;
      const us = result.actuals?.units_sold ?? 0;
      const dis = result.actuals?.days_in_stock ?? 0;
      const dws = result.actuals?.days_with_sales ?? 0;
      const activeDays = dis >= 7 ? dis : dws;
      if (us === 0 || activeDays === 0) return numCell("0");
      const velocity = us / activeDays;
      if (stk === 0) return <span className="font-mono text-sm text-red-500 font-semibold">0</span>;
      const days = Math.round(stk / velocity);
      const color = days < 7 ? "text-red-500 font-semibold" : days <= 14 ? "text-amber-500" : "text-emerald-500";
      return <span className={`font-mono text-sm ${color}`}>{days}</span>;
    }

    case "actUnitsSold":
      return numCell(String(result.actuals?.units_sold ?? 0));

    case "actRevenue":
      return numCell(fmt(result.actuals?.revenue ?? 0));

    case "actRefunds":
      return numCell(String(result.actuals?.units_refunded ?? 0));

    case "actRefundPct": {
      if (!result.actuals || result.actuals.units_sold === 0) return numCell("0.0%");
      const pct = (result.actuals.units_refunded / result.actuals.units_sold) * 100;
      return <span className="font-mono text-sm">{pct.toFixed(1)}%</span>;
    }

    case "actProfit": {
      if (!result.actuals || result.actuals.units_sold === 0 || result.actualCogs == null) return numCell(fmt(0));
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.actualCogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        appliesDgHazmatSurcharge(result),
        result.category ?? null
      );
      const total = perUnit.profit * units;
      return (
        <span className={`font-mono text-sm font-semibold ${total >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {fmt(total)}
        </span>
      );
    }

    case "actProfitPerUnit": {
      if (!result.actuals || result.actuals.units_sold === 0 || result.actualCogs == null) return numCell(fmt(0));
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.actualCogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        appliesDgHazmatSurcharge(result),
        result.category ?? null
      );
      return (
        <span className={`font-mono text-sm ${perUnit.profit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {fmt(perUnit.profit)}
        </span>
      );
    }

    case "actMargin": {
      if (!result.actuals || result.actuals.units_sold === 0 || result.actualCogs == null) return numCell("0.0%");
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.actualCogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        appliesDgHazmatSurcharge(result),
        result.category ?? null
      );
      return (
        <span className={`font-mono text-sm ${perUnit.margin >= settings.minMarginThreshold ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {perUnit.margin.toFixed(1)}%
        </span>
      );
    }

    case "actRoi": {
      if (!result.actuals || result.actuals.units_sold === 0 || result.actualCogs == null) return numCell("0.0%");
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.actualCogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        appliesDgHazmatSurcharge(result),
        result.category ?? null
      );
      return (
        <span className={`font-mono text-sm ${perUnit.roi >= settings.minRoiThreshold ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {perUnit.roi.toFixed(1)}%
        </span>
      );
    }

    case "dateAdded": {
      const ts = result.addedAt;
      if (!ts) return <span className="text-muted-foreground text-sm">-</span>;
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const yyyy = d.getFullYear();
      return <span className="text-sm text-muted-foreground">{`${mm}/${dd}/${yyyy}`}</span>;
    }

    // Relative age of the last conclusive price answer (§11 Refresh,
    // 2026-09-06). Em-dash = never synced.
    case "priceAge": {
      const ts = result.pricesFetchedAt;
      if (!ts) return <span className="text-muted-foreground/50 text-sm">{"\u2014"}</span>;
      const ms = Date.now() - new Date(ts).getTime();
      const mins = Math.floor(ms / 60000);
      const label = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm text-muted-foreground cursor-help">{label}</span>
          </TooltipTrigger>
          <TooltipContent side="top"><p className="text-xs">Prices synced: {new Date(ts).toLocaleString()}</p></TooltipContent>
        </Tooltip>
      );
    }

    // Same field as the Product cell's corner date (lastReviewedAt — human
    // review stamp from the Keepa-link click). M/D/YYYY, muted em-dash when
    // never reviewed. The corner date stays; this column supplements it.
    case "lastReviewed": {
      const ts = result.lastReviewedAt;
      if (!ts) return <span className="text-muted-foreground/50 text-sm">{"\u2014"}</span>;
      const d = new Date(ts);
      return <span className="text-sm text-muted-foreground">{`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`}</span>;
    }

    // §6 Status column (2026-09-07): status word + muted reason.
    case "status": {
      const s = result.status ?? "active";
      if (s === "active") return <span className="text-sm text-muted-foreground">active</span>;
      return (
        <span className="text-sm text-muted-foreground">
          {s}{result.statusReason ? <span className="text-muted-foreground/60"> · {result.statusReason}</span> : null}
        </span>
      );
    }

    // §6 Submission column — read-only §19 ledger surface. Item 7: the
    // current-issues SNAPSHOT is the primary badge when present (ledger flags
    // freeze at verify time and go stale); ledger flags stay in the tooltip
    // and the filter regardless. Acknowledged ledger flags render muted grey,
    // never hidden (permanent record). Semantic color in cell text only — no
    // row tints (§7).
    case "submission": {
      const sub = result.submission;
      const cat = submissionCategory(sub);
      const snap = result.issuesCheckedAt != null ? (result.currentIssues ?? []) : null;
      // Badge source: snapshot when present, else latest submission flags.
      const showLedgerBadge = snap == null && cat !== "none" && cat !== "clean";
      const showSnapBadge = snap != null && snap.length > 0;
      if (!showLedgerBadge && !showSnapBadge && cat === "none") return null;
      const latest = sub?.latest ?? null;
      const ack = latest?.acknowledged === true;
      const fmtDate = (t: string) => {
        const d = new Date(t);
        return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
      };
      let badge: React.ReactNode = null;
      if (showSnapBadge) {
        badge = (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-500">
            {snap!.map((i) => <span key={i.code} className="font-mono">{i.code}</span>)}
          </span>
        );
      } else if (showLedgerBadge) {
        const codes = (latest!.issues ?? []).map((i) => i.code).filter(Boolean);
        const chipTone = latest!.status === "failed"
          ? (ack ? "text-muted-foreground" : "text-red-600 dark:text-red-400")
          : (ack ? "text-muted-foreground" : "text-amber-600 dark:text-amber-500");
        badge = (
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${chipTone}`}>
            {latest!.status === "failed" && <span>failed</span>}
            {codes.length > 0
              ? codes.map((c) => <span key={c} className="font-mono">{c}</span>)
              : latest!.status !== "failed" && <span>{latest!.terminalConflict ? "conflict" : latest!.status}</span>}
            {ack && <span className="text-[10px] uppercase tracking-wide">ack</span>}
          </span>
        );
      } else if (sub == null && !showSnapBadge) {
        return null; // no submission, no snapshot issues
      }
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{badge ?? <span className="text-xs text-muted-foreground">—</span>}</span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent side="top" className="max-w-md">
              <div className="space-y-2 text-xs">
                {/* Item 7: current-issues snapshot — primary truth when checked */}
                {snap != null && (
                  <div>
                    <p className="font-medium">
                      Current issues (as of {fmtDate(result.issuesCheckedAt!)}): {snap.length === 0 ? "none" : ""}
                    </p>
                    {snap.map((iss, j) => (
                      <p key={j}>- <span className="font-mono">{iss.code}</span> ({iss.severity}): {iss.message}</p>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="text-[11px] underline text-muted-foreground hover:text-foreground"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      const r = await fetch(`/api/asins/${result.asin}/recheck-issues`, { method: "POST" });
                      const d = await r.json();
                      if (r.ok) {
                        onResultUpdate?.(result.asin, {
                          currentIssues: d.currentIssues, issuesCheckedAt: d.issuesCheckedAt,
                          hasLiveOffer: d.hasLiveOffer,
                        });
                      }
                    } catch { /* transient — next pass retries */ }
                  }}
                >
                  Recheck now
                </button>
                {sub != null && sub.history.map((h, i) => (
                  <div key={i} className={i > 0 ? "opacity-70" : ""}>
                    <p className="font-medium">
                      {fmtDate(h.submittedAt)} · <span className="font-mono">{h.sku}</span> · {h.status}
                      {h.acknowledged ? " · acknowledged" : ""}
                    </p>
                    {(h.issues ?? []).map((iss, j) => (
                      <p key={j}>- <span className="font-mono">{iss.code}</span> ({iss.severity}): {iss.message}</p>
                    ))}
                    {(h.reviewFlags ?? []).filter((f) => !(h.issues ?? []).some((iss) => f.startsWith(iss.code))).map((f, j) => (
                      <p key={`f${j}`}>- {f}</p>
                    ))}
                  </div>
                ))}
              </div>
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      );
    }

    case "category": {
      const cat = result.category;
      if (!cat) return <span className="text-muted-foreground text-sm">-</span>;
      return <span className="text-sm">{cat}</span>;
    }

    case "sourcing": {
      const sLabel = getSourcingLabel(result);
      if (!sLabel) return <span className="text-muted-foreground text-sm">{"\u2014"}</span>;
      return <span className="text-sm">{sLabel}</span>;
    }

    case "maxCogs": {
      const mc = calculateMaxCogs(
        price,
        result.feesData.fbaFulfillmentFee,
        result.feesData.referralFee,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep.value, storage.value, settings, includeInboundShipping, appliesDgHazmatSurcharge(result),
        result.category ?? null,
      );
      if (mc == null) return numCell(fmt(0));
      if (mc < 0) return <span className="font-mono text-sm text-red-500">-{fmt(Math.abs(mc))}</span>;
      return <span className="font-mono text-sm">{fmt(mc)}</span>;
    }

    default:
      return "-";
  }
}
