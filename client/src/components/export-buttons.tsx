import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { type AsinResult, type PriceSource, type Settings, getSelectedPrice, calculateProfit } from "@shared/schema";

interface ExportButtonsProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
}

function buildExportData(results: AsinResult[], priceSource: PriceSource, settings: Settings) {
  return results.map((r) => {
    const { price, label } = getSelectedPrice(r, priceSource);
    let profit = null, roi = null, margin = null, inboundShipping = null;

    if (price != null && !r.error) {
      const calc = calculateProfit(
        price, r.cogs,
        r.feesData.fbaFulfillmentFee ?? 0,
        r.feesData.referralFee ?? 0,
        r.catalogData.weightLbs ?? 0,
        settings
      );
      profit = calc.profit;
      roi = calc.roi;
      margin = calc.margin;
      inboundShipping = calc.inboundShipping;
    }

    return {
      ASIN: r.asin,
      COGS: r.cogs,
      "Sale Price": price ?? "N/A",
      "Price Source": label,
      "FBA Fee": r.feesData.fbaFulfillmentFee ?? "N/A",
      "Referral Fee": r.feesData.referralFee ?? "N/A",
      "Inbound Shipping": inboundShipping ?? "N/A",
      "Prep Cost": settings.prepCost,
      "Storage Fee": settings.storageFee,
      "Profit per Unit": profit ?? "N/A",
      "Profit Margin (%)": margin != null ? margin.toFixed(1) : "N/A",
      "ROI (%)": roi != null ? roi.toFixed(1) : "N/A",
      "# Sellers": r.pricingData.numberOfSellers ?? "N/A",
      Error: r.error ?? "",
    };
  });
}

function downloadCsv(results: AsinResult[], priceSource: PriceSource, settings: Settings) {
  const data = buildExportData(results, priceSource, settings);
  if (data.length === 0) return;

  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(","),
    ...data.map((row) =>
      headers.map((h) => {
        const val = String((row as any)[h]);
        return val.includes(",") ? `"${val}"` : val;
      }).join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fba-analysis.csv";
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadExcel(results: AsinResult[], priceSource: PriceSource, settings: Settings) {
  const data = buildExportData(results, priceSource, settings);
  if (data.length === 0) return;

  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "FBA Analysis");
  XLSX.writeFile(wb, "fba-analysis.xlsx");
}

export function ExportButtons({ results, priceSource, settings }: ExportButtonsProps) {
  if (results.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => downloadCsv(results, priceSource, settings)}
        data-testid="button-export-csv"
      >
        <Download className="h-4 w-4 mr-1.5" />
        CSV
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => downloadExcel(results, priceSource, settings)}
        data-testid="button-export-xlsx"
      >
        <Download className="h-4 w-4 mr-1.5" />
        Excel
      </Button>
    </div>
  );
}
