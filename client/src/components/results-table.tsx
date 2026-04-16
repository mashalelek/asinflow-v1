import { useMemo, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExternalLink, AlertTriangle, ArrowUp, ArrowDown, Copy, Check, Lock, Unlock, ShoppingBag, Pencil, ShoppingCart, SearchX } from "lucide-react";

import {
  type AsinResult,
  type PriceSource,
  type Settings,
  type ColumnId,
  ALL_COLUMNS,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  extractDomain,
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
  product: 400,
  brand: 100,
  supplier: 100,
  cogs: 80,
  salePrice: 90,
  profit: 90,
  margin: 75,
  roi: 75,
  fbaFee: 80,
  referralFee: 85,
  inboundShipping: 85,
  prep: 80,
  storage: 80,
  bsr: 90,
  sellersFba: 80,
  sellersFbm: 80,
  fba7d: 75,
  fba30d: 80,
  fbm7d: 75,
  fbm30d: 80,
  tags: 100,
  notes: 100,
  stock: 75,
  daysLeft: 80,
  actUnitsSold: 80,
  actRevenue: 90,
  actRefunds: 75,
  actRefundPct: 75,
  actProfit: 90,
  actProfitPerUnit: 85,
  actMargin: 75,
  actRoi: 75,
  meltable: 85,
  hazmat: 80,
  suppressed: 90,
};

const ACTUALS_COLS = new Set<ColumnId>([
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
]);
const ESTIMATES_COLS = new Set<ColumnId>([
  "salePrice", "cogs", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage",
  "bsr", "sellersFba", "sellersFbm",
  "fba7d", "fba30d", "fbm7d", "fbm30d",
]);
import { type ColumnConfig } from "@/lib/columns";
import { type FilterMode } from "@/components/summary-cards";
import { ColumnFilterButton, type ColFilter, type FilterMap } from "@/components/column-filter";
import { TagEditor } from "@/components/tag-editor";
import { NoteEditor } from "@/components/note-editor";

