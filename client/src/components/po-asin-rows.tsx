/**
 * ASINs table — the §4 column model, ONE component for both places it
 * renders: the PO detail ASINs tab and the POs page's nested "Expand by
 * ASIN" rows (patch docs/claude_spec-patch-po-expand-by-asin.md §3.2, §4).
 *
 * Fixed column widths (colgroup + table-fixed) so separate instances line
 * up: the POs page shows the header once, under the first expanded PO, and
 * every later expanded PO's rows align with it.
 */
import { RefundProposalDialog, type PoHeaderMoney, type CanceledLine } from "@/components/refund-due-dialog";
import React, { useState } from "react";
import { Link } from "wouter";
import { ChevronRight, ChevronDown, AlertTriangle, Plus, X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtQty, individualUnits, PO_ASIN_DISPLAY_COLUMNS, VELOCITY_QTY_TITLE } from "@/lib/po-qty";
import { InlineEdit, poApi, ReassignShipment, shipmentBlockText } from "@/components/po-edit";
import { InlineNoteCell, NoteIcon } from "@/components/inline-note";
import { DEFECT_ACTION_ITEM, defectSummary } from "@shared/po-defect";
import { titlePackSuggestion } from "@shared/pack-parse";
import { asinPackSetNote } from "@shared/po-form";
import { useToast } from "@/hooks/use-toast";

export interface PoAsinShipment {
  id: string;
  velocity_shipment_id: string;        // Velocity UUID, or manual:<uuid>
  fba_shipment_ids: string[];          // the SC shipments it fanned out to (D1)
  sc_match: "none" | "matched" | "ambiguous" | "unmatched" | string;
  qty_shipped: string;
  qty_received: string | null;         // NULL until matched to SC
  shipped_at: string | null;
  source: "velocity" | "manual" | string;
  /** 'manual' = placed by Reassign (af-owned §5.2); Sync Shipments never moves it. */
  assigned_by?: "auto" | "manual" | string;
}
export interface PoAsinLine {
  id: string;
  position: number | null;
  product_name: string | null;
  /** "stored 0.50, ×1 gives 1.00" — the line's stored yield and the row's pack disagree ("Pack size mismatch", 2026-11-06). */
  pack_mismatch_note?: string;
  supplier_sku: string | null;
  price: string | null;
  item_discount: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  qty_canceled: number | null;
  qty_returned: number | null;
  final_qty: number | null;
  asin_qty_per_product: string | null;
  /** Exact yield (migration 080): retailer units / product ÷ ASIN units / pack; NULL on an unresolved sheet-imported line. */
  retailer_units_per_product?: number | null;
  asin_units_per_pack?: number | null;
  adjusted_product_cost: string | null;
  notes: string | null;
  /** Row-level Status: this product's action items. */
  action_items?: string[];
}
export interface PoAsinRowData {
  id: string;
  /** Open supplier defects on this ASIN row's lines (SPEC §22 "Supplier defects"). */
  defects_open?: OpenDefectBrief[];
  po_id: string;
  asin: string;
  asin_name: string | null;
  sku: string | null;
  qty: number;                       // Ordered (ASIN qty)
  cost_per_unit: string | null;
  total_cost: string | null;
  prep_cost: string | null;
  /** NULL = not known ("Pack size missing", 2026-11-06). */
  sold_as: string | null;
  units_per_pack: number | null;
  notes: string | null;
  thumbnail: string | null;
  // derived from the lines (NULL = some line untracked)
  qty_canceled_asin: string | null;
  qty_returned_asin: string | null;
  // stored ASIN quantities (NULL = not tracked)
  qty_shipped_supplier: string | null;
  /** Received by Velocity (2026-11-02): cumulative units Velocity ever checked in, ASIN units; NULL = never seen at Velocity. */
  received_velocity: string | null;
  qty_at_prep: string | null;
  qty_at_warehouse: string | null;
  qty_lost_damaged_us: string | null;
  qty_shipped_fba: string | null;
  qty_received_amazon: string | null;
  shipments: PoAsinShipment[];
  /** Union of the product lines' action items (row-level Status 2026-10-17). */
  action_items?: string[];
  /** "Extra units shipped" note — the picker's overshoot confirm or the manual clear (migration 073). */
  extra_units_note?: string | null;
  /** Each mismatched line's yield note, joined (the row's "Pack size mismatch" hover). */
  pack_mismatch_note?: string;
  lines?: PoAsinLine[];
}

