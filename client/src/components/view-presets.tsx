import { useState, useEffect, useCallback } from "react";
import { LayoutGrid, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { type ColumnConfig, saveColumnConfig } from "@/lib/columns";
import type { ColumnId } from "@shared/schema";

const ACTIVE_PRESET_KEY = "fba-active-preset";

// Map old DB column names to current ColumnId
const COL_MAP: Record<string, ColumnId> = {
  image: "product", asin: "product", title: "product", selleramp: "product", keepa: "product",
  buy_link: "supplier", eligible: "product",
  sale_price: "salePrice", est_profit: "profit", est_margin: "margin", est_roi: "roi",
  fba_fee: "fbaFee", referral_fee: "referralFee", inbound_ship: "inboundShipping",
  prep_cost: "prep", sellers_fba: "sellersFba", sellers_fbm: "sellersFbm",
  stock: "stock", units_sold: "actUnitsSold", revenue: "actRevenue",
  refunds: "actRefunds", actual_profit: "actProfit",
  actual_profit_unit: "actProfitPerUnit", actual_margin: "actMargin", actual_roi: "actRoi",
  tags: "tags", notes: "notes", brand: "brand", cogs: "cogs", bsr: "bsr",
};

interface PresetConfig {
  columns?: string[];
  order?: ColumnId[];
  visible?: ColumnId[];
  sort_by?: string;
  sort_dir?: string;
  filter?: string;
}

interface Preset {
  id: string;
  name: string;
  config: PresetConfig;
  is_default: boolean;
}

interface ViewPresetsProps {
  columnConfig: ColumnConfig;
  onColumnConfigChange: (config: ColumnConfig) => void;
  onSortChange?: (col: ColumnId, dir: "asc" | "desc") => void;
  onPresetFilterChange?: (filter: string | null) => void;
}

function mapPresetToConfig(preset: Preset): ColumnConfig {
  const cfg = preset.config;
  // Handle our own saved format
  if (cfg.order && cfg.visible) {
    return { order: cfg.order as ColumnId[], visible: new Set(cfg.visible as ColumnId[]) };
  }
  // Handle DB seeded format with old column names
  if (cfg.columns) {
    const seen = new Set<ColumnId>();
    const order: ColumnId[] = [];
    for (const col of cfg.columns) {
      const mapped = COL_MAP[col] ?? (col as ColumnId);
      if (!seen.has(mapped)) {
        seen.add(mapped);
        order.push(mapped);
      }
    }
    return { order, visible: new Set(order) };
  }
  return { order: [], visible: new Set() };
}

export function ViewPresets({ columnConfig, onColumnConfigChange, onSortChange, onPresetFilterChange }: ViewPresetsProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_PRESET_KEY); } catch { return null; }
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [showSave, setShowSave] = useState(false);

  const fetchPresets = useCallback(() => {
    fetch("/api/view-presets").then((r) => r.json()).then(setPresets).catch(() => {});
  }, []);

  useEffect(() => { fetchPresets(); }, [fetchPresets]);

  function activatePreset(preset: Preset) {
    const config = mapPresetToConfig(preset);
    onColumnConfigChange(config);
    saveColumnConfig(config);
    setActiveId(preset.id);
    localStorage.setItem(ACTIVE_PRESET_KEY, preset.id);
    // Apply sort from preset
    const sortCol = preset.config.sort_by as ColumnId | undefined;
    const sortDir = (preset.config.sort_dir as "asc" | "desc") ?? "desc";
    if (sortCol && onSortChange) onSortChange(sortCol, sortDir);
    // Apply preset filter
    if (onPresetFilterChange) onPresetFilterChange(preset.config.filter ?? null);
    setOpen(false);
  }

  async function saveCurrentView() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const config = {
        order: columnConfig.order,
        visible: Array.from(columnConfig.visible),
      };
      const res = await fetch("/api/view-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), config }),
      });
      const preset = await res.json();
      setPresets((prev) => [...prev, preset]);
      setActiveId(preset.id);
      localStorage.setItem(ACTIVE_PRESET_KEY, preset.id);
      setNewName("");
      setShowSave(false);
    } catch {}
    setSaving(false);
  }

  async function deletePreset(id: string) {
    await fetch(`/api/view-presets/${id}`, { method: "DELETE" });
    setPresets((prev) => prev.filter((p) => p.id !== id));
    if (activeId === id) {
      setActiveId(null);
      localStorage.removeItem(ACTIVE_PRESET_KEY);
    }
  }

  const activeName = presets.find((p) => p.id === activeId)?.name ?? "Custom";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <LayoutGrid className="h-3.5 w-3.5" />
          {activeName}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start" sideOffset={4}>
        {presets.map((p) => (
          <div key={p.id} className="flex items-center group">
            <button
              className={`flex-1 text-left px-3 py-1.5 rounded text-sm hover:bg-muted transition-colors ${activeId === p.id ? "bg-muted font-medium" : ""}`}
              onClick={() => activatePreset(p)}
            >
              {p.name}
            </button>
            {!p.is_default && (
              <button
                className="px-1.5 text-muted-foreground/40 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => { e.stopPropagation(); deletePreset(p.id); }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        <div className="border-t border-border mt-1 pt-1">
          {showSave ? (
            <div className="px-2 py-1 flex gap-1">
              <Input
                placeholder="Preset name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-7 text-xs"
                onKeyDown={(e) => e.key === "Enter" && saveCurrentView()}
                autoFocus
              />
              <Button size="sm" className="h-7 text-xs px-2" onClick={saveCurrentView} disabled={!newName.trim() || saving}>
                <Save className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <button
              className="w-full text-left px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-muted transition-colors"
              onClick={() => setShowSave(true)}
            >
              + Save Current View
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
