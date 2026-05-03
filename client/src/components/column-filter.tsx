import { useState, useMemo } from "react";
import { Filter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ColumnId } from "@shared/schema";

export interface ColFilter {
  colId: ColumnId;
  operator: string;
  value: string;
  value2?: string;
}

export type FilterMap = Record<string, ColFilter>;

export interface MultiSelectOption {
  value: string;
  label: string;
  color?: string;
  count?: number;
}

type FilterType = "numeric" | "text" | "tags" | "supplier" | "boolean" | "reviewed";

const NUMERIC_COLS = new Set<ColumnId>([
  "cogs", "estCogs", "salePrice", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage",
  "sellersFba", "sellers", "stock", "daysLeft",
  "availableFba", "ordered", "reserved", "sentToFba",
  "fba7d", "fba30d", "sellers7d", "sellers30d",
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
  "actAvgSalePrice", "actPrepCost",
  "maxCogs",
]);

const BOOL_COLS = new Set<ColumnId>(["meltable", "hazmat", "suppressed"]);
const REVIEWED_COLS = new Set<ColumnId>(["dateAdded"]);

function getFilterType(colId: ColumnId): FilterType {
  if (NUMERIC_COLS.has(colId)) return "numeric";
  if (colId === "tags") return "tags";
  if (colId === "supplier") return "supplier";
  if (colId === "category") return "supplier"; // reuse supplier multi-select type
  if (colId === "sourcing") return "supplier"; // reuse supplier multi-select type
  if (BOOL_COLS.has(colId)) return "boolean";
  if (REVIEWED_COLS.has(colId)) return "reviewed";
  return "text";
}

const NUMERIC_OPS = [
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "Greater than or equals" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "Less than or equals" },
  { value: "eq", label: "Equals" },
  { value: "between", label: "Between" },
];

const TEXT_OPS = [
  { value: "contains", label: "Contains" },
  { value: "eq", label: "Equals" },
  { value: "startsWith", label: "Starts with" },
  { value: "notContains", label: "Does not contain" },
];

const REVIEWED_OPS = [
  { value: "never", label: "Never reviewed" },
  { value: "olderThan", label: "Not reviewed in last X days" },
  { value: "newerThan", label: "Reviewed in last X days" },
];

interface ColumnFilterProps {
  colId: ColumnId;
  currentFilter: ColFilter | undefined;
  onApply: (filter: ColFilter) => void;
  onClear: () => void;
  multiSelectOptions?: MultiSelectOption[];
}

