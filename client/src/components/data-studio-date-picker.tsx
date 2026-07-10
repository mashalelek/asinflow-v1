/**
 * Data Studio–style date range picker (v3).
 *
 * Two nested UI layers (per spec):
 *
 *   Layer 1 — TRIGGER + PANEL
 *     Trigger button in the top nav. Label = current range
 *     ("May 22, 2026 - May 22, 2026"), never the word "Date range".
 *     Click → opens the PANEL: dark header bar + white body + footer
 *     (~520px wide). Click-outside or ESC discards staged changes.
 *
 *   Layer 2 — PRESET SELECTOR (inside the panel's header)
 *     A chip on the right of the dark header showing the current preset
 *     ("Yesterday" / "Advanced" / etc.). Click → opens the PRESET MENU
 *     rendered as a DOM child of the panel (NOT a separate portaled
 *     popover) so it sits inside the panel's z-index stack. Hover
 *     "This month ▸" or "Last 7 days ▸" → flyout submenu, also a DOM
 *     child of the menu item, with real viewport-overflow detection
 *     to flip leftward when there's no room on the right.
 *
 * Selecting a preset updates the panel body but does NOT close the panel.
 * Only the Apply button commits the staged range to the parent.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { type DateRange, DEFAULT_ADVANCED } from "@/contexts/date-range-context";
import {
  computePresetRange, computeAdvancedRange,
  fmtTriggerLabel, fmtLongDate, fmtISO, parseISO,
  PRESET_LABEL, UNIT_LABEL,
  type PresetKey, type AdvancedConfig, type AdvancedRef,
  type AdvancedAnchor, type AdvancedOp, type AdvancedUnit,
} from "@/lib/date-presets";

// ─── Menu shape ──────────────────────────────────────────────────────────────

interface LeafItem { kind: "leaf"; preset: PresetKey; label: string }
interface SubItem  { kind: "sub";  label: string; children: { preset: PresetKey; label: string }[] }
type MenuItem = LeafItem | SubItem;

const MENU: MenuItem[] = [
  { kind: "leaf", preset: "fixed",     label: PRESET_LABEL.fixed },
  { kind: "leaf", preset: "today",     label: PRESET_LABEL.today },
  { kind: "leaf", preset: "yesterday", label: PRESET_LABEL.yesterday },
  {
    kind: "sub", label: "This month",
    children: [
      { preset: "this_week_sun",         label: PRESET_LABEL.this_week_sun },
      { preset: "this_week_to_date_sun", label: PRESET_LABEL.this_week_to_date_sun },
      { preset: "this_week_mon",         label: PRESET_LABEL.this_week_mon },
      { preset: "this_week_to_date_mon", label: PRESET_LABEL.this_week_to_date_mon },
      { preset: "this_month",            label: PRESET_LABEL.this_month },
      { preset: "this_month_to_date",    label: PRESET_LABEL.this_month_to_date },
      { preset: "this_quarter",          label: PRESET_LABEL.this_quarter },
      { preset: "this_quarter_to_date",  label: PRESET_LABEL.this_quarter_to_date },
      { preset: "this_year",             label: PRESET_LABEL.this_year },
      { preset: "this_year_to_date",     label: PRESET_LABEL.this_year_to_date },
    ],
  },
  {
    kind: "sub", label: "Last 7 days",
    children: [
      { preset: "last_7_days",   label: PRESET_LABEL.last_7_days },
      { preset: "last_14_days",  label: PRESET_LABEL.last_14_days },
      { preset: "last_28_days",  label: PRESET_LABEL.last_28_days },
      { preset: "last_30_days",  label: PRESET_LABEL.last_30_days },
      { preset: "last_week_sun", label: PRESET_LABEL.last_week_sun },
      { preset: "last_week_mon", label: PRESET_LABEL.last_week_mon },
      { preset: "last_month",    label: PRESET_LABEL.last_month },
      { preset: "last_quarter",  label: PRESET_LABEL.last_quarter },
      { preset: "last_year",     label: PRESET_LABEL.last_year },
    ],
  },
  { kind: "leaf", preset: "advanced", label: PRESET_LABEL.advanced },
];

// ─── Main component ──────────────────────────────────────────────────────────

interface Props {
  value: DateRange;
  onApply: (next: DateRange) => void;
  className?: string;
}

export function DataStudioDatePicker({ value, onApply, className }: Props) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [staged, setStaged] = useState<DateRange>(value);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);

  // When the panel opens, snapshot current value into staged.
  useEffect(() => {
    if (panelOpen) { setStaged(value); setPresetMenuOpen(false); }
  }, [panelOpen, value]);

  // Close preset menu on outside click (not the chip, not the menu itself).
  useEffect(() => {
    if (!presetMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-preset-chip], [data-preset-menu]")) setPresetMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [presetMenuOpen]);

  const triggerLabel = useMemo(() => fmtTriggerLabel(value.start, value.end), [value.start, value.end]);
  const stagedPresetLabel = PRESET_LABEL[staged.preset] ?? "Fixed";
  const isAdvanced = staged.preset === "advanced";

  const handlePickPreset = (preset: PresetKey) => {
    setPresetMenuOpen(false);
    if (preset === "fixed") {
      setStaged((s) => ({ ...s, preset: "fixed", advancedConfig: undefined }));
    } else if (preset === "advanced") {
      const cfg = staged.advancedConfig ?? DEFAULT_ADVANCED;
      const r = computeAdvancedRange(cfg);
      setStaged({ ...r, preset: "advanced", advancedConfig: cfg });
    } else {
      const r = computePresetRange(preset);
      setStaged({ ...r, preset, advancedConfig: undefined });
    }
  };

  const handleApply = () => { onApply(staged); setPanelOpen(false); };

  return (
    <Popover open={panelOpen} onOpenChange={setPanelOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "h-9 px-3 inline-flex items-center justify-between gap-3 min-w-[260px]",
            "border border-[#44403C] rounded-md bg-transparent text-[#F5F5F4]",
            "hover:bg-[#44403C] transition-colors text-xs font-normal",
            className,
          )}
          aria-label={`Date range: ${triggerLabel}`}
        >
          <span>{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-70 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          "p-0 w-[520px] border-0 shadow-2xl overflow-visible bg-transparent",
          "rounded-md",
        )}
      >
        {/* ─── Header bar with preset chip ─── */}
        <div className="bg-[#44403C] px-3 py-2.5 flex justify-end rounded-t-md relative">
          <PresetChip
            label={stagedPresetLabel}
            open={presetMenuOpen}
            onToggle={() => setPresetMenuOpen((v) => !v)}
          />
          {presetMenuOpen && (
            <PresetMenu active={staged.preset} onPick={handlePickPreset} />
          )}
        </div>

        {/* ─── Body ─── */}
        <div className="bg-white dark:bg-[#292524] px-4 py-4">
          {isAdvanced ? (
            <AdvancedBody
              cfg={staged.advancedConfig ?? DEFAULT_ADVANCED}
              onChange={(cfg) => {
                const r = computeAdvancedRange(cfg);
                setStaged({ ...r, preset: "advanced", advancedConfig: cfg });
              }}
            />
          ) : (
            <CalendarBody
              start={staged.start}
              end={staged.end}
              onPickStart={(d) =>
                setStaged((s) => ({ ...s, start: d, preset: "fixed", advancedConfig: undefined }))
              }
              onPickEnd={(d) =>
                setStaged((s) => ({ ...s, end: d, preset: "fixed", advancedConfig: undefined }))
              }
            />
          )}
        </div>

        {/* ─── Footer ─── */}
        <div className="bg-white dark:bg-[#292524] px-4 pb-3 pt-1 flex justify-end rounded-b-md">
          <button
            onClick={handleApply}
            className="bg-[#44403C] text-[#F5F5F4] hover:bg-[#57534E] px-5 py-1.5 rounded text-xs font-medium"
          >
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Preset chip (inside header) ─────────────────────────────────────────────

