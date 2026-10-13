import { useState, useMemo, Fragment } from "react";
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
  group?: string; // options are pre-sorted; a group header renders when this changes
  tagId?: string; // §20 tags only — present when the option is a real tag row,
                  // which is what makes it deletable from the dropdown
}

// The server's palette (server/tags-repo.ts TAG_COLORS). POST /api/tags
// accepts a colour only if it is one of these, so the picker offers exactly
// these and nothing else.
export const TAG_COLORS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
];

type FilterType = "numeric" | "text" | "tags" | "supplier" | "boolean" | "reviewed" | "submission" | "date" | "indb";

export const NUMERIC_COLS = new Set<ColumnId>([
  "cogs", "estCogs", "salePrice", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage",
  "sellersFba", "sellers", "stock", "daysLeft",
  "availableFba", "ordered", "fbaStock", "reserved", "sentToFba",
  "fba7d", "fba30d", "sellers7d", "sellers30d",
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
  "actAvgSalePrice", "actPrepCost",
  "maxCogs",
]);

const BOOL_COLS = new Set<ColumnId>(["meltable", "hazmat", "suppressed"]);
const REVIEWED_COLS = new Set<ColumnId>(["dateAdded", "lastReviewed", "priceAge"]);

function getFilterType(colId: ColumnId): FilterType {
  if (NUMERIC_COLS.has(colId)) return "numeric";
  if (colId === "tags") return "tags";
  if (colId === "supplier") return "supplier";
  if (colId === "category") return "supplier"; // reuse supplier multi-select type
  if (colId === "sourcing") return "supplier"; // reuse supplier multi-select type
  if (colId === "status") return "supplier"; // status (2026-09-07): active/parked/dead multi-select
  if (BOOL_COLS.has(colId)) return "boolean";
  if (REVIEWED_COLS.has(colId)) return "reviewed";
  if (colId === "submission") return "submission";
  return "text";
}

// §6 Submission column categories. Acknowledged flags still match "Has flags"
// — acknowledgment mutes the render, never the category.
const SUBMISSION_OPTIONS = [
  { label: "All", value: "" },
  { label: "Has flags", value: "flags" },
  { label: "Failed", value: "failed" },
  { label: "Clean", value: "clean" },
  { label: "None", value: "none" },
];

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
// §11 Price Age (2026-09-06): same mechanism, neutral labels — the Date
// Added / Last Reviewed filters keep their wording.
const PRICE_AGE_OPS = [
  { value: "never", label: "Never synced" },
  { value: "olderThan", label: "Older than X days" },
  { value: "newerThan", label: "Within last X days" },
];

// §21 generic date filter (2026-09-08): presets + custom range on any
// date-valued column. Operators are self-describing ("date_*") so
// matchesFilters needs no per-page context; pages opt a column in via the
// dateFilter prop (Bulk Calc does for dateAdded — the main page's existing
// filter behavior is untouched).
const DATE_OPS = [
  { value: "date_today", label: "Today" },
  { value: "date_last7", label: "Last 7 days" },
  { value: "date_last30", label: "Last 30 days" },
  { value: "date_range", label: "Custom range" },
];

// §21 in-database filter (2026-09-12): self-describing operator "indb"
// (like the date_* ops) so matchesFilters needs no page context — the
// page's getValueFn answers the sentinel key "__inDatabase" with
// "yes"/"no". Attached to the Product column on Bulk Calc only.
export const IN_DB_SENTINEL = "__inDatabase";
const INDB_OPS = [
  { value: "yes", label: "In database" },
  { value: "no", label: "Not in database" },
];

interface ColumnFilterProps {
  colId: ColumnId;
  currentFilter: ColFilter | undefined;
  onApply: (filter: ColFilter) => void;
  onClear: () => void;
  multiSelectOptions?: MultiSelectOption[];
  // §20 tag management from the filter dropdown (2026-10-13). Absent = the
  // list is read-only, which is what every non-tag multi-select gets.
  onTagsChanged?: () => void;
  /** Opt this column into the generic date filter type (presets + range). */
  dateFilter?: boolean;
  /** Opt this column into the in-database tri-state (§21 Bulk Calc Product column). */
  inDbFilter?: boolean;
}

