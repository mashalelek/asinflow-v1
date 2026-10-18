/**
 * ASINs table — the §4 column model, ONE component for both places it
 * renders: the PO detail ASINs tab and the POs page's nested "Expand by
 * ASIN" rows (patch docs/claude_spec-patch-po-expand-by-asin.md §3.2, §4).
 *
 * Fixed column widths (colgroup + table-fixed) so separate instances line
 * up: the POs page shows the header once, under the first expanded PO, and
 * every later expanded PO's rows align with it.
 */
import React, { useState } from "react";
import { Link } from "wouter";
import { StickyNote, ChevronRight, ChevronDown, AlertTriangle, Plus, X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtQty, individualUnits, PO_ASIN_COLUMNS } from "@/lib/po-qty";
import { InlineEdit, SelectEdit, poApi, ReassignShipment, shipmentBlockText } from "@/components/po-edit";

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
  supplier_sku: string | null;
  price: string | null;
  item_discount: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  qty_canceled: number | null;
  qty_returned: number | null;
  final_qty: number | null;
  asin_qty_per_product: string | null;
  adjusted_product_cost: string | null;
  notes: string | null;
  /** Row-level Status: this product's action items. */
  action_items?: string[];
}
export interface PoAsinRowData {
  id: string;
  po_id: string;
  asin: string;
  asin_name: string | null;
  sku: string | null;
  qty: number;                       // Ordered (ASIN qty)
  cost_per_unit: string | null;
  total_cost: string | null;
  prep_cost: string | null;
  sold_as: string;
  units_per_pack: number;
  notes: string | null;
  thumbnail: string | null;
  // derived from the lines (NULL = some line untracked)
  qty_canceled_asin: string | null;
  qty_returned_asin: string | null;
  // stored ASIN quantities (NULL = not tracked)
  qty_shipped_supplier: string | null;
  qty_at_prep: string | null;
  qty_at_warehouse: string | null;
  qty_lost_damaged_us: string | null;
  qty_shipped_fba: string | null;
  qty_received_amazon: string | null;
  shipments: PoAsinShipment[];
  /** Union of the product lines' action items (row-level Status 2026-10-17). */
  action_items?: string[];
  lines?: PoAsinLine[];
}

const COL_WIDTHS: Record<(typeof PO_ASIN_COLUMNS)[number]["key"], string> = {
  asin: "7rem", title: "18rem", sku: "11rem", ordered: "4.5rem", cost_per_unit: "5.5rem", total_cost: "6rem", prep: "4.5rem",
  sold_as: "6rem", units_per_pack: "5rem", individual_units: "7rem", canceled: "5rem", returned: "5rem", shipped_supplier: "6.5rem",
  at_prep: "6rem", at_warehouse: "6.5rem", lost_damaged_us: "6.5rem", shipped_fba: "5.5rem", received_amazon: "6.5rem", shipments: "11rem", action_items: "12rem",
};
const LEAD_WIDTH = "2.75rem";

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
export const ACTION_ITEM_OPTIONS = ["Need to Return", "Missing / Damaged from Supplier", "Confirm Refund / Replacement", "ATTN: Velocity", "See Comments", "SHIP", "Received - FBM"];
// §7: tinted chips only. SHIP indigo; Received - FBM green; Need to Return orange; the attention items amber.
export function actionChipClass(item: string): string {
  const t = item.toLowerCase();
  if (t === "ship") return "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
  if (t === "received - fbm") return "bg-green-500/10 text-green-700 dark:text-green-400";
  if (t === "need to return") return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}
export const chipBase = "inline-block rounded-sm px-1.5 py-0.5 text-[11px] whitespace-nowrap";
const ordered = (items: readonly string[] | undefined) => ACTION_ITEM_OPTIONS.filter((o) => (items ?? []).includes(o));

/** Read-only chips (the POs-page column: union over all lines). */
export function ActionItemChips({ items, testId }: { items: readonly string[] | undefined; testId?: string }) {
  const list = ordered(items);
  return (
    <span className="flex flex-col items-start gap-0.5" data-testid={testId}>
      {list.length === 0 ? <span className="text-muted-foreground/40 text-[11px]">—</span> : list.map((it) => <span key={it} className={`${chipBase} ${actionChipClass(it)}`}>{it}</span>)}
    </span>
  );
}