// ── Multi-select checkbox list (used for tags and supplier) ──────────
function MultiSelectFilter({
  colId,
  options,
  currentFilter,
  onApply,
  onClear,
  onClose,
}: {
  colId: ColumnId;
  options: MultiSelectOption[];
  currentFilter: ColFilter | undefined;
  onApply: (filter: ColFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const currentSelected = useMemo(() => {
    if (!currentFilter) return new Set<string>();
    try { return new Set(JSON.parse(currentFilter.value) as string[]); } catch { return new Set<string>(); }
  }, [currentFilter]);

  const [selected, setSelected] = useState<Set<string>>(currentSelected);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"anyOf" | "allOf">(
    (currentFilter?.operator as "anyOf" | "allOf") ?? "anyOf",
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  function toggle(val: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
  }

  function apply() {
    if (selected.size === 0) { onClear(); onClose(); return; }
    onApply({ colId, operator: mode, value: JSON.stringify(Array.from(selected)) });
    onClose();
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-7 text-xs"
      />
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <button
          className="hover:text-foreground"
          onClick={() => setSelected(new Set(options.map((o) => o.value)))}
        >
          Select all
        </button>
        <span>·</span>
        <button className="hover:text-foreground" onClick={() => setSelected(new Set())}>
          Clear all
        </button>
        <span className="ml-auto">{selected.size} selected</span>
      </div>
      <div className="max-h-48 overflow-y-auto -mx-1 space-y-0.5">
        {filtered.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs"
          >
            <input
              type="checkbox"
              checked={selected.has(opt.value)}
              onChange={() => toggle(opt.value)}
              className="h-3 w-3 accent-blue-500"
            />
            {opt.color && (
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: opt.color }}
              />
            )}
            <span className="truncate flex-1">{opt.label}</span>
            {opt.count != null && (
              <span className="text-muted-foreground/60 text-[10px]">({opt.count})</span>
            )}
          </label>
        ))}
      </div>
      {colId === "tags" && (
        <div className="flex items-center gap-2 text-[10px]">
          <button
            className={`px-1.5 py-0.5 rounded ${mode === "anyOf" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            onClick={() => setMode("anyOf")}
          >
            Any of
          </button>
          <button
            className={`px-1.5 py-0.5 rounded ${mode === "allOf" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            onClick={() => setMode("allOf")}
          >
            All of
          </button>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button size="sm" className="h-7 text-xs flex-1" onClick={apply}>
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => { onClear(); onClose(); }}
          disabled={!currentFilter}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

export function ColumnFilterButton({ colId, currentFilter, onApply, onClear, multiSelectOptions }: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const filterType = getFilterType(colId);
  const isMultiSelect = filterType === "tags" || filterType === "supplier";
  const ops = filterType === "numeric" ? NUMERIC_OPS : filterType === "reviewed" ? REVIEWED_OPS : TEXT_OPS;
  const defaultOp = filterType === "numeric" ? "gt" : filterType === "reviewed" ? "never" : "contains";

  const [op, setOp] = useState(currentFilter?.operator ?? defaultOp);
  const [val, setVal] = useState(currentFilter?.value ?? "");
  const [val2, setVal2] = useState(currentFilter?.value2 ?? "");

  const isActive = !!currentFilter;

  function handleApply() {
    if (op === "never") {
      onApply({ colId, operator: op, value: "never" });
      setOpen(false);
      return;
    }
    if (!val.trim()) return;
    onApply({ colId, operator: op, value: val.trim(), value2: op === "between" ? val2.trim() : undefined });
    setOpen(false);
  }

  function handleClear() {
    setVal("");
    setVal2("");
    setOp(defaultOp);
    onClear();
    setOpen(false);
  }

  function handleOpen(nextOpen: boolean) {
    if (nextOpen && currentFilter) {
      setOp(currentFilter.operator);
      setVal(currentFilter.value);
      setVal2(currentFilter.value2 ?? "");
    }
    setOpen(nextOpen);
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          className={`inline-flex items-center justify-center rounded p-0.5 transition-colors ${
            isActive ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground"
          }`}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <Filter className="h-3 w-3" fill={isActive ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={`${filterType === "boolean" ? "w-36" : isMultiSelect ? "w-64" : "w-56"} p-3 space-y-2`}
        align="start"
        sideOffset={4}
        onClick={(e) => e.stopPropagation()}
      >
        {isMultiSelect && multiSelectOptions ? (
          <MultiSelectFilter
            colId={colId}
            options={multiSelectOptions}
            currentFilter={currentFilter}
            onApply={onApply}
            onClear={onClear}
            onClose={() => setOpen(false)}
          />
        ) : filterType === "reviewed" ? (
          <>
            <Select value={op} onValueChange={(v) => { setOp(v); if (v === "never") { setVal("never"); } }}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ops.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {op !== "never" && (
              <Input
                type="number"
                placeholder="Number of days..."
                value={val}
                onChange={(e) => setVal(e.target.value)}
                className="h-8 text-xs"
                onKeyDown={(e) => e.key === "Enter" && handleApply()}
              />
            )}
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs flex-1" onClick={handleApply}>Apply</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleClear} disabled={!isActive}>Clear</Button>
            </div>
          </>
        ) : filterType === "boolean" ? (
          <div className="flex flex-col gap-1">
            {[{ label: "All", value: "" }, { label: "Yes", value: "Yes" }, { label: "No", value: "No" }].map((opt) => (
              <button
                key={opt.label}
                className={`text-left text-sm px-2 py-1.5 rounded transition-colors ${
                  (opt.value === "" && !isActive) || (isActive && currentFilter?.value === opt.value)
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() => {
                  if (opt.value === "") { handleClear(); }
                  else { onApply({ colId, operator: "eq", value: opt.value }); setOpen(false); }
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
        <>
        <Select value={op} onValueChange={setOp}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type={filterType === "numeric" ? "number" : "text"}
          placeholder={filterType === "numeric" ? "Value..." : "Text..."}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="h-8 text-xs"
          onKeyDown={(e) => e.key === "Enter" && handleApply()}
        />
        {op === "between" && (
          <Input
            type="number"
            placeholder="Max value..."
            value={val2}
            onChange={(e) => setVal2(e.target.value)}
            className="h-8 text-xs"
            onKeyDown={(e) => e.key === "Enter" && handleApply()}
          />
        )}

        <div className="flex gap-2">
          <Button size="sm" className="h-7 text-xs flex-1" onClick={handleApply}>Apply</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleClear} disabled={!isActive}>Clear</Button>
        </div>
        </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Apply all column filters to a result row
export function matchesFilters(
  result: { [key: string]: any },
  filters: FilterMap,
  getValueFn: (colId: ColumnId) => string | number | null,
): boolean {
  for (const f of Object.values(filters)) {
    const raw = getValueFn(f.colId as ColumnId);
    const filterType = getFilterType(f.colId as ColumnId);

    // "reviewed" filters handle null specially (null = "never reviewed")
    if (filterType === "reviewed") {
      if (f.operator === "never") {
        if (raw != null) return false;
        continue;
      }
      if (raw == null) {
        if (f.operator === "newerThan") return false;
        continue;
      }
      const days = parseFloat(f.value);
      if (isNaN(days)) return false;
      const ts = new Date(String(raw)).getTime();
      const cutoff = Date.now() - days * 86400000;
      if (f.operator === "olderThan" && ts > cutoff) return false;
      if (f.operator === "newerThan" && ts < cutoff) return false;
      continue;
    }

    // Multi-select filters: tags and supplier
    if (filterType === "tags" || filterType === "supplier") {
      let selected: string[];
      try { selected = JSON.parse(f.value); } catch { continue; }
      if (!Array.isArray(selected) || selected.length === 0) continue;

      const selectedSet = new Set(selected.map((s) => s.toLowerCase()));
      const hasNone = selectedSet.has("__none__");

      if (filterType === "tags") {
        const tagStr = raw != null ? String(raw).toLowerCase() : "";
        const rowTags = tagStr ? tagStr.split(", ").map((t) => t.trim()).filter(Boolean) : [];

        if (hasNone && rowTags.length === 0) continue;
        if (hasNone) selectedSet.delete("__none__");
        if (selectedSet.size === 0) { if (rowTags.length === 0) continue; return false; }

        if (f.operator === "allOf") {
          const selectedArr = Array.from(selectedSet);
          for (let si = 0; si < selectedArr.length; si++) {
            if (!rowTags.includes(selectedArr[si])) return false;
          }
        } else {
          // anyOf
          const hasMatch = rowTags.some((t) => selectedSet.has(t));
          if (!hasMatch) return false;
        }
      } else {
        // supplier
        const val = raw != null ? String(raw).toLowerCase() : "";
        if (hasNone && !val) continue;
        if (!val && !hasNone) return false;
        if (val && !selectedSet.has(val)) return false;
      }
      continue;
    }

    if (raw == null) return false;

    if (filterType === "numeric") {
      const num = typeof raw === "number" ? raw : parseFloat(String(raw));
      const fv = parseFloat(f.value);
      if (isNaN(num) || isNaN(fv)) return false;
      switch (f.operator) {
        case "gt": if (!(num > fv)) return false; break;
        case "gte": if (!(num >= fv)) return false; break;
        case "lt": if (!(num < fv)) return false; break;
        case "lte": if (!(num <= fv)) return false; break;
        case "eq": if (num !== fv) return false; break;
        case "between": {
          const fv2 = parseFloat(f.value2 ?? "");
          if (isNaN(fv2)) return false;
          if (!(num >= fv && num <= fv2)) return false;
          break;
        }
      }
    } else {
      const str = String(raw).toLowerCase();
      const search = f.value.toLowerCase();
      switch (f.operator) {
        case "contains": if (!str.includes(search)) return false; break;
        case "eq": if (str !== search) return false; break;
        case "startsWith": if (!str.startsWith(search)) return false; break;
        case "notContains": if (str.includes(search)) return false; break;
      }
    }
  }
  return true;
}
