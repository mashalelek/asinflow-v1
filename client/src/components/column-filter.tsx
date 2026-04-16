import { useState } from "react";
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

type FilterType = "numeric" | "text" | "tags" | "boolean";

const NUMERIC_COLS = new Set<ColumnId>([
  "cogs", "salePrice", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage",
  "bsr", "sellersFba", "sellersFbm", "stock", "daysLeft",
  "fba7d", "fba30d", "fbm7d", "fbm30d",
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
]);

const TAG_COLS = new Set<ColumnId>(["tags"]);
const BOOL_COLS = new Set<ColumnId>(["meltable", "hazmat", "suppressed"]);

function getFilterType(colId: ColumnId): FilterType {
  if (NUMERIC_COLS.has(colId)) return "numeric";
  if (TAG_COLS.has(colId)) return "tags";
  if (BOOL_COLS.has(colId)) return "boolean";
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

const TAG_OPS = [
  { value: "hasTag", label: "Has tag" },
  { value: "notHasTag", label: "Does not have tag" },
];

interface ColumnFilterProps {
  colId: ColumnId;
  currentFilter: ColFilter | undefined;
  onApply: (filter: ColFilter) => void;
  onClear: () => void;
  availableTags?: string[];
}

export function ColumnFilterButton({ colId, currentFilter, onApply, onClear, availableTags }: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const filterType = getFilterType(colId);
  const ops = filterType === "numeric" ? NUMERIC_OPS : filterType === "tags" ? TAG_OPS : TEXT_OPS;
  const defaultOp = filterType === "numeric" ? "gt" : filterType === "tags" ? "hasTag" : "contains";

  const [op, setOp] = useState(currentFilter?.operator ?? defaultOp);
  const [val, setVal] = useState(currentFilter?.value ?? "");
  const [val2, setVal2] = useState(currentFilter?.value2 ?? "");

  const isActive = !!currentFilter;

  function handleApply() {
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
      <PopoverContent className={`${filterType === "boolean" ? "w-36" : "w-56"} p-3 space-y-2`} align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        {filterType === "boolean" ? (
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

        {filterType === "tags" ? (
          <Input
            placeholder="Tag name..."
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="h-8 text-xs"
            onKeyDown={(e) => e.key === "Enter" && handleApply()}
          />
        ) : (
          <>
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
          </>
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
    if (raw == null) return false;

    const filterType = getFilterType(f.colId as ColumnId);

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
    } else if (filterType === "tags") {
      const tagStr = String(raw).toLowerCase();
      const search = f.value.toLowerCase();
      if (f.operator === "hasTag" && !tagStr.includes(search)) return false;
      if (f.operator === "notHasTag" && tagStr.includes(search)) return false;
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