/** Chips + multi-select editor. `url` is the ASIN route (write-through to every line) or the product-line route. */
export function ActionItemsEditor({ items, url, onSaved, testId }: { items: readonly string[] | undefined; url: string; onSaved?: () => void; testId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(items ?? []));
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: Set<string>) => {
    setDraft(next); setErr(null);
    try { await patchJson(url, "PATCH", { action_items: Array.from(next) }); onSaved?.(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setDraft(new Set(items ?? [])); }}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="min-h-[1.25rem] min-w-[4rem] text-left" data-testid={testId} title="Edit action items">
          <ActionItemChips items={items} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 space-y-1" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1">Action items</div>
        {ACTION_ITEM_OPTIONS.map((opt) => (
          <label key={opt} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
            <input type="checkbox" checked={draft.has(opt)} onChange={() => { const next = new Set(draft); if (next.has(opt)) next.delete(opt); else next.add(opt); void save(next); }} className="h-3 w-3 accent-blue-500" />
            <span className={`${chipBase} ${actionChipClass(opt)}`}>{opt}</span>
          </label>
        ))}
        {err && <div className="px-2 text-xs text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** "Mark canceled" (§2.2): every line of the ASIN gets qty_canceled = qty_ordered. */
function MarkCanceled({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  // §5.1: no cancel while this ASIN row has units shipped to FBA.
  const blocked = shipmentBlockText(a.shipments ?? []);
  if (blocked) return <span className="ml-1 text-[10px] text-muted-foreground/40 cursor-not-allowed" title={blocked} data-testid={`button-cancel-asin-${a.asin}-blocked`}>cancel</span>;
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation(); setErr(null);
    if (!window.confirm(`Mark ${a.asin} canceled? Every product line of this ASIN gets Canceled = Ordered.`)) return;
    try { await patchJson(`/api/pos/asin-rows/${a.id}/cancel`, "POST"); onChanged?.(); } catch (er: any) { setErr(er.message); }
  };
  return <button onClick={go} className="ml-1 text-[10px] text-muted-foreground hover:text-destructive" title={err ?? "Mark this ASIN canceled"} data-testid={`button-cancel-asin-${a.asin}`}>cancel</button>;
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
        className="h-6 w-16 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-${col}-${rowId}`} />
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
  const chipText = shipments.length === 0 ? "+ shipment"
    : shipments.length === 1 ? `${shipmentLabel(shipments[0])} · ${fmtQty(total)}`
    : `${shipments.length} shipments · ${fmtQty(total)}`;
  // Group by Velocity ship date (D1), newest first.
  const groups = new Map<string, PoAsinShipment[]>();
  for (const s of [...shipments].sort((a, b) => String(b.shipped_at ?? "").localeCompare(String(a.shipped_at ?? "")))) { const k = s.shipped_at ?? "no date"; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70" data-testid="po-shipments-chip">
          {unmatched && <AlertTriangle className="h-3 w-3 text-amber-600" data-testid="po-shipments-unmatched-glyph" />}
          {chipText}
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
      {PO_ASIN_COLUMNS.map((c) => <col key={c.key} style={{ width: COL_WIDTHS[c.key] }} />)}
      <col style={{ width: "2rem" }} />
    </colgroup>
  );
}

export function PoAsinHeaderRow({ sub = false }: { sub?: boolean }) {
  const base = `px-3 py-2 text-xs font-medium whitespace-nowrap ${sub ? "text-muted-foreground" : ""}`;
  return (
    <tr className={sub ? "bg-muted/40" : "table-header-stone"} data-testid="po-asin-header">
      <th className={base}></th>
      {PO_ASIN_COLUMNS.map((c) => (
        <th key={c.key} className={`${base} ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
      ))}
      <th className={base}></th>
    </tr>
  );
}

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;

/** One ASIN row (plus its bundle component lines when expanded). `editable` enables the hand-entered quantities and manual shipments. */
export function PoAsinRow({ a, indent = false, editable = false, onChanged }: { a: PoAsinRowData; indent?: boolean; editable?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const lines = a.lines ?? [];
  const multi = lines.length >= 2;
  const pad = indent ? "pl-6" : "";
  // AF-owned editing (po-af-owned §3): logged server-side, auto-close re-runs.
  const saveAsin = (field: string) => async (v: string) => { await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", { [field]: v }); onChanged?.(); };
  return (
    <>
      <tr className={`table-zebra-stone ${indent ? "text-[13px]" : ""}`} style={hairline} data-testid={`row-po-asin-${a.asin}`}>
        <td className={`px-2 py-1.5 ${pad}`}>
          <span className="inline-flex items-center gap-1">
            {multi && (
              <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground" data-testid={`button-expand-${a.asin}`}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {a.thumbnail && <img src={a.thumbnail} alt="" className="h-7 w-7 object-contain rounded-sm" />}
          </span>
        </td>
        <td className="px-3 py-1.5">
          <Link href={`/asins?q=${a.asin}`} className="font-mono text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{a.asin}</Link>
        </td>
        <td className="px-3 py-1.5 truncate" title={a.asin_name ?? ""}>{a.asin_name ?? <span className="text-muted-foreground/50">—</span>}</td>
        <td className="px-3 py-1.5">
          {a.sku ? <span className="font-mono text-xs">{a.sku}</span> : (
            <Tooltip>
              <TooltipTrigger asChild><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">No SKU — create offer first</p></TooltipContent>
            </Tooltip>
          )}
        </td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty} /></td>
        <td className="px-3 py-1.5 text-right">{editable ? <InlineEdit money value={a.cost_per_unit} onSave={saveAsin("cost_per_unit")} align="right" width="w-20" testId={`cost_per_unit-${a.id}`}><Money v={a.cost_per_unit} /></InlineEdit> : <Money v={a.cost_per_unit} />}</td>
        <td className="px-3 py-1.5 text-right"><Money v={a.total_cost} /></td>
        <td className="px-3 py-1.5 text-right">{editable ? <InlineEdit money value={a.prep_cost} onSave={saveAsin("prep_cost")} align="right" width="w-16" testId={`prep_cost-${a.id}`}><Money v={a.prep_cost} /></InlineEdit> : <Money v={a.prep_cost} />}</td>
        <td className="px-3 py-1.5">{editable ? <SelectEdit value={a.sold_as} options={["individual", "multi-pack", "bundle"]} onSave={saveAsin("sold_as")} testId={`sold_as-${a.id}`} /> : a.sold_as}</td>
        <td className="px-3 py-1.5 text-right">{editable && a.sold_as !== "individual" ? <InlineEdit value={a.units_per_pack} onSave={saveAsin("units_per_pack")} align="right" width="w-14" testId={`units_per_pack-${a.id}`}>{a.units_per_pack}</InlineEdit> : a.units_per_pack}</td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={individualUnits(Number(a.qty), a.units_per_pack)} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_canceled_asin} />{editable && (a.lines ?? []).length > 0 && <MarkCanceled a={a} onChanged={onChanged} />}</td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_returned_asin} /></td>
        <td className="px-3 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_shipped_supplier" v={a.qty_shipped_supplier} onChanged={onChanged} /> : <QtyCell v={a.qty_shipped_supplier} />}</td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_at_prep} /></td>
        <td className="px-3 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_at_warehouse" v={a.qty_at_warehouse} onChanged={onChanged} /> : <QtyCell v={a.qty_at_warehouse} />}</td>
        <td className="px-3 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_lost_damaged_us" v={a.qty_lost_damaged_us} onChanged={onChanged} /> : <QtyCell v={a.qty_lost_damaged_us} />}</td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_shipped_fba} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_received_amazon} /></td>
        <td className="px-3 py-1.5"><ShipmentChips rowId={a.id} asin={a.asin} shipments={a.shipments ?? []} editable={editable} onChanged={onChanged} /></td>
        <td className="px-3 py-1.5">{editable && lines.length > 0
          ? <ActionItemsEditor items={a.action_items} url={`/api/pos/asin-rows/${a.id}/action-items`} onSaved={onChanged} testId={`button-action-items-asin-${a.asin}`} />
          : <ActionItemChips items={a.action_items} />}</td>
        <td className="px-2 py-1.5">{a.notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
      </tr>
      {multi && open && lines.map((l) => (
        <tr key={l.id} style={hairline} data-testid={`row-component-${a.asin}-${l.position}`}>
          <td className="px-2 py-1" />
          <td className="px-3 py-1 pl-8 text-xs text-muted-foreground" colSpan={2}>{l.product_name ?? "—"}</td>
          <td className="px-3 py-1 text-muted-foreground/50">—</td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><QtyCell v={l.qty_ordered} /></td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.price} /></td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.adjusted_product_cost} /></td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground" colSpan={PO_ASIN_COLUMNS.length - 6 - 1}>{l.qty_canceled != null && l.qty_canceled > 0 ? `canceled ${l.qty_canceled}` : ""}</td>
          <td className="px-3 py-1">{editable
            ? <ActionItemsEditor items={l.action_items} url={`/api/pos/lines/${l.id}/action-items`} onSaved={onChanged} testId={`button-action-items-line-${a.asin}-${l.position}`} />
            : <ActionItemChips items={l.action_items} />}</td>
          <td className="px-2 py-1" />
        </tr>
      ))}
    </>
  );
}

/** A complete ASINs table (the detail tab). */
export function PoAsinTable({ asins, testId = "po-asins-table", editable = false, onChanged }: { asins: PoAsinRowData[]; testId?: string; editable?: boolean; onChanged?: () => void }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: "140rem" }} data-testid={testId}>
        <PoAsinColGroup />
        <thead><PoAsinHeaderRow /></thead>
        <tbody>{asins.map((a) => <PoAsinRow key={a.id} a={a} editable={editable} onChanged={onChanged} />)}</tbody>
      </table>
    </div>
  );
}