// Widths (px) sized to what each column holds; header labels wrap to two or three lines inside them
// (2026-11-01: labels overlapped their neighbours). Product takes what is left (fixed layout, no width).
// 2026-11-05 (Maria: the right-hand columns clipped at 1440, 160 rem): 17 display columns, 1,028 px fixed
// + lead / note + Product (min 84) = 1,118 px — the nested table fits the POs table at 1024 (1,118 px box) and fills it at 1280 / 1440.
const COL_WIDTHS: Record<Exclude<(typeof PO_ASIN_DISPLAY_COLUMNS)[number]["key"], "product">, number> = {
  ordered: 60, cost_per_unit: 64, total_cost: 78, prep: 48, sold_as: 88,
  canceled: 52, returned: 52, shipped_supplier: 56, received_velocity: 56, at_prep: 48, at_warehouse: 62, lost_damaged_us: 60,
  shipped_fba: 48, received_amazon: 56, shipments: 68, action_items: 78,
};
const LEAD_WIDTH = 32, NOTE_WIDTH = 28;
/** The fixed widths plus Product's minimum (84 px: the ASIN in full) — below it the table scrolls inside its own box, never the page. */
export const PO_ASIN_TABLE_MIN_WIDTH = `${Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + LEAD_WIDTH + NOTE_WIDTH + 84}px`;
/** Product, Ordered, Sold As show two model columns each (PO_ASIN_DISPLAY_COLUMNS). */
const MERGED_TITLES = {
  product: "ASIN · Amazon SKU, then the title",
  ordered: "Ordered (ASIN units); below it, Individual Units Ordered = Ordered × Units/Pack",
  sold_as: "Sold As; below it, Units/Pack",
} as const;
/** Header tooltips (Maria 2026-11-02): the two Velocity quantities explain each other. */
const COL_TITLES: Partial<Record<(typeof PO_ASIN_DISPLAY_COLUMNS)[number]["key"], string>> = { ...MERGED_TITLES, received_velocity: VELOCITY_QTY_TITLE, at_prep: VELOCITY_QTY_TITLE };

