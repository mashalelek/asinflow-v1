import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  ResponsiveContainer, Legend,
} from "recharts";

interface StockHistoryModalProps {
  asin: string;
  title: string | null;
  startDate: string;
  endDate: string;
  onClose: () => void;
}

interface HistoryData {
  sales: { date: string; units_sold: number; revenue: number }[];
  inventory: { date: string; available_fba: number; reserved: number; inbound: number }[];
  metrics: {
    days_left: number | null;
    velocity: number;
    stock_value: number;
    reserved: number;
    inbound: number;
    on_order: number;
    at_prep: number;
    inbound_fba: number;
    pipeline: number;
  };
}

export function StockHistoryModal({ asin, title, startDate, endDate, onClose }: StockHistoryModalProps) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/asins/${asin}/history?startDate=${startDate}&endDate=${endDate}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [asin, startDate, endDate]);

  // Merge sales and inventory into chart data by date
  const chartData = (() => {
    if (!data) return [];
    const toDay = (iso: string) => iso.substring(0, 10);
    const map = new Map<string, { date: string; units_sold: number; available_fba: number | null }>();
    for (const s of data.sales) {
      const d = toDay(s.date);
      map.set(d, { date: d, units_sold: s.units_sold, available_fba: null });
    }
    for (const i of data.inventory) {
      const d = toDay(i.date);
      const existing = map.get(d);
      if (existing) {
        existing.available_fba = i.available_fba;
      } else {
        map.set(d, { date: d, units_sold: 0, available_fba: i.available_fba });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  const m = data?.metrics;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl w-[900px] max-w-[95vw] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold">{title ?? asin}</h3>
            <p className="text-xs text-muted-foreground font-mono">{asin}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">Loading...</div>
        ) : !data ? (
          <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">No data available</div>
        ) : (
          <div className="flex gap-4 p-5">
            {/* Left: metrics */}
            <div className="w-[180px] flex-shrink-0 space-y-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Days of Stock Left</div>
                <div className={`text-lg font-semibold ${m!.days_left != null ? (m!.days_left < 7 ? "text-red-500" : m!.days_left <= 14 ? "text-amber-500" : "text-emerald-500") : ""}`}>
                  {m!.days_left != null ? m!.days_left : "–"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Sales Velocity</div>
                <div className="font-medium">{m!.velocity} units/day</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Stock Value</div>
                <div className="font-medium">${m!.stock_value.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Reserved</div>
                <div className="font-medium">{m!.reserved}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Amazon Inbound</div>
                <div className="font-medium">{m!.inbound}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">On Order (POs)</div>
                <div className="font-medium">{m!.on_order}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Pipeline (POs)</div>
                <div className="font-medium">{m!.pipeline}</div>
              </div>
            </div>

            {/* Right: chart */}
            <div className="flex-1 min-w-0">
              {chartData.length === 0 ? (
                <div className="flex items-center justify-center h-[350px] text-muted-foreground text-sm">No sales or inventory data in this date range</div>
              ) : (
                <ResponsiveContainer width="100%" height={350}>
                  <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(d: string) => { const [, m, day] = d.split("-"); return `${parseInt(m)}/${parseInt(day)}`; }}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      label={{ value: "Units Sold", angle: -90, position: "insideLeft", style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      label={{ value: "Stock", angle: 90, position: "insideRight", style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }}
                    />
                    <ReTooltip
                      contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: "hsl(var(--foreground))" }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="units_sold" name="Daily Sales" fill="#10B981" radius={[2, 2, 0, 0]} />
                    <Line yAxisId="right" dataKey="available_fba" name="Stock Level" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