function FaviconLink({
  href,
  src,
  fallback,
  label,
  testId,
}: {
  href: string;
  src: string;
  fallback: string;
  label: string;
  testId: string;
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
          onClick={(e) => e.stopPropagation()}
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

function KeepaLink({ asin, testId }: { asin: string; testId: string }) {
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
        onClick={(e) => e.stopPropagation()}
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
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
  activeFilter: FilterMode;
  buySet: Set<string>;
  onToggleBuy: (asin: string) => void;
  selectedSet?: Set<string>;
  onToggleSelect?: (asin: string) => void;
  onSelectAllPage?: (asins: string[]) => void;
  onClearSelection?: () => void;
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
}

function fmt(value: number | null): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function fmtBsr(rank: number | null, category: string | null): string {
  if (rank == null) return "-";
  const formatted = rank.toLocaleString();
  if (category) return `#${formatted} in ${category}`;
  return `#${formatted}`;
}

export function getRowValue(
  result: AsinResult,
  colId: ColumnId,
  priceSource: PriceSource,
  settings: Settings
): number | string | null {
  const { price } = getSelectedPrice(result, priceSource);
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);

  let profitData: ReturnType<typeof calculateProfit> | null = null;
  if (price != null && !result.error) {
    profitData = calculateProfit(
      price, result.cogs,
      result.feesData.fbaFulfillmentFee ?? 0,
      result.feesData.referralFee ?? 0,
      result.feesData.feesEstimatePrice,
      result.catalogData.weightLbs,
      prep.value,
      storage.value,
      settings,
      true,
      result.isHazmat ?? false
    );
  }

  switch (colId) {
    case "brand": return result.catalogData.brand;
    case "supplier": return extractDomain(result.buyLink);
    case "cogs": return result.cogs;
    case "salePrice": return price;
    case "profit": return profitData?.profit ?? null;
    case "margin": return profitData?.margin ?? null;
    case "roi": return profitData?.roi ?? null;
    case "fbaFee": return profitData?.totalFbaFee ?? result.feesData.fbaFulfillmentFee;
    case "referralFee": return profitData?.adjustedReferralFee ?? result.feesData.referralFee;
    case "inboundShipping": return profitData?.inboundShipping ?? null;
    case "prep": return prep.value;
    case "storage": return storage.value;
    case "bsr": return result.catalogData.bsrRank;
    case "sellersFba": return result.pricingData.sellersFba;
    case "sellersFbm": return result.pricingData.sellersFbm;
    case "fba7d": return result.sellersDelta?.fba_7d ?? null;
    case "fba30d": return result.sellersDelta?.fba_30d ?? null;
    case "fbm7d": return result.sellersDelta?.fbm_7d ?? null;
    case "fbm30d": return result.sellersDelta?.fbm_30d ?? null;
    case "tags": return result.tags?.map((t) => t.name).join(", ") ?? null;
    case "notes": return result.notes ?? null;
    case "meltable": return result.isMeltable ? "Yes" : "No";
    case "hazmat": return result.isHazmat ? "Yes" : "No";
    case "suppressed": return result.isSearchSuppressed ? "Yes" : "No";
    case "stock": return result.stock?.total ?? null;
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
      if (!result.actuals || result.actuals.units_sold === 0) return null;
      const au = result.actuals.units_sold;
      const ar = result.actuals.revenue;
      const ap = getEffectivePrep(result, settings);
      const as2 = getEffectiveStorage(result, settings);
      const ac = calculateProfit(ar / au, result.cogs, result.feesData.fbaFulfillmentFee ?? 0, result.feesData.referralFee ?? 0, result.feesData.feesEstimatePrice, result.catalogData.weightLbs, ap.value, as2.value, settings, true, result.isHazmat ?? false);
      if (colId === "actProfit") return ac.profit * au;
      if (colId === "actProfitPerUnit") return ac.profit;
      if (colId === "actMargin") return ac.margin;
      return ac.roi;
    }
    case "product": return result.catalogData.title ?? result.asin;
    default: return null;
  }
}

function isProfitable(result: AsinResult, priceSource: PriceSource, settings: Settings): boolean | null {
  if (result.error) return null;
  const { price } = getSelectedPrice(result, priceSource);
  if (price == null) return null;
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);
  const calc = calculateProfit(
    price, result.cogs,
    result.feesData.fbaFulfillmentFee ?? 0,
    result.feesData.referralFee ?? 0,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value, storage.value, settings,
    true, result.isHazmat ?? false
  );
  return calc.roi >= settings.minRoiThreshold && calc.margin >= settings.minMarginThreshold;
}