function Money({ v }: { v: string | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const n = parseFloat(v);
  const text = `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <span className={`font-mono ${n === 0 ? "text-muted-foreground/50" : ""}`}>{text}</span>;
}
/** A quantity cell: NULL → muted em-dash; 0 muted; fractional 2 dp. */
export function QtyCell({ v }: { v: string | number | null | undefined }) {
  const t = fmtQty(v);
  if (t === "—") return <span className="text-muted-foreground/50">—</span>;
  return <span className={t === "0" ? "text-muted-foreground/50" : ""}>{t}</span>;
}

async function patchJson(url: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ── Action Items (row-level Status, patch row-level-status §2.1) ─────────────
// Sentence case (Maria 2026-10-29) — the server stores these exact labels (po_line_action_items, migration 074).
export const ACTION_ITEM_OPTIONS = ["Need to return", "Missing / damaged from supplier", "Confirm refund / replacement", "ATTN: Velocity", "See comments", "SHIP", "Received - FBM",
  // Capture PO patch (2026-10-31): set by the system (confirmation-email reconcile, subscriptions), cleared by hand.
  "Confirm order details", "Subscription renews", "Review renewal PO", "Subscription may be active"];
// §7: tinted chips only. SHIP indigo; Received - FBM green; Need to return orange; the attention items amber.
export const EXTRA_UNITS_SHIPPED = "Extra units shipped";
export const PACK_SIZE_MISMATCH = "Pack size mismatch";
export function actionChipClass(item: string): string {
  const t = item.toLowerCase();
  // Red so it stands out (Maria 2026-10-29).
  if (item === EXTRA_UNITS_SHIPPED) return "bg-red-500/15 text-red-600 dark:text-red-400 font-medium";
  if (t === "ship") return "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
  if (t === "received - fbm") return "bg-green-500/10 text-green-700 dark:text-green-400";
  if (t === "need to return") return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
  if (t === "subscription renews") return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}
export const chipBase = "inline-block rounded-sm px-1.5 py-0.5 text-[11px] whitespace-nowrap";
/** Shown (never editable): the auto-managed "Review Velocity" (SPEC §26) and the pack-size items (derived from the ASIN row) after the manual items. */
export const DISPLAY_ACTION_ITEMS = [...ACTION_ITEM_OPTIONS, EXTRA_UNITS_SHIPPED, "Review Velocity", "Pack size missing", "Pack size mismatch", "Receiving mismatch",
  // One-off (2026-11-05, server/tracking-replacement-pair.ts): derived, resolves when the tracking is added.
  "Tracking also goes to 200015557295492 (1 replacement single)",
  // A PO with no document from the day after its order date (2026-11-05); the hover names the reason.
  "No invoice saved"];
const ordered = (items: readonly string[] | undefined) => DISPLAY_ACTION_ITEMS.filter((o) => (items ?? []).includes(o));

/** Read-only chips (the POs-page column: union over all lines). */
/** `reasons`: the open "Review Velocity" reasons (SPEC §26) — shown on that chip's hover. `titles`: hover text per item (Extra units shipped). */
/** Per item: how many of the PO's lines carry it (PO table v2 §4 `action_item_lines`). */
export interface ActionItemLines { lines: number; of: number; asins: string[]; reasons: string[] }
/** An open supplier defect as the list rows carry it (server/po-defects.ts briefOf, SPEC §22 "Supplier defects"). */
export interface OpenDefectBrief { id: number; po_line_item_id: string; asin: string | null; line_no: number; kind: string; qty: number; amount: number | null; owed: number | null; note: string | null }
/** The "Missing / damaged from supplier" chip's qty and $ owed ("1 · $5.97") and its hover — per defect, ASIN line and note. */
export function defectChipParts(defects: readonly OpenDefectBrief[] | undefined): { suffix: string; title: string } | null {
  if (!defects?.length) return null;
  const qty = defects.reduce((t, d) => t + Number(d.qty), 0);
  const owed = defects.filter((d) => d.owed != null);
  const suffix = `${Number(qty.toFixed(2))}${owed.length ? ` · $${owed.reduce((t, d) => t + (d.owed ?? 0), 0).toFixed(2)}` : ""}`;
  const each = defects.map((d) => `${d.asin ?? "?"} line ${d.line_no}: ${defectSummary([d])}${d.note ? ` — ${d.note}` : ""}`);
  return { suffix, title: `${DEFECT_ACTION_ITEM}: ${defectSummary(defects)}\n${each.join("\n")}` };
}
/** Hover for a PO-row chip: which lines carry it, and the auto reasons. */
export function lineDetailTitle(item: string, d: ActionItemLines | undefined): string | undefined {
  if (!d) return undefined;
  const where = d.lines === d.of ? `all ${d.of} line${d.of === 1 ? "" : "s"}` : `${d.lines} of ${d.of} lines`;
  return `${item}: ${where} — ${d.asins.join(", ")}${d.reasons.length ? ` · ${d.reasons.join(" · ")}` : ""}`;
}
/** At most this many chips show; the rest collapse into "+N" (PO table v2 §5). */
export const MAX_CHIPS = 2;
/**
 * `reasons`: the open "Review Velocity" reasons (SPEC §26) — shown on that chip's hover. `titles`: hover text per item (Extra units shipped).
 * `lines`: per-item line counts — a "·N" badge when fewer than all lines carry it, the lines on hover.
 */
export function ActionItemChips({ items, testId, reasons, titles, lines, defects }: { items: readonly string[] | undefined; testId?: string; reasons?: readonly string[] | null; titles?: Readonly<Record<string, string>>; lines?: Readonly<Record<string, ActionItemLines>>; defects?: readonly OpenDefectBrief[] }) {
  const list = ordered(items);
  const defect = defectChipParts(defects);
  const shown = list.length > MAX_CHIPS ? list.slice(0, MAX_CHIPS) : list;
  const rest = list.slice(shown.length);
  return (
    <span className="flex flex-wrap items-start gap-0.5" data-testid={testId}>
      {list.length === 0 ? <span className="text-muted-foreground/40 text-[11px]">—</span> : shown.map((it) => {
        const d = lines?.[it];
        return (
          // An open defect's qty and $ owed stay visible; only the label truncates.
          it === DEFECT_ACTION_ITEM && defect ? (
            <span key={it} className={`${chipBase} ${actionChipClass(it)} inline-flex max-w-full`} title={defect.title}>
              <span className="truncate">{it}</span><span className="ml-1 shrink-0 font-medium" data-testid="chip-defect-owed">{defect.suffix}</span>
            </span>
          ) :
          <span key={it} className={`${chipBase} ${actionChipClass(it)} max-w-full truncate`} title={titles?.[it] ?? lineDetailTitle(it, d) ?? (it === "Review Velocity" && reasons?.length ? reasons.join(" · ") : it)}>
            {it}{d && d.lines < d.of ? <span className="ml-1 opacity-70" data-testid={`chip-count-${it}`}>·{d.lines}</span> : null}
          </span>
        );
      })}
      {rest.length > 0 && <span className={`${chipBase} bg-muted text-muted-foreground`} title={rest.join(" · ")} data-testid="chip-more">+{rest.length}</span>}
    </span>
  );
}

/**
 * Chips + multi-select editor. `url` is the PO route (every line), the ASIN
 * route (every line of the ASIN) or the product-line route. `lineCount` > 1 →
 * each change asks "Apply to all N lines" before it is saved (PO table v2 §5).
 */
export function ActionItemsEditor({ items, url, onSaved, testId, titles, lines, lineCount = 1, reasons, defects }: {
  items: readonly string[] | undefined; url: string; onSaved?: () => void; testId: string; titles?: Readonly<Record<string, string>>;
  lines?: Readonly<Record<string, ActionItemLines>>; lineCount?: number; reasons?: readonly string[] | null; defects?: readonly OpenDefectBrief[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(items ?? []));
  const [pending, setPending] = useState<{ next: Set<string>; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: Set<string>) => {
    setDraft(next); setErr(null); setPending(null);
    try { await patchJson(url, "PATCH", { action_items: Array.from(next) }); onSaved?.(); } catch (e: any) { setErr(e.message); }
  };
  const toggle = (opt: string) => {
    const next = new Set(draft); const adding = !next.has(opt);
    if (adding) next.add(opt); else next.delete(opt);
    if (lineCount > 1) setPending({ next, label: `${adding ? "Add" : "Remove"} "${opt}" ${adding ? "to" : "from"} all ${lineCount} lines?` });
    else void save(next);
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); setPending(null); if (v) setDraft(new Set(items ?? [])); }}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="min-h-[1.25rem] min-w-[3rem] max-w-full text-left" data-testid={testId} title="Edit action items">
          <ActionItemChips items={items} titles={titles} lines={lines} reasons={reasons} defects={defects} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 space-y-1" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1">Action items</div>
        {ACTION_ITEM_OPTIONS.map((opt) => (
          <label key={opt} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
            <input type="checkbox" checked={pending ? pending.next.has(opt) : draft.has(opt)} disabled={pending != null} onChange={() => toggle(opt)} className="h-3 w-3 accent-blue-500" />
            <span className={`${chipBase} ${actionChipClass(opt)}`}>{opt}</span>
          </label>
        ))}
        {pending && (
          <div className="rounded border border-border bg-muted/50 p-2 text-xs space-y-1" data-testid={`${testId}-confirm`}>
            <div>{pending.label}</div>
            <div className="flex gap-1">
              <button type="button" onClick={() => void save(pending.next)} className="rounded bg-primary px-2 py-0.5 text-primary-foreground" data-testid={`${testId}-confirm-apply`}>Apply to all {lineCount} lines</button>
              <button type="button" onClick={() => setPending(null)} className="rounded px-2 py-0.5 hover:bg-muted">Cancel</button>
            </div>
          </div>
        )}
        {err && <div className="px-2 text-xs text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** Hover for "Extra units shipped": shipped vs ordered, then the note. */
export function extraUnitsTitle(a: Pick<PoAsinRowData, "qty" | "qty_shipped_fba" | "extra_units_note">): string {
  return `Shipped FBA ${fmtQty(a.qty_shipped_fba ?? 0)} of ${fmtQty(a.qty)} ordered${a.extra_units_note ? ` — ${a.extra_units_note}` : ""}`;
}
const extraTitles = (a: PoAsinRowData): Record<string, string> => ({ [EXTRA_UNITS_SHIPPED]: extraUnitsTitle(a), ...(a.pack_mismatch_note ? { [PACK_SIZE_MISMATCH]: a.pack_mismatch_note } : {}) });
/** A PO's hover titles plus "Pack size mismatch" from its rows' yield notes (each row's lines, one per row). */
export function poActionTitles(titles: Readonly<Record<string, string>> | undefined, asins: readonly { pack_mismatch_note?: string }[] | undefined): Record<string, string> {
  const notes = (asins ?? []).map((a) => a.pack_mismatch_note).filter(Boolean);
  return notes.length ? { ...titles, [PACK_SIZE_MISMATCH]: notes.join("\n") } : { ...titles };
}
const lineTitles = (l: PoAsinLine): Record<string, string> | undefined => l.pack_mismatch_note ? { [PACK_SIZE_MISMATCH]: l.pack_mismatch_note } : undefined;

/** Clear "Extra units shipped" by hand — the note is required (stored on the row, logged in History). */
function ClearExtraUnits({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await patchJson(`/api/pos/asin-rows/${a.id}/extra-units/clear`, "POST", { note }); setOpen(false); setNote(""); onChanged?.(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="mt-0.5 block text-[10px] text-muted-foreground hover:text-foreground" data-testid={`button-clear-extra-units-${a.asin}`}>clear…</button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2 space-y-1 text-xs" align="end" onClick={(e) => e.stopPropagation()}>
        <div>{extraUnitsTitle(a)}</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the extra units are OK (required)" rows={3}
          className="w-full rounded border border-input bg-background p-1 text-xs" data-testid={`input-clear-extra-units-${a.asin}`} />
        <button type="button" disabled={!note.trim()} onClick={() => void save()} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid={`button-confirm-clear-extra-units-${a.asin}`}>Clear with note</button>
        {err && <div className="text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** "Mark canceled" (§2.2): every line of the ASIN gets qty_canceled = qty_ordered — then one DUE refund row per newly canceled line is proposed (Dashboard patch C1; Skip allowed). */
function MarkCanceled({ a, onChanged, po }: { a: PoAsinRowData; onChanged?: () => void; po?: PoHeaderMoney }) {
  const [err, setErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CanceledLine[]>([]);
  // §5.1: no cancel while this ASIN row has units shipped to FBA.
  const blocked = shipmentBlockText(a.shipments ?? []);
  if (blocked) return <span className="ml-1 text-[10px] text-muted-foreground/40 cursor-not-allowed" title={blocked} data-testid={`button-cancel-asin-${a.asin}-blocked`}>cancel</span>;
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation(); setErr(null);
    if (!window.confirm(`Mark ${a.asin} canceled? Every product line of this ASIN gets Canceled = Ordered.`)) return;
    try {
      await patchJson(`/api/pos/asin-rows/${a.id}/cancel`, "POST");
      // The lines as they were before the cancel: the newly canceled qty of each.
      setProposal((a.lines ?? []).map((l) => ({ lineId: l.id, productName: l.product_name, qty: (Number(l.qty_ordered) || 0) - (Number(l.qty_canceled) || 0), price: l.price })).filter((l) => l.qty > 0));
      onChanged?.();
    } catch (er: any) { setErr(er.message); }
  };
  return (
    <>
      <button onClick={go} className="ml-1 text-[10px] text-muted-foreground hover:text-destructive" title={err ?? "Mark this ASIN canceled"} data-testid={`button-cancel-asin-${a.asin}`}>cancel</button>
      <RefundProposalDialog po={po ?? { id: a.po_id }} lines={proposal} onClose={() => setProposal([])} onSaved={() => onChanged?.()} />
    </>
  );
}

/**
 * A hand-entered quantity cell (At CQG Warehouse, Lost/damaged by us,
 * Shipped by Supplier): click to edit, Enter/blur saves, Escape cancels,
 * empty = not tracked (NULL). The server re-runs the auto-close rule.
 */
function EditableQty({ rowId, col, v, onChanged }: { rowId: string; col: "qty_at_warehouse" | "qty_lost_damaged_us" | "qty_shipped_supplier"; v: string | null; onChanged?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const start = () => { setDraft(v == null ? "" : fmtQty(v)); setErr(null); setEditing(true); };
  const save = async () => {
    setEditing(false);
    const next = draft.trim() === "" ? null : draft.trim();
    if ((next ?? "") === (v == null ? "" : fmtQty(v))) return;
    try { await patchJson(`/api/pos/asin-rows/${rowId}/quantities`, "PATCH", { [col]: next }); onChanged?.(); }
    catch (e: any) { setErr(e.message); }
  };
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        onClick={(e) => e.stopPropagation()}
        className="h-6 w-full max-w-16 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-${col}-${rowId}`} />
    );
  }
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); start(); }} className="w-full text-right hover:underline decoration-dotted" title={err ?? "Click to edit"} data-testid={`button-edit-${col}-${rowId}`}>
      <QtyCell v={v} />{err && <span className="ml-1 text-destructive">!</span>}
    </button>
  );
}