function PresetChip({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      data-preset-chip
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs",
        "bg-[#44403C] border border-[#57534E] text-[#F5F5F4]",
        "hover:bg-[#57534E]",
        open && "border-[#3B82F6]",
      )}
    >
      <span>{label}</span>
      <ChevronDown className="h-3 w-3 opacity-80" />
    </button>
  );
}

// ─── Preset menu (DOM child of panel, not a separate popover) ────────────────

function PresetMenu({ active, onPick }: { active: PresetKey; onPick: (p: PresetKey) => void }) {
  return (
    <div
      data-preset-menu
      className={cn(
        "absolute top-full right-3 mt-1 z-50 min-w-[180px]",
        "bg-white dark:bg-[#292524]",
        "border border-stone-200 dark:border-[#44403C] rounded shadow-xl",
        "py-1 text-sm text-stone-900 dark:text-[#F5F5F4]",
      )}
    >
      {MENU.map((item, idx) =>
        item.kind === "leaf"
          ? <LeafMenuItem key={idx} item={item} isActive={active === item.preset} onPick={onPick} />
          : <SubMenuItem key={idx} item={item} active={active} onPick={onPick} />
      )}
    </div>
  );
}

function LeafMenuItem({ item, isActive, onPick }: { item: LeafItem; isActive: boolean; onPick: (p: PresetKey) => void }) {
  return (
    <button
      onClick={() => onPick(item.preset)}
      className={cn(
        "w-full text-left px-4 py-2 hover:bg-[#F5F4EF] dark:hover:bg-[#44403C]",
        isActive && "bg-[#E7E5E4] dark:bg-[#44403C]",
      )}
    >
      {item.label}
    </button>
  );
}