export function ResultsTable({
  results, priceSource, settings, columnConfig,
  activeFilter, buySet, onToggleBuy,
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
  onStockClick,
}: ResultsTableProps) {
  const colMap = useMemo(() => new Map(ALL_COLUMNS.map((c) => [c.id, c])), []);

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
    () => columnConfig.order.filter((id) => columnConfig.visible.has(id) && colMap.has(id)),
    [columnConfig, colMap]
  );

  // Filtering and sorting done in home.tsx before pagination. Use results directly.
  const sortedResults = useMemo(() => {
    return results;
  }, [results]);

  if (results.length === 0) return null;

  const frozenColWidth = { rowNum: 36, sel: 32, cart: 32 };
  const selLeft = frozenColWidth.rowNum;
  const cartLeft = selLeft + frozenColWidth.sel;

  // Columns for headers (exclude "product" — it gets special wide rendering, also exclude old frozen cols)
  const dataCols = visibleCols.filter((id) => id !== "product");
  const productVisible = visibleCols.includes("product");
  const estimatesCount = dataCols.filter((id) => ESTIMATES_COLS.has(id)).length;
  const actualsCount = dataCols.filter((id) => ACTUALS_COLS.has(id)).length;
  const hasGroups = estimatesCount > 0 || actualsCount > 0;

  return (
    <div className="w-full overflow-auto relative border-y border-border" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <table className="border-collapse text-sm w-full" data-testid="results-table">
        <thead className="sticky top-0 z-20">
          {hasGroups && (
            <tr className="border-b border-border bg-muted backdrop-blur">
              <th className="sticky left-0 z-30 bg-muted border-r border-border" style={{ width: frozenColWidth.rowNum }} />
              <th className="sticky z-30 bg-muted border-r border-border" style={{ left: selLeft, width: frozenColWidth.sel }} />
              <th className="sticky z-30 bg-muted border-r border-border" style={{ left: cartLeft, width: frozenColWidth.cart }} />
              {productVisible && <th className="bg-muted border-r border-border" />}
              {dataCols.map((colId, i) => {
                if (ESTIMATES_COLS.has(colId) && (i === 0 || !ESTIMATES_COLS.has(dataCols[i - 1]))) {
                  return (
                    <th key={`grp-est-${i}`} colSpan={estimatesCount} className="text-center text-xs font-semibold text-muted-foreground px-3 py-1 border-r border-border bg-blue-500/5">
                      Estimates
                    </th>
                  );
                }
                if (ESTIMATES_COLS.has(colId)) return null;
                if (ACTUALS_COLS.has(colId) && (i === 0 || !ACTUALS_COLS.has(dataCols[i - 1]))) {
                  return (
                    <th key={`grp-act-${i}`} colSpan={actualsCount} className="text-center text-xs font-semibold text-muted-foreground px-3 py-1 border-r border-border bg-emerald-500/5">
                      Actuals{dateRangeLabel ? ` (${dateRangeLabel})` : ""}
                    </th>
                  );
                }
                if (ACTUALS_COLS.has(colId)) return null;
                return <th key={`grp-other-${colId}`} className="bg-muted" />;
              })}
            </tr>
          )}
          <tr className="border-b border-border bg-muted/80 backdrop-blur">
            <th className="sticky left-0 z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
              #
            </th>
            <th className="sticky z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
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
            <th className="sticky z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border" style={{ left: cartLeft, width: frozenColWidth.cart, minWidth: frozenColWidth.cart }}>
              <ShoppingCart className="h-3 w-3 mx-auto text-muted-foreground" />
            </th>
            {productVisible && (
              <th className="text-left text-xs font-medium px-2 py-2 border-r border-border relative" style={{ width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200 }}>
                Product
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
                  className={`relative cursor-pointer select-none whitespace-nowrap hover:bg-muted/70 transition-colors px-3 py-2 text-xs font-medium ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${ESTIMATES_COLS.has(colId) ? "bg-blue-500/5" : ACTUALS_COLS.has(colId) ? "bg-emerald-500/5" : ""}`}
                  style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                  onClick={() => onSort(colId)}
                  data-testid={`header-${colId}`}
                >
                  <span className="inline-flex items-center gap-1 pr-2 overflow-hidden">
                    {col.label}
                    {isActive && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    {onFilterApply && onFilterClear && (
                      <ColumnFilterButton
                        colId={colId}
                        currentFilter={colFilters[colId]}
                        onApply={onFilterApply}
                        onClear={() => onFilterClear(colId)}
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

            let rowBg = "";
            let profitData: ReturnType<typeof calculateProfit> | null = null;

            if (!hasError && price != null) {
              profitData = calculateProfit(
                price, result.cogs,
                result.feesData.fbaFulfillmentFee ?? 0,
                result.feesData.referralFee ?? 0,
                result.feesData.feesEstimatePrice,
                result.catalogData.weightLbs,
                prep.value, storage.value, settings,
                includeInboundShipping,
                result.isHazmat ?? false
              );
              const meetsCriteria =
                profitData.roi >= settings.minRoiThreshold &&
                profitData.margin >= settings.minMarginThreshold;
              rowBg = meetsCriteria
                ? "bg-emerald-500/8 dark:bg-emerald-500/10"
                : "bg-red-500/8 dark:bg-red-500/10";
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
                className={`${rowBg} ${buyHighlight} ${archivedStyle} border-b border-border transition-colors hover:bg-muted/30`}
                data-testid={`row-result-${result.asin}`}
              >
                <td className={`sticky left-0 z-10 text-center text-xs text-muted-foreground px-1 py-1.5 border-r border-border ${frozenBg}`} style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
                  {idx + 1}
                </td>
                <td className={`sticky z-10 text-center px-1 py-1.5 border-r border-border ${frozenBg}`} style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
                  <input type="checkbox" checked={selectedSet.has(result.asin)} onChange={() => onToggleSelect?.(result.asin)} className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" data-testid={`checkbox-select-${result.asin}`} />
                </td>
                <td className={`sticky z-10 text-center px-1 py-1.5 border-r border-border ${frozenBg}`} style={{ left: cartLeft, width: frozenColWidth.cart, minWidth: frozenColWidth.cart }}>
                  <button onClick={() => onToggleBuy(result.asin)} className="p-0.5" data-testid={`btn-cart-${result.asin}`}>
                    <ShoppingCart className={`h-3.5 w-3.5 ${isBuy ? "text-blue-500 fill-blue-500/20" : "text-muted-foreground/30 hover:text-muted-foreground"} transition-colors`} />
                  </button>
                </td>
                {productVisible && (
                  <td className="px-2 py-1.5 border-r border-border overflow-hidden" style={{ width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200, maxWidth: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product }}>
                    <ProductCell result={result} price={price} settings={settings} onResultUpdate={onResultUpdate} />
                  </td>
                )}
                {dataCols.map((colId) => {
                  const col = colMap.get(colId)!;
                  const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
                  let content;
                  if (colId === "tags" && onResultUpdate) {
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
                          <div>Available (FBA): <span className="font-semibold">{result.stock.available_fba}</span></div>
                          <div>Ordered: <span className="font-semibold">{result.stock.ordered}</span></div>
                          <div>Reserved: <span className="font-semibold">{result.stock.reserved}</span></div>
                          <div>Sent to FBA: <span className="font-semibold">{result.stock.inbound}</span></div>
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
                      />
                    );
                  } else {
                    content = renderCell(colId, result, price, label, hasError, profitData, settings, prep, storage, includeInboundShipping, priceFallback);
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

function ProductCell({ result, price, settings, onResultUpdate }: { result: AsinResult; price: number | null; settings: Settings; onResultUpdate?: (asin: string, updates: Partial<AsinResult>) => void }) {
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
            onClick={(e) => e.stopPropagation()}
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
                <TooltipContent side="top" className="text-xs">
                  {result.skus.map((s) => <div key={s}>{s}</div>)}
                </TooltipContent>
              )}
            </Tooltip>
          ) : result.sku ? (
            <span className="text-muted-foreground truncate max-w-[140px]">· {result.sku}</span>
          ) : null}
          <FaviconLink
            href={`https://sas.selleramp.com/sas/lookup?SasLookup[search_term]=${result.asin}&SasLookup[cost_price]=${result.cogs}&SasLookup[sale_price]=${price ?? ""}`}
            src="https://sas.selleramp.com/images/sas_web_logo_32x32.png"
            fallback="SA"
            label="Open in SellerAmp"
            testId={`link-selleramp-${result.asin}`}
          />
          <KeepaLink asin={result.asin} testId={`link-keepa-${result.asin}`} />
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
          {result.inCatalog ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <ShoppingBag className="h-3 w-3 text-blue-500 flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">Listed in your catalog</p></TooltipContent>
            </Tooltip>
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
              <TooltipContent side="top"><p className="text-xs">Create listing on Seller Central</p></TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Line 2: Title + ungating icon */}
        <div className="flex items-center gap-1">
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
            <a href={result.buyLink!} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
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
          <span>· COGS: ${result.cogs?.toFixed(2) ?? "0.00"}</span>
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

function renderCell(
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
) {
  switch (colId) {
    case "brand": {
      const brand = result.catalogData.brand;
      if (!brand) return <span className="text-muted-foreground text-sm">-</span>;
      return <span className="text-sm" data-testid={`text-brand-${result.asin}`}>{brand}</span>;
    }

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

    case "cogs":
      return <span className="font-mono text-sm">{fmt(result.cogs)}</span>;

    case "salePrice":
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
      return <span className="text-muted-foreground text-sm">N/A</span>;

    case "profit":
      return (
        <span className={`font-mono text-sm font-semibold ${
          profitData
            ? profitData.profit >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmt(profitData.profit) : "-"}
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
          {profitData ? fmtPct(profitData.margin) : "-"}
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
          {profitData ? fmtPct(profitData.roi) : "-"}
        </span>
      );

    case "fbaFee":
      return <span className="font-mono text-sm">{profitData ? fmt(profitData.totalFbaFee) : fmt(result.feesData.fbaFulfillmentFee)}</span>;

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
      return <span className="font-mono text-sm" data-testid={`text-inboundShipping-${result.asin}`}>{profitData ? fmt(profitData.inboundShipping ?? 0) : "-"}</span>;
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

    case "bsr":
      return (
        <span className="text-sm whitespace-nowrap">
          {fmtBsr(result.catalogData.bsrRank, result.catalogData.bsrCategory)}
        </span>
      );

    case "sellersFba":
      return <span className="font-mono text-sm" data-testid={`text-sellersFba-${result.asin}`}>{result.pricingData.sellersFba !== null && result.pricingData.sellersFba !== undefined ? result.pricingData.sellersFba : "-"}</span>;

    case "sellersFbm":
      return <span className="font-mono text-sm" data-testid={`text-sellersFbm-${result.asin}`}>{result.pricingData.sellersFbm !== null && result.pricingData.sellersFbm !== undefined ? result.pricingData.sellersFbm : "-"}</span>;

    case "fba7d":
    case "fba30d":
    case "fbm7d":
    case "fbm30d": {
      const deltaMap: Record<string, number | null | undefined> = {
        fba7d: result.sellersDelta?.fba_7d,
        fba30d: result.sellersDelta?.fba_30d,
        fbm7d: result.sellersDelta?.fbm_7d,
        fbm30d: result.sellersDelta?.fbm_30d,
      };
      const v = deltaMap[colId];
      if (v == null) return <span className="font-mono text-sm text-muted-foreground">–</span>;
      if (v === 0) return <span className="font-mono text-sm text-muted-foreground">0</span>;
      // Negative = fewer sellers = good (green ▼), Positive = more sellers = bad (red ▲)
      const color = v < 0 ? "text-emerald-500" : "text-red-500";
      const arrow = v < 0 ? "▼" : "▲";
      return <span className={`font-mono text-sm ${color}`}>{arrow} {Math.abs(v)}</span>;
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
              style={{ backgroundColor: t.color }}
            >
              {t.name}
            </span>
          ))}
        </div>
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

    case "meltable":
      return <span className={`text-sm ${result.isMeltable ? "text-blue-400" : "text-muted-foreground"}`}>{result.isMeltable ? "Yes" : "No"}</span>;

    case "hazmat":
      return <span className={`text-sm ${result.isHazmat ? "text-amber-400" : "text-muted-foreground"}`}>{result.isHazmat ? "Yes" : "No"}</span>;

    case "suppressed":
      return <span className={`text-sm ${result.isSearchSuppressed ? "text-amber-400" : "text-muted-foreground"}`}>{result.isSearchSuppressed ? "Yes" : "No"}</span>;

    case "stock": {
      const s = result.stock;
      if (!s) return <span className="text-muted-foreground text-sm">-</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-sm cursor-help">{s.total}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs space-y-0.5">
            <div>Available (FBA): <span className="font-semibold">{s.available_fba}</span></div>
            <div>Ordered: <span className="font-semibold">{s.ordered}</span></div>
            <div>Reserved: <span className="font-semibold">{s.reserved}</span></div>
            <div>Sent to FBA: <span className="font-semibold">{s.inbound}</span></div>
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
      if (us === 0 || activeDays === 0) return <span className="font-mono text-sm text-muted-foreground">–</span>;
      const velocity = us / activeDays;
      if (stk === 0) return <span className="font-mono text-sm text-red-500 font-semibold">0</span>;
      const days = Math.round(stk / velocity);
      const color = days < 7 ? "text-red-500 font-semibold" : days <= 14 ? "text-amber-500" : "text-emerald-500";
      return <span className={`font-mono text-sm ${color}`}>{days}</span>;
    }

    case "actUnitsSold":
      return <span className="font-mono text-sm">{result.actuals ? result.actuals.units_sold : "-"}</span>;

    case "actRevenue":
      return <span className="font-mono text-sm">{result.actuals ? `$${result.actuals.revenue.toFixed(2)}` : "-"}</span>;

    case "actRefunds":
      return <span className="font-mono text-sm">{result.actuals ? result.actuals.units_refunded : "-"}</span>;

    case "actRefundPct": {
      if (!result.actuals || result.actuals.units_sold === 0) return <span className="font-mono text-sm">-</span>;
      const pct = (result.actuals.units_refunded / result.actuals.units_sold) * 100;
      return <span className="font-mono text-sm">{pct.toFixed(1)}%</span>;
    }

    case "actProfit": {
      if (!result.actuals || result.actuals.units_sold === 0) return <span className="font-mono text-sm">-</span>;
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.cogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        result.isHazmat ?? false
      );
      const total = perUnit.profit * units;
      return (
        <span className={`font-mono text-sm font-semibold ${total >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          ${total.toFixed(2)}
        </span>
      );
    }

    case "actProfitPerUnit": {
      if (!result.actuals || result.actuals.units_sold === 0) return <span className="font-mono text-sm">-</span>;
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.cogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        result.isHazmat ?? false
      );
      return (
        <span className={`font-mono text-sm ${perUnit.profit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          ${perUnit.profit.toFixed(2)}
        </span>
      );
    }

    case "actMargin": {
      if (!result.actuals || result.actuals.units_sold === 0) return <span className="font-mono text-sm">-</span>;
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.cogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        result.isHazmat ?? false
      );
      return (
        <span className={`font-mono text-sm ${perUnit.margin >= settings.minMarginThreshold ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {perUnit.margin.toFixed(1)}%
        </span>
      );
    }

    case "actRoi": {
      if (!result.actuals || result.actuals.units_sold === 0) return <span className="font-mono text-sm">-</span>;
      const units = result.actuals.units_sold;
      const rev = result.actuals.revenue;
      const prep2 = getEffectivePrep(result, settings);
      const storage2 = getEffectiveStorage(result, settings);
      const perUnit = calculateProfit(
        rev / units,
        result.cogs,
        result.feesData.fbaFulfillmentFee ?? 0,
        result.feesData.referralFee ?? 0,
        result.feesData.feesEstimatePrice,
        result.catalogData.weightLbs,
        prep2.value, storage2.value, settings,
        includeInboundShipping,
        result.isHazmat ?? false
      );
      return (
        <span className={`font-mono text-sm ${perUnit.roi >= settings.minRoiThreshold ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {perUnit.roi.toFixed(1)}%
        </span>
      );
    }

    default:
      return "-";
  }
}