// ── Multi-select checkbox list (used for tags and supplier) ──────────
function MultiSelectFilter({
  colId,
  options,
  currentFilter,
  onApply,
  onClear,
  onClose,
  onTagsChanged,
}: {
  colId: ColumnId;
  options: MultiSelectOption[];
  currentFilter: ColFilter | undefined;
  onApply: (filter: ColFilter) => void;
  onClear: () => void;
  onClose: () => void;
  onTagsChanged?: () => void;
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

  // §20 tag management (2026-10-13). Only mounted when onTagsChanged is
  // supplied, i.e. the tags filter — every other multi-select stays read-only.
  const manageable = typeof onTagsChanged === "function";
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [newGroup, setNewGroup] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState<MultiSelectOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const existingGroups = useMemo(
    () => Array.from(new Set(options.map((o) => o.group).filter((g): g is string => !!g))).sort(),
    [options],
  );
  // Case-insensitive on the trimmed value, matching the server.
  const nameTaken = useMemo(() => {
    const n = newName.trim().toLowerCase();
    return !!n && options.some((o) => o.label.toLowerCase() === n);
  }, [newName, options]);

  async function createTag() {
    const name = newName.trim();
    if (!name || nameTaken || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: newColor, tagGroup: newGroup || null }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
      setNewName(""); setNewGroup(""); setCreating(false);
      onTagsChanged?.();
    } catch (e: any) { setErr(e?.message ?? "create failed"); }
    finally { setBusy(false); }
  }

  async function deleteTag(opt: MultiSelectOption) {
    if (!opt.tagId || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/tags/${opt.tagId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
      // If the deleted tag was part of the ACTIVE filter, drop it and
      // re-apply — otherwise the filter keeps referencing a tag that no
      // longer exists and the view silently shows nothing.
      if (selected.has(opt.value)) {
        const next = new Set(selected);
        next.delete(opt.value);
        setSelected(next);
        if (currentFilter) {
          if (next.size === 0) onClear();
          else onApply({ colId, operator: mode, value: JSON.stringify(Array.from(next)) });
        }
      }
      setConfirmDelete(null);
      onTagsChanged?.();
    } catch (e: any) { setErr(e?.message ?? "delete failed"); }
    finally { setBusy(false); }
  }

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
        {filtered.map((opt, i) => (
          <Fragment key={opt.value}>
            {opt.group && opt.group !== filtered[i - 1]?.group && (
              <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {opt.group}
              </div>
            )}
          {confirmDelete?.value === opt.value ? (
            // The confirm REPLACES this row, in place (2026-10-13). It used
            // to render at the bottom of this scrolling container, so
            // clicking × on a tag near the top looked like nothing happened
            // — the confirm was below 25 rows, outside the max-h-48 viewport.
            // Replacing the row keeps it where the user's attention already
            // is and costs no layout shift.
            <div
              className="px-2 py-1.5 rounded border border-destructive/40 bg-destructive/5 space-y-1.5"
              data-testid={`tag-delete-confirm-${opt.value}`}
            >
              <p className="text-[11px] leading-snug">
                Delete <span className="font-semibold">'{opt.label}'</span>? Removes it from{" "}
                {opt.count ?? 0} ASIN{(opt.count ?? 0) === 1 ? "" : "s"}.
              </p>
              {err && <p className="text-[10px] text-destructive">{err}</p>}
              <div className="flex gap-1">
                <Button
                  size="sm" variant="destructive" className="h-6 text-[11px] flex-1"
                  disabled={busy} onClick={() => deleteTag(opt)}
                >
                  {busy ? "Deleting…" : "Delete"}
                </Button>
                <Button
                  size="sm" variant="ghost" className="h-6 text-[11px]"
                  disabled={busy} onClick={() => { setConfirmDelete(null); setErr(null); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
          <label
            className="group flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs"
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
            {manageable && opt.tagId && (
              // × on hover, matching the row tag chips' remove affordance.
              <button
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive text-[11px] leading-none px-0.5 transition-opacity"
                title={`Delete '${opt.label}'`}
                data-testid={`tag-delete-${opt.value}`}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setErr(null); setConfirmDelete(opt); }}
              >
                ×
              </button>
            )}
          </label>
          )}
          </Fragment>
        ))}

        {/* §20: create from the dropdown, at the bottom of the list. */}
        {manageable && (creating ? (
          <div className="px-2 py-1.5 space-y-1.5 border-t mt-1">
            <Input
              autoFocus
              placeholder="Tag name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createTag(); if (e.key === "Escape") setCreating(false); }}
              className="h-6 text-xs"
            />
            <div className="flex items-center gap-1 flex-wrap">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  title={c}
                  onClick={() => setNewColor(c)}
                  className={`w-3.5 h-3.5 rounded-full border-2 ${newColor === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <select
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              className="w-full h-6 text-xs rounded border border-input bg-background px-1"
            >
              <option value="">(ungrouped)</option>
              {existingGroups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            {nameTaken && <p className="text-[10px] text-destructive">A tag with that name already exists.</p>}
            <div className="flex gap-1">
              <Button size="sm" className="h-6 text-[11px] flex-1" disabled={!newName.trim() || nameTaken || busy} onClick={createTag}>
                {busy ? "Creating…" : "Create"}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => { setCreating(false); setNewName(""); setErr(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            className="w-full text-left px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
            onClick={() => { setCreating(true); setErr(null); }}
          >
            + New tag
          </button>
        ))}

        {/* The delete confirm is NOT here — it renders inline, replacing the
            row that was clicked, so it is always in view. "+ New tag" and
            its form stay pinned at the bottom, which is where a create
            belongs. This bottom error line is therefore create-only; a
            delete error shows inside the inline confirm. */}
        {err && !confirmDelete && <p className="px-2 text-[10px] text-destructive">{err}</p>}
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

export function ColumnFilterButton({ colId, currentFilter, onApply, onClear, multiSelectOptions, dateFilter, inDbFilter, onTagsChanged }: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const filterType: FilterType = inDbFilter ? "indb" : dateFilter ? "date" : getFilterType(colId);
  const isMultiSelect = filterType === "tags" || filterType === "supplier";
  const ops = filterType === "numeric" ? NUMERIC_OPS
    : filterType === "indb" ? INDB_OPS
    : filterType === "date" ? DATE_OPS
    : filterType === "reviewed" ? (colId === "priceAge" ? PRICE_AGE_OPS : REVIEWED_OPS)
    : TEXT_OPS;
  const defaultOp = filterType === "numeric" ? "gt" : filterType === "indb" ? "yes" : filterType === "date" ? "date_last7" : filterType === "reviewed" ? "never" : "contains";

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
    if (op === "yes" || op === "no") {
      // in-database tri-state: All = Clear; the two states carry no input.
      onApply({ colId, operator: "indb", value: op });
      setOpen(false);
      return;
    }
    // Date presets carry no input; the range needs both bounds.
    if (op === "date_today" || op === "date_last7" || op === "date_last30") {
      onApply({ colId, operator: op, value: op });
      setOpen(false);
      return;
    }
    if (op === "date_range") {
      if (!val.trim() || !val2.trim()) return;
      onApply({ colId, operator: op, value: val.trim(), value2: val2.trim() });
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
      // indb stores operator "indb" + value yes/no — the select edits the value.
      setOp(currentFilter.operator === "indb" ? currentFilter.value : currentFilter.operator);
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
        className={`${filterType === "boolean" || filterType === "submission" ? "w-36" : isMultiSelect ? "w-64" : "w-56"} p-3 space-y-2`}
        align="start"
        sideOffset={4}
        onClick={(e) => e.stopPropagation()}
      >
        {isMultiSelect && multiSelectOptions ? (
          <MultiSelectFilter
            colId={colId}
            options={multiSelectOptions}
            onTagsChanged={colId === "tags" ? onTagsChanged : undefined}
            currentFilter={currentFilter}
            onApply={onApply}
            onClear={onClear}
            onClose={() => setOpen(false)}
          />
        ) : filterType === "indb" ? (
          <>
            <Select value={op} onValueChange={setOp}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-indb-op"><SelectValue /></SelectTrigger>
              <SelectContent>
                {INDB_OPS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1.5 pt-1">
              <Button size="sm" className="h-7 text-xs flex-1" onClick={handleApply}>Apply</Button>
              {isActive && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleClear}>All</Button>}
            </div>
          </>
        ) : filterType === "date" ? (
          <>
            <Select value={op} onValueChange={setOp}>
              <SelectTrigger className="h-8 text-xs" data-testid={`select-date-op-${colId}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {ops.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {op === "date_range" && (
              <div className="space-y-1">
                <Input type="date" value={val} onChange={(e) => setVal(e.target.value)} className="h-8 text-xs" data-testid={`input-date-from-${colId}`} />
                <Input type="date" value={val2} onChange={(e) => setVal2(e.target.value)} className="h-8 text-xs" data-testid={`input-date-to-${colId}`} />
              </div>
            )}
            <div className="flex gap-1.5 pt-1">
              <Button size="sm" className="h-7 text-xs flex-1" onClick={handleApply}>Apply</Button>
              {isActive && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleClear}>Clear</Button>}
            </div>
          </>
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
        ) : filterType === "submission" ? (
          <div className="flex flex-col gap-1">
            {SUBMISSION_OPTIONS.map((opt) => (
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

    // In-database tri-state (2026-09-12) — self-describing; the page's
    // getValueFn answers the sentinel key with "yes"/"no".
    if (f.operator === "indb") {
      const v = getValueFn(IN_DB_SENTINEL as any);
      if (String(v) !== f.value) return false;
      continue;
    }

    // Generic date operators (2026-09-08) — self-describing, so they work
    // regardless of the column's page-level type. Raw must parse as a date;
    // null/unparseable never matches a date filter.
    if (typeof f.operator === "string" && f.operator.startsWith("date_")) {
      const ts = raw != null ? new Date(String(raw)).getTime() : NaN;
      if (isNaN(ts)) return false;
      const now = new Date();
      if (f.operator === "date_today") {
        const d = new Date(ts);
        if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) return false;
      } else if (f.operator === "date_last7" || f.operator === "date_last30") {
        const days = f.operator === "date_last7" ? 7 : 30;
        if (ts < Date.now() - days * 86400000) return false;
      } else if (f.operator === "date_range") {
        // yyyy-mm-dd bounds parsed as LOCAL days, inclusive on both ends.
        const parseLocal = (s: string) => { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
        const from = parseLocal(f.value).getTime();
        const to = parseLocal(f.value2 ?? f.value).getTime() + 86400000;
        if (isNaN(from) || isNaN(to)) return false;
        if (ts < from || ts >= to) return false;
      }
      continue;
    }

    // §6 Submission column: categorical eq — value is the category string
    // ("flags" | "failed" | "clean" | "none"); null raw = "none".
    if (filterType === "submission") {
      const cat = raw != null ? String(raw) : "none";
      if (cat !== f.value) return false;
      continue;
    }

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
