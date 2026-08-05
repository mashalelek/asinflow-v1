import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
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
  filename?: string; // §21 bulk page: bulk-<listname>.csv; default fba-analysis.csv
  // §21 bulk page passes false: no Amazon SKUs exist there, so the Product
  // expansion's SKU sub-column would always be empty — the SKU-named column
  // in the bulk export is the standalone Supplier SKU column instead.
  includeSkuSubColumn?: boolean;
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
  includeSkuSubColumn: boolean,
): { id: string; label: string; getValue: (r: AsinResult, priceSource: PriceSource, settings: Settings) => string | number | null }[] {
  const visibleOrder = columnConfig.order.filter((id) => columnConfig.visible.has(id));
  const visibleSet = new Set(visibleOrder);
  const cols: { id: string; label: string; getValue: (r: AsinResult, ps: PriceSource, s: Settings) => string | number | null }[] = [];

  for (const colId of visibleOrder) {
    if (colId === "product") {
      // Expand the combined Product cell into sub-columns
      for (const sub of PRODUCT_SUB_COLUMNS) {
        if (sub.key === "sku" && !includeSkuSubColumn) continue;
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
  includeSkuSubColumn: boolean,
): { headers: string[]; rows: string[][] } {
  const cols = buildExportColumns(columnConfig, includeSkuSubColumn);
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
  filename: string,
  includeSkuSubColumn: boolean,
) {
  const { headers, rows } = buildExportData(results, priceSource, settings, columnConfig, includeSkuSubColumn);
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
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ results, priceSource, settings, columnConfig, filename = "fba-analysis.csv", includeSkuSubColumn = true }: ExportButtonsProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => downloadCsv(results, priceSource, settings, columnConfig, filename, includeSkuSubColumn)}
      disabled={results.length === 0}
      className="h-8 text-xs"
      data-testid="button-export"
    >
      <Download className="h-3.5 w-3.5 mr-1.5" />
      Export
    </Button>
  );
}
