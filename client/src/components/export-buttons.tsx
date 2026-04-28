import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Download, ChevronDown } from "lucide-react";
import {
  type AsinResult,
  type PriceSource,
  type Settings,
  type ColumnId,
  ALL_COLUMNS,
} from "@shared/schema";
import { type ColumnConfig } from "@/lib/columns";
import { getRowValue } from "./results-table";

interface ExportButtonsProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
}

// The "product" column is a combined cell in the UI. When exporting, split it
// into discrete sub-columns. Only include sub-columns that aren't already
// visible as their own standalone column.
const PRODUCT_SUB_COLUMNS: { key: string; label: string; standaloneId?: ColumnId; getValue: (r: AsinResult) => string | number | null }[] = [
  { key: "asin", label: "ASIN", getValue: (r) => r.asin },
  { key: "sku", label: "SKU", getValue: (r) => r.sku ?? (r.skus && r.skus.length > 0 ? r.skus[0] : null) },
  { key: "title", label: "Title", getValue: (r) => r.catalogData.title },
];

const colLabelMap = new Map(ALL_COLUMNS.map((c) => [c.id, c.label]));

function buildExportColumns(
  columnConfig: ColumnConfig,
): { id: string; label: string; getValue: (r: AsinResult, priceSource: PriceSource, settings: Settings) => string | number | null }[] {
  const visibleOrder = columnConfig.order.filter((id) => columnConfig.visible.has(id));
  const visibleSet = new Set(visibleOrder);
  const cols: { id: string; label: string; getValue: (r: AsinResult, ps: PriceSource, s: Settings) => string | number | null }[] = [];

  for (const colId of visibleOrder) {
    if (colId === "product") {
      // Expand the combined Product cell into sub-columns
      for (const sub of PRODUCT_SUB_COLUMNS) {
        // Skip if the user already has this as a standalone visible column
        if (sub.standaloneId && visibleSet.has(sub.standaloneId)) continue;
        cols.push({
          id: `product_${sub.key}`,
          label: sub.label,
          getValue: (r) => sub.getValue(r),
        });
      }
    } else {
      cols.push({
        id: colId,
        label: colLabelMap.get(colId) ?? colId,
        getValue: (r, ps, s) => getRowValue(r, colId, ps, s),
      });
    }
  }

  return cols;
}

function formatValue(val: string | number | null): string {
  if (val == null) return "";
  if (typeof val === "number") {
    // Format percentages and currency nicely but keep as number for Excel
    return String(val);
  }
  return String(val);
}

function buildExportData(
  results: AsinResult[],
  priceSource: PriceSource,
  settings: Settings,
  columnConfig: ColumnConfig,
): { headers: string[]; rows: string[][] } {
  const cols = buildExportColumns(columnConfig);
  const headers = cols.map((c) => c.label);
  const rows = results.map((r) =>
    cols.map((c) => formatValue(c.getValue(r, priceSource, settings)))
  );
  return { headers, rows };
}

function downloadCsv(
  results: AsinResult[],
  priceSource: PriceSource,
  settings: Settings,
  columnConfig: ColumnConfig,
) {
  const { headers, rows } = buildExportData(results, priceSource, settings, columnConfig);
  if (rows.length === 0) return;

  function escapeCsv(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  const csv = [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => row.map(escapeCsv).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fba-analysis.csv";
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadExcel(
  results: AsinResult[],
  priceSource: PriceSource,
  settings: Settings,
  columnConfig: ColumnConfig,
) {
  const { headers, rows } = buildExportData(results, priceSource, settings, columnConfig);
  if (rows.length === 0) return;

  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "FBA Analysis");
  XLSX.writeFile(wb, "fba-analysis.xlsx");
}

export function ExportButtons({ results, priceSource, settings, columnConfig }: ExportButtonsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (results.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        data-testid="button-export"
      >
        <Download className="h-4 w-4 mr-1.5" />
        Export
        <ChevronDown className="h-3 w-3 ml-1" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[150px]">
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors"
            onClick={() => { downloadCsv(results, priceSource, settings, columnConfig); setOpen(false); }}
            data-testid="button-export-csv"
          >
            Download CSV
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors"
            onClick={() => { downloadExcel(results, priceSource, settings, columnConfig); setOpen(false); }}
            data-testid="button-export-xlsx"
          >
            Download Excel
          </button>
        </div>
      )}
    </div>
  );
}
