import { useState, useEffect, useCallback } from "react";
import { LayoutGrid, Save, Trash2, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { type ColumnConfig, saveColumnConfig } from "@/lib/columns";
import type { ColumnId } from "@shared/schema";
import type { FilterMap } from "./column-filter";

const ACTIVE_PRESET_KEY = "fba-active-preset";

// Map old DB column names to current ColumnId (handles legacy presets)
const COL_MAP: Record<string, ColumnId> = {
  image: "product", asin: "product", title: "product", selleramp: "product", keepa: "product",
  buy_link: "supplier", eligible: "product",
  sale_price: "salePrice", est_profit: "profit", est_margin: "margin", est_roi: "roi",
  fba_fee: "fbaFee", referral_fee: "referralFee", inbound_ship: "inboundShipping",
  prep_cost: "prep", sellers_fba: "sellersFba",
  // Removed columns map to closest equivalent
  sellers_fbm: "sellers", bsr: "sellersFba",
  fbm7d: "sellers7d", fbm30d: "sellers30d",
  lastReviewed: "dateAdded",
  stock: "stock", units_sold: "actUnitsSold", revenue: "actRevenue",
  refunds: "actRefunds", actual_profit: "actProfit",
  actual_profit_unit: "actProfitPerUnit", actual_margin: "actMargin", actual_roi: "actRoi",
  tags: "tags", notes: "notes", brand: "brand", cogs: "cogs",
};

interface PresetConfig {
  columns?: string[];
  order?: ColumnId[];
  visible?: ColumnId[];
  sort_by?: string;
  sort_dir?: string;
  filter?: string;
  colFilters?: FilterMap;
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
  sortCol?: ColumnId | null;
  sortDir?: "asc" | "desc";
  colFilters?: FilterMap;
  onColFiltersChange?: (filters: FilterMap) => void;
}

function mapPresetToConfig(preset: Preset): ColumnConfig {
  const cfg = preset.config;
  if (cfg.order && cfg.visible) {
    return { order: cfg.order as ColumnId[], visible: new Set(cfg.visible as ColumnId[]) };
  }
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

function buildSaveConfig(
  columnConfig: ColumnConfig,
  sortCol?: ColumnId | null,
  sortDir?: "asc" | "desc",
  filter?: string | null,
  colFilters?: FilterMap,
): PresetConfig {
  return {
    order: columnConfig.order,
    visible: Array.from(columnConfig.visible) as ColumnId[],
    sort_by: sortCol ?? undefined,
    sort_dir: sortDir ?? "desc",
    filter: filter ?? undefined,
    colFilters: colFilters && Object.keys(colFilters).length > 0 ? colFilters : undefined,
  };
}

export function ViewPresets({
  columnConfig, onColumnConfigChange,
  onSortChange, onPresetFilterChange,
  sortCol, sortDir, colFilters, onColFiltersChange,
}: ViewPresetsProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_PRESET_KEY); } catch { return null; }
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [activePresetFilter, setActivePresetFilter] = useState<string | null>(null);

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
    // Apply sort
    const sc = preset.config.sort_by as ColumnId | undefined;
    const sd = (preset.config.sort_dir as "asc" | "desc") ?? "desc";
    if (sc && onSortChange) onSortChange(sc, sd);
    // Apply preset filter
    const pf = preset.config.filter ?? null;
    setActivePresetFilter(pf);
    if (onPresetFilterChange) onPresetFilterChange(pf);
    // Apply column filters
    if (onColFiltersChange) onColFiltersChange(preset.config.colFilters ?? {});
    setOpen(false);
  }

  async function saveAsNew() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const config = buildSaveConfig(columnConfig, sortCol, sortDir, activePresetFilter, colFilters);
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

  async function updateCurrentView() {
    if (!activeId) return;
    const active = presets.find((p) => p.id === activeId);
    if (!active) return;
    setSaving(true);
    try {
      const config = buildSaveConfig(columnConfig, sortCol, sortDir, activePresetFilter, colFilters);
      await fetch(`/api/view-presets/${activeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      setPresets((prev) =>
        prev.map((p) => p.id === activeId ? { ...p, config } : p)
      );
    } catch {}
    setSaving(false);
  }

  async function renamePreset(id: string) {
    if (!renameVal.trim()) return;
    try {
      await fetch(`/api/view-presets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameVal.trim() }),
      });
      setPresets((prev) => prev.map((p) => p.id === id ? { ...p, name: renameVal.trim() } : p));
      setRenamingId(null);
    } catch {}
  }

  async function deletePreset(id: string) {
    if (!window.confirm("Delete this view?")) return;
    await fetch(`/api/view-presets/${id}`, { method: "DELETE" });
    setPresets((prev) => prev.filter((p) => p.id !== id));
    if (activeId === id) {
      setActiveId(null);
      localStorage.removeItem(ACTIVE_PRESET_KEY);
    }
  }

  async function resetBuiltInPreset(id: string) {
    // Re-fetch presets to get the original config (server stores the default)
    if (!window.confirm("Reset this built-in view to its default settings?")) return;
    // The simplest reset: delete local override. Server presets have is_default=true
    // and can't be deleted. We just re-activate the unmodified preset.
    fetchPresets();
  }

  const activePreset = presets.find((p) => p.id === activeId);
  const activeName = activePreset?.name ?? "Custom";

  // Count active column filters for indicator
  const activeColFilterCount = colFilters ? Object.keys(colFilters).length : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <LayoutGrid className="h-3.5 w-3.5" />
          {activeName}
          {activeColFilterCount > 0 && (
            <span className="ml-1 bg-primary/20 text-primary text-[10px] px-1 rounded-full">{activeColFilterCount}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start" sideOffset={4}>
        {presets.map((p) => (
          <div key={p.id} className="flex items-center group">
            {renamingId === p.id ? (
              <div className="flex-1 flex gap-1 px-2 py-1">
                <Input
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") renamePreset(p.id); if (e.key === "Escape") setRenamingId(null); }}
                  className="h-6 text-xs"
                  autoFocus
                />
                <Button size="sm" className="h-6 text-xs px-1.5" onClick={() => renamePreset(p.id)}>
                  <Save className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <>
                <button
                  className={`flex-1 text-left px-3 py-1.5 rounded text-sm hover:bg-muted transition-colors ${activeId === p.id ? "bg-muted font-medium" : ""}`}
                  onClick={() => activatePreset(p)}
                >
                  {p.name}
                  {p.config.colFilters && Object.keys(p.config.colFilters).length > 0 && (
                    <span className="text-[10px] text-muted-foreground ml-1.5">
                      ({Object.keys(p.config.colFilters).length} filter{Object.keys(p.config.colFilters).length !== 1 ? "s" : ""})
                    </span>
                  )}
                </button>
                <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
                  {!p.is_default && (
                    <button
                      className="px-1 text-muted-foreground/40 hover:text-foreground"
                      onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameVal(p.name); }}
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {p.is_default ? (
                    <button
                      className="px-1 text-muted-foreground/40 hover:text-foreground"
                      onClick={(e) => { e.stopPropagation(); resetBuiltInPreset(p.id); }}
                      title="Reset to default"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  ) : (
                    <button
                      className="px-1 text-muted-foreground/40 hover:text-red-500"
                      onClick={(e) => { e.stopPropagation(); deletePreset(p.id); }}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}

        <div className="border-t border-border mt-1 pt-1">
          {showSave ? (
            <div className="px-2 py-1 space-y-1">
              <div className="flex gap-1">
                <Input
                  placeholder="View name..."
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="h-7 text-xs"
                  onKeyDown={(e) => e.key === "Enter" && saveAsNew()}
                  autoFocus
                />
                <Button size="sm" className="h-7 text-xs px-2" onClick={saveAsNew} disabled={!newName.trim() || saving}>
                  <Save className="h-3 w-3" />
                </Button>
              </div>
              <button
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => setShowSave(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              <button
                className="w-full text-left px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-muted transition-colors"
                onClick={() => setShowSave(true)}
              >
                + Save As New View
              </button>
              {activeId && (
                <button
                  className="w-full text-left px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-muted transition-colors"
                  onClick={() => { updateCurrentView(); setOpen(false); }}
                  disabled={saving}
                >
                  <Save className="h-3 w-3 inline mr-1.5" />
                  Update "{activeName}"
                </button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