function SubMenuItem({ item, active, onPick }: { item: SubItem; active: PresetKey; onPick: (p: PresetKey) => void }) {
  const [hovered, setHovered] = useState(false);
  const subRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<"right" | "left">("right");

  // Measure after the submenu mounts; flip if it would overflow the viewport.
  useLayoutEffect(() => {
    if (!hovered || !subRef.current) return;
    const rect = subRef.current.getBoundingClientRect();
    if (placement === "right" && rect.right > window.innerWidth - 8) {
      setPlacement("left");
    }
    // (we don't auto-flip back to right; once flipped, stay flipped this open)
  }, [hovered, placement]);

  // Reset placement when submenu closes so it tries right again next time.
  useEffect(() => { if (!hovered) setPlacement("right"); }, [hovered]);

  const childActive = item.children.some((c) => c.preset === active);

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={cn(
          "w-full text-left px-4 py-2 flex items-center justify-between",
          "hover:bg-[#F5F4EF] dark:hover:bg-[#44403C]",
          (hovered || childActive) && "bg-[#F5F4EF] dark:bg-[#44403C]",
        )}
      >
        <span>{item.label}</span>
        <ChevronRight className="h-3.5 w-3.5 opacity-60 ml-2" />
      </button>
      {hovered && (
        <div
          ref={subRef}
          className={cn(
            "absolute top-0 z-50 min-w-[240px] py-1",
            placement === "right" ? "left-full -ml-px" : "right-full mr-px",
            "bg-white dark:bg-[#292524]",
            "border border-stone-200 dark:border-[#44403C] rounded shadow-xl",
          )}
        >
          {item.children.map((c) => (
            <button
              key={c.preset}
              onClick={() => onPick(c.preset)}
              className={cn(
                "w-full text-left px-4 py-2",
                "hover:bg-[#F5F4EF] dark:hover:bg-[#44403C]",
                active === c.preset && "bg-[#E7E5E4] dark:bg-[#44403C]",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Calendar body (dual month, current month only) ──────────────────────────

interface MonthRef { year: number; month: number /* 0-11 */ }
const monthOf = (iso: string): MonthRef => {
  const d = parseISO(iso); return { year: d.getFullYear(), month: d.getMonth() };
};
const prevMonth = (m: MonthRef): MonthRef => m.month === 0 ? { year: m.year - 1, month: 11 } : { year: m.year, month: m.month - 1 };
const nextMonth = (m: MonthRef): MonthRef => m.month === 11 ? { year: m.year + 1, month: 0 } : { year: m.year, month: m.month + 1 };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function CalendarBody({ start, end, onPickStart, onPickEnd }: {
  start: string; end: string;
  onPickStart: (d: string) => void; onPickEnd: (d: string) => void;
}) {
  const [leftMonth, setLeftMonth] = useState<MonthRef>(() => monthOf(start));
  const [rightMonth, setRightMonth] = useState<MonthRef>(() => monthOf(end));

  // Snap each calendar to the corresponding selected date's month when it changes externally.
  useEffect(() => { setLeftMonth(monthOf(start)); }, [start]);
  useEffect(() => { setRightMonth(monthOf(end)); }, [end]);

  return (
    <div className="grid grid-cols-2 gap-6">
      <MonthCalendar
        title="Start Date"
        m={leftMonth}
        onPrev={() => setLeftMonth(prevMonth)}
        onNext={() => setLeftMonth(nextMonth)}
        start={start} end={end}
        onPick={onPickStart}
      />
      <MonthCalendar
        title="End Date"
        m={rightMonth}
        onPrev={() => setRightMonth(prevMonth)}
        onNext={() => setRightMonth(nextMonth)}
        start={start} end={end}
        onPick={onPickEnd}
      />
    </div>
  );
}

function MonthCalendar({ title, m, onPrev, onNext, start, end, onPick }: {
  title: string;
  m: MonthRef;
  onPrev: () => void;
  onNext: () => void;
  start: string;
  end: string;
  onPick: (iso: string) => void;
}) {
  const startDate = parseISO(start);
  const endDate = parseISO(end);

  const firstOfMonth = new Date(m.year, m.month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Sun
  const daysInMonth = new Date(m.year, m.month + 1, 0).getDate();
  const monthName = firstOfMonth.toLocaleString("en-US", { month: "long" }).toUpperCase();
  const monthShort = monthName.slice(0, 3);

  // 6×7 grid; null cells for leading/trailing.
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0 || cells.length < 42) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < 42; i += 7) rows.push(cells.slice(i, i + 7));

  function classify(day: number): "start" | "end" | "between" | "none" {
    const cur = new Date(m.year, m.month, day);
    if (sameDay(cur, startDate)) return "start";
    if (sameDay(cur, endDate))   return "end";
    if (cur > startDate && cur < endDate) return "between";
    return "none";
  }

  return (
    <div className="space-y-2">
      <div className="text-center text-sm font-semibold text-stone-900 dark:text-[#F5F5F4]">{title}</div>

      {/* Header: month/year label + nav */}
      <div className="flex items-center justify-between px-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-900 dark:text-[#F5F5F4] inline-flex items-center gap-1">
          {monthName} {m.year}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onPrev} className="p-1 rounded hover:bg-stone-100 dark:hover:bg-[#44403C]" aria-label="Previous month">
            <ChevronLeft className="h-4 w-4 text-stone-700 dark:text-[#F5F5F4]" />
          </button>
          <button onClick={onNext} className="p-1 rounded hover:bg-stone-100 dark:hover:bg-[#44403C]" aria-label="Next month">
            <ChevronRight className="h-4 w-4 text-stone-700 dark:text-[#F5F5F4]" />
          </button>
        </div>
      </div>

      {/* Day-of-week */}
      <div className="grid grid-cols-7 text-center text-[11px] text-stone-500 dark:text-[#78716C] font-medium">
        {["S","M","T","W","T","F","S"].map((d, i) => <div key={i} className="py-1">{d}</div>)}
      </div>

      {/* Day grid */}
      <div className="space-y-0.5">
        {rows.map((row, ri) => (
          <div key={ri} className="grid grid-cols-7 relative">
            {/* "MAY" floating label in the first row's leftmost empty cell */}
            {ri === 0 && startWeekday > 0 && (
              <div className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wide text-stone-400 dark:text-[#78716C] pointer-events-none">
                {monthShort}
              </div>
            )}
            {row.map((d, ci) => {
              if (d === null) return <div key={ci} className="h-8" />;
              const state = classify(d);
              return (
                <div key={ci} className="relative h-8 flex items-center justify-center">
                  {/* Range fill (full-cell-width so adjacent cells visually connect) */}
                  {state === "between" && (
                    <div className="absolute inset-y-1 inset-x-0 bg-[#1E3A8A]/15 pointer-events-none" />
                  )}
                  <button
                    onClick={() => onPick(fmtISO(new Date(m.year, m.month, d)))}
                    className={cn(
                      "relative h-8 w-8 text-xs flex items-center justify-center rounded-full z-10",
                      state === "none"     && "text-stone-900 dark:text-[#F5F5F4] hover:bg-[#F5F4EF] dark:hover:bg-[#44403C]",
                      state === "between"  && "text-stone-900 dark:text-[#F5F5F4]",
                      state === "start"    && "bg-[#1E3A8A] text-white",
                      state === "end"      && "border-2 border-[#3B82F6] text-stone-900 dark:text-[#F5F5F4]",
                    )}
                  >
                    {d}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Advanced body (relative date builder) ───────────────────────────────────

function AdvancedBody({ cfg, onChange }: { cfg: AdvancedConfig; onChange: (cfg: AdvancedConfig) => void }) {
  const computed = useMemo(() => computeAdvancedRange(cfg), [cfg]);

  const updateRef = (side: "start" | "end", patch: Partial<AdvancedRef>) =>
    onChange({ ...cfg, [side]: { ...cfg[side], ...patch } });

  return (
    <div className="grid grid-cols-2 gap-6">
      <AdvancedColumn title="Start Date" date={computed.start} aref={cfg.start} onChange={(p) => updateRef("start", p)} />
      <AdvancedColumn title="End Date"   date={computed.end}   aref={cfg.end}   onChange={(p) => updateRef("end", p)} />
    </div>
  );
}

function AdvancedColumn({ title, date, aref, onChange }: {
  title: string;
  date: string;
  aref: AdvancedRef;
  onChange: (p: Partial<AdvancedRef>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-center">
        <div className="text-sm font-semibold text-stone-900 dark:text-[#F5F5F4]">{title}</div>
        <div className="text-xs text-stone-600 dark:text-[#A8A29E] mt-1">{fmtLongDate(date)}</div>
      </div>

      <Select value={aref.type} onValueChange={(v) => onChange({ type: v as AdvancedAnchor })}>
        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="today">Today</SelectItem>
          <SelectItem value="fixed">Fixed</SelectItem>
        </SelectContent>
      </Select>

      {aref.type === "fixed" ? (
        <Input
          type="date"
          value={aref.fixedDate ?? fmtISO(new Date())}
          onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && onChange({ fixedDate: e.target.value })}
          className="h-9 text-xs"
        />
      ) : (
        <>
          <Select value={aref.op} onValueChange={(v) => onChange({ op: v as AdvancedOp })}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="minus">Minus</SelectItem>
              <SelectItem value="plus">Plus</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="number"
            min={0}
            value={aref.value}
            onChange={(e) => onChange({ value: Math.max(0, parseInt(e.target.value || "0", 10) || 0) })}
            className="h-9 text-xs"
          />

          <Select value={aref.unit} onValueChange={(v) => onChange({ unit: v as AdvancedUnit })}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(UNIT_LABEL) as AdvancedUnit[]).map((u) => (
                <SelectItem key={u} value={u}>{UNIT_LABEL[u]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}