/**
 * Shipment IDs chip (patch shipment-reconciliation §5.1): the FBA shipment
 * ids per shipment row, grouped by Velocity ship date. A Velocity row whose
 * SC match is not `matched` shows its Velocity date and a warning glyph
 * instead of ids. Partial receipts read "received 7 of 10".
 */
function shipmentLabel(s: PoAsinShipment): string {
  const ids = s.fba_shipment_ids ?? [];
  if (ids.length === 0) return s.source === "manual" ? "manual" : `Velocity ${s.shipped_at ?? "?"}`;
  return ids.length === 1 ? ids[0] : `${ids[0].slice(0, 10)}… (${ids.length})`;
}
function ShipmentChips({ rowId, asin, shipments, editable, onChanged }: { rowId: string; asin: string; shipments: PoAsinShipment[]; editable?: boolean; onChanged?: () => void }) {
  const [fba, setFba] = useState("");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const total = shipments.reduce((t, s) => t + (parseFloat(s.qty_shipped) || 0), 0);
  const add = async () => {
    setErr(null);
    try { await patchJson(`/api/pos/asin-rows/${rowId}/shipments`, "POST", { fba_shipment_ids: fba.trim(), qty_shipped: qty.trim() }); setFba(""); setQty(""); onChanged?.(); }
    catch (e: any) { setErr(e.message); }
  };
  const remove = async (id: string) => {
    setErr(null);
    try { await patchJson(`/api/pos/shipments/${id}`, "DELETE"); onChanged?.(); } catch (e: any) { setErr(e.message); }
  };
  if (shipments.length === 0 && !editable) return <span className="text-muted-foreground/50">—</span>;
  const unmatched = shipments.some((s) => s.source === "velocity" && s.sc_match !== "matched");
  // "+ add" (2026-11-05): the column is a narrow fixed one; the chip truncates with its full text on hover.
  const chipText = shipments.length === 0 ? "+ add"
    : shipments.length === 1 ? `${shipmentLabel(shipments[0])} · ${fmtQty(total)}`
    : `${shipments.length} shipments · ${fmtQty(total)}`;
  // Group by Velocity ship date (D1), newest first.
  const groups = new Map<string, PoAsinShipment[]>();
  for (const s of [...shipments].sort((a, b) => String(b.shipped_at ?? "").localeCompare(String(a.shipped_at ?? "")))) { const k = s.shipped_at ?? "no date"; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70" data-testid="po-shipments-chip"
          title={shipments.length === 0 ? "Add a shipment ID" : chipText}>
          {unmatched && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" data-testid="po-shipments-unmatched-glyph" />}
          <span className="truncate">{chipText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-2 text-xs space-y-2" align="start" onClick={(e) => e.stopPropagation()}>
        {Array.from(groups.entries()).map(([date, rows]) => (
          <div key={date} className="space-y-1">
            <div className="text-[11px] text-muted-foreground">{date}</div>
            {rows.map((s) => {
              const shipped = parseFloat(s.qty_shipped) || 0;
              const received = s.qty_received == null ? null : parseFloat(s.qty_received) || 0;
              const bad = s.source === "velocity" && s.sc_match !== "matched";
              return (
                <div key={s.id} className="flex items-start justify-between gap-2" data-testid={`po-shipment-${s.id}`}>
                  <div className="min-w-0">
                    {bad ? (
                      <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-3 w-3" />Velocity {s.shipped_at ?? "?"} · SC {s.sc_match}</span>
                    ) : (s.fba_shipment_ids ?? []).length === 0 ? (
                      <span className="text-muted-foreground">{s.source === "manual" ? "manual, no FBA id" : "no FBA id"}</span>
                    ) : (
                      <span className="font-mono break-all">{s.fba_shipment_ids.join(", ")}</span>
                    )}
                    <div className="text-muted-foreground" title={received == null ? "not yet matched to Seller Central" : `received ${fmtQty(received)} of ${fmtQty(shipped)}`}>
                      {fmtQty(shipped)} shipped{received == null ? "" : ` · received ${fmtQty(received)} of ${fmtQty(shipped)}`} · {s.source}{s.assigned_by === "manual" ? " · assigned by hand" : ""}
                    </div>
                    {editable && <ReassignShipment shipment={s} asin={asin} currentRowId={rowId} onDone={() => onChanged?.()} />}
                  </div>
                  {editable && s.source === "manual" && <button onClick={() => remove(s.id)} className="text-muted-foreground hover:text-destructive" title="Remove" data-testid={`button-remove-shipment-${s.id}`}><X className="h-3 w-3" /></button>}
                </div>
              );
            })}
          </div>
        ))}
        {editable && (
          <div className="flex items-center gap-1 pt-1 border-t border-border/50">
            <input value={fba} onChange={(e) => setFba(e.target.value)} placeholder="FBA ids, comma-separated" className="h-6 flex-1 rounded border border-input bg-background px-1 font-mono text-xs" data-testid={`input-shipment-fba-${rowId}`} />
            <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className="h-6 w-14 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-shipment-qty-${rowId}`} />
            <button onClick={add} className="text-muted-foreground hover:text-foreground" title="Add shipment (manual)" data-testid={`button-add-shipment-${rowId}`}><Plus className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {err && <div className="text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

export function PoAsinColGroup() {
  return (
    <colgroup>
      <col style={{ width: LEAD_WIDTH }} />
      {PO_ASIN_DISPLAY_COLUMNS.map((c) => <col key={c.key} style={c.key === "product" ? undefined : { width: COL_WIDTHS[c.key] }} />)}
      <col style={{ width: NOTE_WIDTH }} />
    </colgroup>
  );
}

export function PoAsinHeaderRow({ sub = false }: { sub?: boolean }) {
  // Header labels wrap to two lines inside their fixed column (never nowrap: the labels overlapped at every width).
  // Words never split (2026-11-05): each column is at least its longest label word at 10.5 px.
  const base = `px-1 py-2 text-[10.5px] font-medium leading-tight align-bottom whitespace-normal ${sub ? "text-muted-foreground" : ""}`;
  return (
    <tr className={sub ? "bg-muted/40" : "table-header-stone"} data-testid="po-asin-header">
      <th className={base}></th>
      {PO_ASIN_DISPLAY_COLUMNS.map((c) => (
        <th key={c.key} className={`${base} ${c.align === "right" ? "text-right" : "text-left"}`} title={COL_TITLES[c.key]}>{c.label}</th>
      ))}
      <th className={base}></th>
    </tr>
  );
}

/**
 * Sold as + units / pack on the ASINs tab (2026-11-06). A pack not known shows "— choose —" in amber (never a real
 * option), or the title's pack as an unconfirmed amber suggestion; individual saves at once (×1), multi-pack opens a
 * units field and saves both together; the server keeps the lines' yield and logs History.
 */
function PackEdit({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void }) {
  const unknown = a.sold_as == null;
  const sug = unknown ? titlePackSuggestion(a.asin_name) : null;
  const [draft, setDraft] = useState<{ sold_as: string; units: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();
  const save = async (sold_as: string, units?: number) => {
    setErr(null);
    try {
      const r = await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", sold_as === "individual" ? { sold_as, units_per_pack: 1 } : units != null ? { sold_as, units_per_pack: units } : { sold_as });
      if (r?.asinPackSet) toast({ title: "Pack size set in AF", description: asinPackSetNote(r.asinPackSet) });
      setDraft(null); onChanged?.();
    } catch (e: any) { setErr(e.message); }
  };
  const choose = (v: string) => {
    if (v === "individual" || v === "bundle") return void save(v);
    if (v === "multi-pack") setDraft({ sold_as: v, units: a.sold_as === "multi-pack" && a.units_per_pack ? String(a.units_per_pack) : sug?.sold_as === "multi-pack" ? String(sug.units_per_pack) : "" });
  };
  const shown = draft?.sold_as ?? a.sold_as ?? sug?.sold_as ?? "";
  const amber = unknown && !draft;
  return (
    <div className="space-y-0.5" data-testid={`pack-${a.id}`} data-pack-missing={unknown ? (sug ? "suggested" : "yes") : undefined}>
      <select value={shown} onClick={(e) => e.stopPropagation()} onChange={(e) => choose(e.target.value)}
        className={`h-6 w-full min-w-0 rounded border bg-background px-0.5 text-[11px] ${amber ? "border-amber-500 text-amber-700 dark:text-amber-400" : "border-input"}`} data-testid={`select-sold_as-${a.id}`} title={err ?? undefined}>
        {unknown && !sug && <option value="">— choose —</option>}
        {["individual", "multi-pack", "bundle"].map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {draft ? (
        <div className="flex items-center gap-0.5 text-[11px]">
          <span>×</span>
          <input autoFocus value={draft.units} inputMode="numeric" onChange={(e) => setDraft({ ...draft, units: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void save(draft.sold_as, Number(draft.units)); if (e.key === "Escape") setDraft(null); }}
            className="h-5 w-10 rounded border border-input bg-background px-1 text-right" data-testid={`input-units_per_pack-${a.id}`} />
          <button type="button" className="text-primary hover:underline" onClick={() => void save(draft.sold_as, Number(draft.units))} data-testid={`button-pack-save-${a.id}`}>save</button>
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setDraft(null); setErr(null); }}>cancel</button>
        </div>
      ) : unknown ? (
        <div className="text-[11px] text-amber-700 dark:text-amber-400" data-testid={`pack-missing-${a.id}`}>
          {sug ? <>title says {sug.text} · <button type="button" className="underline" onClick={() => void save(sug.sold_as, sug.sold_as === "individual" ? undefined : sug.units_per_pack)} data-testid={`button-pack-confirm-${a.id}`}>confirm</button></> : "pack size missing"}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground" title="Units/Pack"><span>×</span>{a.sold_as === "multi-pack" ? <InlineEdit value={a.units_per_pack} onSave={async (v) => { await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", { units_per_pack: v }); onChanged?.(); }} width="w-12" testId={`units_per_pack-${a.id}`}>{a.units_per_pack}</InlineEdit> : a.units_per_pack}</div>
      )}
      {err && <div className="text-[11px] text-destructive" data-testid={`pack-error-${a.id}`}>{err}</div>}
    </div>
  );
}

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;

/** One ASIN row (plus its bundle component lines when expanded). `editable` enables the hand-entered quantities and manual shipments. */
export function PoAsinRow({ a, indent = false, editable = false, onChanged, po }: { a: PoAsinRowData; indent?: boolean; editable?: boolean; onChanged?: () => void; /** The PO header money for the due-refund proposal after "cancel". */ po?: PoHeaderMoney }) {
  const [open, setOpen] = useState(false);
  const lines = a.lines ?? [];
  const multi = lines.length >= 2;
  const pad = indent ? "pl-6" : "";
  // AF-owned editing (po-af-owned §3): logged server-side, auto-close re-runs.
  const saveAsin = (field: string) => async (v: string | null) => { await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", { [field]: v }); onChanged?.(); };
  return (
    <>
      <tr className={`table-zebra-stone ${indent ? "text-[13px]" : ""}`} style={hairline} data-testid={`row-po-asin-${a.asin}`}>
        <td className={`px-1 py-1.5 ${pad}`}>
          <span className="inline-flex items-center gap-1">
            {multi && (
              <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground" data-testid={`button-expand-${a.asin}`}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {a.thumbnail && <img src={a.thumbnail} alt="" className="h-6 w-6 object-contain rounded-sm" />}
          </span>
        </td>
        {/* Product: ASIN · Amazon SKU over the title (2026-11-05); each truncates with its full text on hover. */}
        <td className="px-1.5 py-1.5 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link href={`/asins?q=${a.asin}`} className="shrink-0 font-mono text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{a.asin}</Link>
            {a.sku ? <span className="truncate font-mono text-[11px] text-muted-foreground" title={a.sku}>{a.sku}</span> : (
              <Tooltip>
                <TooltipTrigger asChild><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /></TooltipTrigger>
                <TooltipContent side="top"><p className="text-xs">No SKU — create offer first</p></TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="truncate text-xs" title={a.asin_name ?? ""}>{a.asin_name ?? <span className="text-muted-foreground/50">—</span>}</div>
        </td>
        <td className="px-1.5 py-1.5 text-right">
          <div><QtyCell v={a.qty} /></div>
          <div className="whitespace-nowrap text-[11px] text-muted-foreground" title="Individual Units Ordered = Ordered × Units/Pack">{a.units_per_pack == null ? <span data-testid={`indiv-unknown-${a.id}`}>?</span> : <QtyCell v={individualUnits(Number(a.qty), a.units_per_pack)} />} indiv.</div>
        </td>
        <td className="px-1.5 py-1.5 text-right text-xs">{editable ? <InlineEdit money value={a.cost_per_unit} onSave={saveAsin("cost_per_unit")} align="right" width="w-12" testId={`cost_per_unit-${a.id}`}><Money v={a.cost_per_unit} /></InlineEdit> : <Money v={a.cost_per_unit} />}</td>
        <td className="px-1.5 py-1.5 text-right text-xs"><Money v={a.total_cost} /></td>
        <td className="px-1.5 py-1.5 text-right text-xs">{editable ? <InlineEdit money value={a.prep_cost} onSave={saveAsin("prep_cost")} align="right" width="w-10" testId={`prep_cost-${a.id}`}><Money v={a.prep_cost} /></InlineEdit> : <Money v={a.prep_cost} />}</td>
        <td className="px-1.5 py-1.5">
          {editable ? <PackEdit a={a} onChanged={onChanged} /> : <>
            <div className={a.sold_as == null ? "text-amber-700 dark:text-amber-400" : ""}>{a.sold_as ?? "—"}</div>
            <div className="text-[11px] text-muted-foreground" title="Units/Pack">×{a.units_per_pack ?? "?"}</div>
          </>}
        </td>
        <td className="px-1.5 py-1.5 text-right"><div><QtyCell v={a.qty_canceled_asin} /></div>{editable && (a.lines ?? []).length > 0 && <MarkCanceled a={a} onChanged={onChanged} po={po} />}</td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_returned_asin} /></td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_shipped_supplier" v={a.qty_shipped_supplier} onChanged={onChanged} /> : <QtyCell v={a.qty_shipped_supplier} />}</td>
        <td className="px-1.5 py-1.5 text-right" title={VELOCITY_QTY_TITLE}><QtyCell v={a.received_velocity} /></td>
        <td className="px-1.5 py-1.5 text-right" title={VELOCITY_QTY_TITLE}><QtyCell v={a.qty_at_prep} /></td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_at_warehouse" v={a.qty_at_warehouse} onChanged={onChanged} /> : <QtyCell v={a.qty_at_warehouse} />}</td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_lost_damaged_us" v={a.qty_lost_damaged_us} onChanged={onChanged} /> : <QtyCell v={a.qty_lost_damaged_us} />}</td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_shipped_fba} /></td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_received_amazon} /></td>
        <td className="px-1.5 py-1.5"><ShipmentChips rowId={a.id} asin={a.asin} shipments={a.shipments ?? []} editable={editable} onChanged={onChanged} /></td>
        <td className="px-1.5 py-1.5">{editable && lines.length > 0
          ? <ActionItemsEditor items={a.action_items} titles={extraTitles(a)} url={`/api/pos/asin-rows/${a.id}/action-items`} onSaved={onChanged} testId={`button-action-items-asin-${a.asin}`} lineCount={lines.length} defects={a.defects_open} />
          : <ActionItemChips items={a.action_items} titles={extraTitles(a)} defects={a.defects_open} />}
          {editable && (a.action_items ?? []).includes(EXTRA_UNITS_SHIPPED) && <ClearExtraUnits a={a} onChanged={onChanged} />}</td>
        {/* ASIN-row note, inline (2026-11-04); read-only tables show the icon with the note on hover. */}
        <td className={editable ? "p-0" : "px-2 py-1.5"}>{editable
          ? <InlineNoteCell value={a.notes} label="ASIN note" className="px-2 py-1.5" testId={`asin-${a.id}`} onSave={saveAsin("notes")} />
          : a.notes ? <span title={a.notes}><NoteIcon has /></span> : null}</td>
      </tr>
      {multi && open && lines.map((l) => (
        <tr key={l.id} style={hairline} data-testid={`row-component-${a.asin}-${l.position}`}>
          <td className="px-2 py-1" />
          <td className="px-1.5 py-1 pl-6 text-xs text-muted-foreground truncate" title={l.product_name ?? ""}>{l.product_name ?? "—"}</td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><QtyCell v={l.qty_ordered} /></td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><Money v={l.price} /></td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><Money v={l.adjusted_product_cost} /></td>
          {/* Product, Ordered, Cost/Unit, Total Cost above; Action Items after. */}
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground" colSpan={PO_ASIN_DISPLAY_COLUMNS.length - 4 - 1}>{l.qty_canceled != null && l.qty_canceled > 0 ? `canceled ${l.qty_canceled}` : ""}</td>
          <td className="px-1.5 py-1">{editable
            ? <ActionItemsEditor items={l.action_items} titles={lineTitles(l)} url={`/api/pos/lines/${l.id}/action-items`} onSaved={onChanged} testId={`button-action-items-line-${a.asin}-${l.position}`} defects={a.defects_open?.filter((d) => d.po_line_item_id === l.id)} />
            : <ActionItemChips items={l.action_items} titles={lineTitles(l)} defects={a.defects_open?.filter((d) => d.po_line_item_id === l.id)} />}</td>
          {/* Product-line note, inline (2026-11-04). */}
          <td className={editable ? "p-0" : "px-2 py-1"}>{editable
            ? <InlineNoteCell value={l.notes} label="line note" className="px-2 py-1" testId={`line-${l.id}`} onSave={async (v) => { await poApi(`/api/pos/lines/${l.id}`, "PATCH", { notes: v }); onChanged?.(); }} />
            : l.notes ? <span title={l.notes}><NoteIcon has /></span> : null}</td>
        </tr>
      ))}
    </>
  );
}

/** A complete ASINs table (the detail tab). */
export function PoAsinTable({ asins, testId = "po-asins-table", editable = false, onChanged, po }: { asins: PoAsinRowData[]; testId?: string; editable?: boolean; onChanged?: () => void; po?: PoHeaderMoney }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: PO_ASIN_TABLE_MIN_WIDTH }} data-testid={testId}>
        <PoAsinColGroup />
        <thead><PoAsinHeaderRow /></thead>
        <tbody>{asins.map((a) => <PoAsinRow key={a.id} a={a} editable={editable} onChanged={onChanged} po={po} />)}</tbody>
      </table>
    </div>
  );
}
