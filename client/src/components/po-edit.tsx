/**
 * AF-owned PO editing UI (patch docs/claude_spec-patch-po-af-owned.md §3).
 *
 * - InlineEdit: click a cell → input; Enter / blur saves, Escape cancels.
 * - (The header dialog is gone since 2026-11-04: Edit PO is the page
 *   /pos/:id/edit — client/src/pages/po-edit-page.tsx.)
 * - PoProductsTable: the Products tab, editable (name, SKU, price, the four
 *   quantities, yield, ASIN re-map, notes), add / remove product.
 * - PoHistory: the po_edit_log, newest first.
 * Every save hits the server, which logs the change and re-runs auto-close;
 * the caller reloads the PO afterwards.
 */
import React, { useEffect, useState } from "react";
import { effectiveYield, fracToNumber, lineRatio, lineUnitsExact, ratioForUnits } from "@shared/yield";
import { Plus, Trash2, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trueYield } from "@shared/po-form";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { fmtQty, productQtyFromAsin } from "@/lib/po-qty";
import type { PoAsinRowData, PoAsinLine } from "@/components/po-asin-rows";
import { calcMoney } from "@/components/money-calc-input";
import { RefundProposalDialog, type PoHeaderMoney, type CanceledLine } from "@/components/refund-due-dialog";

export const ORDER_ID_WARNING = "order # is how shipments are matched from Velocity; changing it re-matches on the next Sync Shipments";

export async function poApi(url: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/** Text shown in an input for a stored value: money / numbers without float noise. */
export function editText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  const s = String(v);
  return /^-?\d+\.\d+$/.test(s) ? String(Number(s)) : s;
}

export function InlineEdit({ value, children, onSave, align = "left", width = "w-24", testId, title = "Click to edit", money = false }: {
  value: unknown; children: React.ReactNode; onSave: (v: string) => Promise<void>; align?: "left" | "right"; width?: string; testId: string; title?: string;
  /** A cost / money cell: an arithmetic expression is calculated (shared/money-expr.ts) before saving. */
  money?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [expr, setExpr] = useState<string | null>(null);
  const start = (e: React.MouseEvent) => { e.stopPropagation(); setDraft(editText(value)); setErr(null); setEditing(true); };
  const save = async () => {
    let next = draft.trim();
    if (money) {
      const c = calcMoney(next);
      if (!c.ok) { setErr(`Can't calculate: ${c.error}`); return; } // stay in the field, keep the text
      if (c.expression) { setExpr(c.expression); next = c.text; }
    }
    setEditing(false);
    if (next === editText(value).trim()) return;
    try { await onSave(next); } catch (e: any) { setErr(e.message); }
  };
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }} onBlur={save} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
        title={err ?? (money ? "Amount or a calculation, e.g. 24.99*2/3+1.5" : undefined)} aria-invalid={err ? true : undefined}
        className={`h-6 ${width} rounded border bg-background px-1 text-xs ${err ? "border-destructive ring-1 ring-destructive" : "border-input"} ${align === "right" ? "text-right" : ""}`} data-testid={`input-${testId}`} />
    );
  }
  return (
    <button type="button" onClick={start} className={`w-full ${align === "right" ? "text-right" : "text-left"} hover:underline decoration-dotted`} title={err ?? (expr ? `= ${expr}` : title)} data-testid={`edit-${testId}`}>
      {children}{err && <span className="ml-1 text-destructive" title={err}>!</span>}
    </button>
  );
}

export function SelectEdit({ value, options, onSave, testId }: { value: string; options: readonly string[]; onSave: (v: string) => Promise<void>; testId: string }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center">
      <select value={value} onClick={(e) => e.stopPropagation()} onChange={async (e) => { setErr(null); try { await onSave(e.target.value); } catch (er: any) { setErr(er.message); } }}
        className="h-6 rounded border border-input bg-background px-1 text-xs" data-testid={`select-${testId}`} title={err ?? undefined}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {err && <span className="ml-1 text-destructive" title={err}>!</span>}
    </span>
  );
}

function Muted({ v }: { v: React.ReactNode }) { return <span className="text-muted-foreground/50">{v}</span>; }
function MoneyText({ v }: { v: string | null | undefined }) {
  if (v == null) return <Muted v="—" />;
  const n = parseFloat(v);
  return <span className={`font-mono ${n === 0 ? "text-muted-foreground/50" : ""}`}>${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}
function QtyText({ v }: { v: number | string | null | undefined }) { const t = fmtQty(v); return t === "—" ? <Muted v="—" /> : <span className={t === "0" ? "text-muted-foreground/50" : ""}>{t}</span>; }

type LineWithParent = PoAsinLine & { parent: PoAsinRowData };

export function PoProductsTable({ poId, asins, onChanged, po }: { poId: string; asins: PoAsinRowData[]; onChanged: () => void; /** The header money the due-refund proposal allocates with (Dashboard patch C1). */ po?: PoHeaderMoney }) {
  const { toast } = useToast();
  const lines: LineWithParent[] = asins.flatMap((a) => (a.lines ?? []).map((l) => ({ ...l, parent: a })));
  // Cancel qty (C1): raising a line's Canceled proposes a DUE refund row for the added qty; saving the cancel without one is allowed (Skip).
  const [proposal, setProposal] = useState<CanceledLine[]>([]);
  const patch = (l: LineWithParent, field: string) => async (v: string) => {
    await poApi(`/api/pos/lines/${l.id}`, "PATCH", { [field]: v });
    if (field === "qty_canceled") {
      const added = (Number(v) || 0) - (Number(l.qty_canceled) || 0);
      if (added > 0) setProposal([{ lineId: l.id, productName: l.product_name, qty: added, price: l.price }]);
    }
    onChanged();
  };
  const remove = async (l: LineWithParent) => {
    if (!window.confirm(`Remove "${l.product_name ?? "this product"}" from the PO?${(l.parent.lines ?? []).length === 1 ? ` It is the only product of ${l.parent.asin}, so that ASIN row goes too.` : ""}`)) return;
    try { await poApi(`/api/pos/lines/${l.id}`, "DELETE"); onChanged(); }
    catch (e: any) { toast({ title: "Not removed", description: e.message, variant: "destructive" }); }
  };
  const th = (right = false) => `px-3 py-2 text-xs font-medium whitespace-nowrap ${right ? "text-right" : "text-left"}`;
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  return (
    <div className="space-y-3">
      <RefundProposalDialog po={po ?? { id: poId }} lines={proposal} onClose={() => setProposal([])} onSaved={onChanged} />
      <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <table className="w-full border-collapse text-sm" data-testid="po-products-table">
          <thead>
            <tr className="table-header-stone">
              <th className={th()}>Product Name</th><th className={th()}>SKU / UPC</th><th className={th(true)}>Price</th><th className={th(true)}>Item Discount</th>
              <th className={th(true)}>Ordered</th><th className={th(true)}>Received</th><th className={th(true)}>Canceled</th><th className={th(true)}>Returned</th>
              <th className={th(true)} title="ASIN units attributed to this line: qty ordered × yield">ASIN units</th><th className={th(true)}>At Prep Center</th><th className={th(true)}>At CQG Warehouse</th><th className={th(true)}>Lost/damaged by us</th>
              <th className={th(true)}>Final</th><th className={th()}>ASIN</th><th className={th()}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const sole = (l.parent.lines ?? []).length === 1;
              return (
                <tr key={l.id} className="table-zebra-stone" style={hairline} data-testid={`row-product-${l.id}`}>
                  <td className="px-3 py-1.5 max-w-[320px]"><InlineEdit value={l.product_name} onSave={patch(l, "product_name")} width="w-64" testId={`product_name-${l.id}`}><span className="truncate block" title={l.product_name ?? ""}>{l.product_name ?? <Muted v="—" />}</span></InlineEdit></td>
                  <td className="px-3 py-1.5 font-mono text-xs"><InlineEdit value={l.supplier_sku} onSave={patch(l, "supplier_sku")} width="w-32" testId={`supplier_sku-${l.id}`}>{l.supplier_sku ?? <Muted v="—" />}</InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><InlineEdit money value={l.price} onSave={patch(l, "price")} align="right" width="w-20" testId={`price-${l.id}`}><MoneyText v={l.price} /></InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><MoneyText v={l.item_discount} /></td>
                  <td className="px-3 py-1.5 text-right"><InlineEdit value={l.qty_ordered} onSave={patch(l, "qty_ordered")} align="right" width="w-16" testId={`qty_ordered-${l.id}`}><QtyText v={l.qty_ordered} /></InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><InlineEdit value={l.qty_received} onSave={patch(l, "qty_received")} align="right" width="w-16" testId={`qty_received-${l.id}`}><QtyText v={l.qty_received} /></InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><InlineEdit value={l.qty_canceled} onSave={patch(l, "qty_canceled")} align="right" width="w-16" testId={`qty_canceled-${l.id}`}><QtyText v={l.qty_canceled} /></InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><InlineEdit value={l.qty_returned} onSave={patch(l, "qty_returned")} align="right" width="w-16" testId={`qty_returned-${l.id}`}><QtyText v={l.qty_returned} /></InlineEdit></td>
                  {/* Round 2 (Maria 2026-11-01): "Yield 0.17" was the col-T ratio — the column is the ASIN units this line yields (12 × 1/6 = 2); typing units sets the yield (units ÷ qty). */}
                  <td className="px-3 py-1.5 text-right"><InlineEdit value={lineAsinUnits(l)} onSave={async (v) => { const q = Number(l.qty_ordered) || 0; if (!(q > 0) || !(Number(v) > 0)) return; const r = ratioForUnits(Number(v), q, l.parent.sold_as === "individual" ? 1 : Number(l.parent.units_per_pack) || 1); if (!r) return; await poApi(`/api/pos/lines/${l.id}`, "PATCH", { retailer_units_per_product: String(r.retailer), asin_units_per_pack: String(r.asinUnits) }); onChanged(); }} align="right" width="w-16" testId={`asin-units-${l.id}`}><QtyText v={lineAsinUnits(l)} /></InlineEdit></td>
                  <td className="px-3 py-1.5 text-right"><QtyText v={sole ? productQtyFromAsin(l.parent.qty_at_prep, lineYield(l)) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><QtyText v={sole ? productQtyFromAsin(l.parent.qty_at_warehouse, lineYield(l)) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><QtyText v={sole ? productQtyFromAsin(l.parent.qty_lost_damaged_us, lineYield(l)) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><QtyText v={l.final_qty} /></td>
                  <td className="px-3 py-1.5">
                    <InlineEdit value={l.parent.asin} onSave={patch(l, "asin")} width="w-28" testId={`asin-${l.id}`} title="Re-map this product to another ASIN">
                      <span className="inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">→ {l.parent.asin}</span>
                    </InlineEdit>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <InlineEdit value={l.notes} onSave={patch(l, "notes")} width="w-48" testId={`notes-${l.id}`} title={l.notes ?? "Add a note"}>
                        <StickyNote className={`h-3.5 w-3.5 ${l.notes ? "text-muted-foreground" : "text-muted-foreground/30"}`} />
                      </InlineEdit>
                      <button onClick={() => remove(l)} className="text-muted-foreground/60 hover:text-destructive" title="Remove product" data-testid={`button-remove-line-${l.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <AddProductRow poId={poId} onAdded={onChanged} />
    </div>
  );
}

/** The line's yield as a number: its exact ratio (migration 080), else its 2-dp yield read as the fraction it stands for. */
export function lineYield(l: { asin_qty_per_product: number | string | null; retailer_units_per_product?: number | string | null; asin_units_per_pack?: number | string | null }): number {
  return effectiveYield(l, trueYield);
}
/** The ASIN units a product line yields: qty ordered × its yield, exact when the line carries its ratio. */
export function lineAsinUnits(l: { qty_ordered: number | string | null; asin_qty_per_product: number | string | null; retailer_units_per_product?: number | string | null; asin_units_per_pack?: number | string | null }): string | null {
  const q = Number(l.qty_ordered), y = lineYield(l);
  if (!Number.isFinite(q) || !Number.isFinite(y) || !(q > 0) || !(y > 0)) return null;
  const r = lineRatio(l);
  return String(r ? fracToNumber(lineUnitsExact(q, r)) : Math.round(q * y * 100) / 100);
}

function AddProductRow({ poId, onAdded }: { poId: string; onAdded: () => void }) {
  // Exact yield (2026-11-02): two integers — retailer units / product (1 for a single) and ASIN units / pack (blank = the ASIN row's pack size); never a decimal.
  const empty = { product_name: "", supplier_sku: "", price: "", qty_ordered: "", asin: "", retailer_units_per_product: "1", asin_units_per_pack: "" };
  const [d, setD] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setErr(null);
    const body = Object.fromEntries(Object.entries(d).filter(([k, v]) => !(k === "asin_units_per_pack" && String(v).trim() === "")));
    try { await poApi(`/api/pos/${poId}/lines`, "POST", body); setD(empty); onAdded(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const f = (k: keyof typeof empty, ph: string, w: string) => (
    <Input value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} placeholder={ph} className={`h-8 text-xs ${w}`} data-testid={`input-add-line-${k}`} />
  );
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="po-add-line">
      {f("product_name", "Product name", "w-64")}{f("supplier_sku", "SKU / UPC", "w-32")}{f("price", "Price", "w-20")}{f("qty_ordered", "Qty", "w-16")}
      {f("asin", "ASIN", "w-28")}{f("retailer_units_per_product", "Retailer units / product", "w-40")}{f("asin_units_per_pack", "ASIN units / pack", "w-32")}{/* the server derives the yield and the ASIN units from the two integers */}
      <Button size="sm" variant="outline" onClick={add} disabled={busy} data-testid="button-add-line"><Plus className="h-3.5 w-3.5 mr-1" /> Add product</Button>
      {err && <span className="text-xs text-destructive" data-testid="add-line-error">{err}</span>}
    </div>
  );
}

// ── History tab ──────────────────────────────────────────────────────────────
export function PoHistory({ poId, reloadKey }: { poId: string; reloadKey: unknown }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    poApi(`/api/pos/${poId}/history`, "GET").then((d) => setRows(d.history ?? [])).catch((e) => setErr(e.message));
  }, [poId, reloadKey]);
  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!rows) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground" data-testid="po-history-empty">No edits yet. Changes made in AF are listed here.</p>;
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  const what = (r: any) => r.entity === "po" ? "PO" : r.entity === "asin" ? `ASIN ${r.entity_label ?? ""}` : r.entity === "line" ? `Product ${r.entity_label ?? ""}` : "Shipment";
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="w-full border-collapse text-sm" data-testid="po-history-table">
        <thead><tr className="table-header-stone">
          {["When", "Who", "What", "Field", "Before", "After"].map((h) => <th key={h} className="px-3 py-2 text-xs font-medium text-left">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="table-zebra-stone" style={hairline} data-testid={`row-history-${r.id}`}>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs">{new Date(r.at).toLocaleString()}</td>
              <td className="px-3 py-1.5 text-xs">{r.user_name ?? (r.user_id == null ? "system" : `user ${r.user_id}`)}</td>
              <td className="px-3 py-1.5 text-xs max-w-[16rem] truncate" title={what(r)}>{what(r)}</td>
              <td className="px-3 py-1.5 text-xs font-mono">{r.field}</td>
              <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.old_value ?? "—"}</td>
              <td className="px-3 py-1.5 text-xs">{r.new_value ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── §5 Cancel PO / Delete PO (po-af-owned §5.1, §5.3, §5.4) ───────────────────
export interface PoGuardsData { lineCount: number; asinCount: number; atPrepUnits: number; fba: { units: number; fbaIds: string[]; rows: number }; blocked: string | null; supplier: string; orderId: string }

/** §5.1 text, client side (shipment rows on screen): "N units shipped to FBA in <ids>. Reassign the shipment to another PO first." */
export function shipmentBlockText(shipments: ReadonlyArray<{ qty_shipped: string | number; fba_shipment_ids?: string[] | null }>): string | null {
  if (shipments.length === 0) return null;
  const units = Math.round(shipments.reduce((t, s) => t + (Number(s.qty_shipped) || 0), 0) * 100) / 100;
  const ids = Array.from(new Set(shipments.flatMap((s) => s.fba_shipment_ids ?? []))).sort();
  return `${fmtQty(units)} unit${units === 1 ? "" : "s"} shipped to FBA in ${ids.length > 0 ? ids.join(", ") : "a shipment with no FBA id yet"}. Reassign the shipment to another PO first.`;
}

/** Delete confirm text (§5.3): names the PO and its products; units still at Velocity when any. */
export function deleteConfirmText(g: Pick<PoGuardsData, "supplier" | "orderId" | "lineCount" | "asinCount" | "atPrepUnits">): string {
  const base = `Delete PO ${g.supplier} ${g.orderId} with its ${g.lineCount} product${g.lineCount === 1 ? "" : "s"} (${g.asinCount} ASIN${g.asinCount === 1 ? "" : "s"})? Sync POs will not import it again.`;
  return g.atPrepUnits > 0 ? `${base} ${fmtQty(g.atPrepUnits)} unit${g.atPrepUnits === 1 ? "" : "s"} still at Velocity for this PO.` : base;
}

export function PoDangerActions({ poId, reloadKey, onCanceled, onDeleted }: { poId: string; reloadKey: unknown; onCanceled: () => void; onDeleted: () => void }) {
  const { toast } = useToast();
  const [g, setG] = useState<PoGuardsData | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { poApi(`/api/pos/${poId}/guards`, "GET").then(setG).catch(() => setG(null)); }, [poId, reloadKey]);
  if (!g) return null;
  const run = async () => {
    setBusy(true);
    try {
      if (confirm === "delete") { await poApi(`/api/pos/${poId}`, "DELETE"); toast({ title: `PO ${g.orderId} deleted` }); setConfirm(null); onDeleted(); }
      else { const r = await poApi(`/api/pos/${poId}/cancel`, "POST"); toast({ title: `PO canceled`, description: `${r.linesCanceled} product(s) canceled` }); setConfirm(null); onCanceled(); }
    } catch (e: any) { toast({ title: confirm === "delete" ? "Not deleted" : "Not canceled", description: e.message, variant: "destructive" }); setConfirm(null); }
    finally { setBusy(false); }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span title={g.blocked ?? "Cancel every product of this PO"}>
        <Button variant="outline" size="sm" disabled={!!g.blocked} onClick={() => setConfirm("cancel")} data-testid="button-cancel-po">Cancel PO</Button>
      </span>
      <span title={g.blocked ?? "Delete this PO"}>
        <Button variant="outline" size="sm" disabled={!!g.blocked} onClick={() => setConfirm("delete")} className="text-destructive hover:text-destructive" data-testid="button-delete-po"><Trash2 className="h-3.5 w-3.5 mr-1" /> Delete PO</Button>
      </span>
      {g.blocked && <span className="max-w-[28rem] text-xs text-amber-700 dark:text-amber-400" data-testid="po-blocked-message">{g.blocked}</span>}
      <Dialog open={confirm != null} onOpenChange={(v) => { if (!v) setConfirm(null); }}>
        <DialogContent dialogId="po-danger-confirm" confirm className="max-w-xl" data-testid="po-danger-confirm">
          <DialogHeader>
            <DialogTitle>{confirm === "delete" ? "Delete PO?" : "Cancel PO?"}</DialogTitle>
            <DialogDescription data-testid="po-danger-confirm-text">
              {confirm === "delete" ? deleteConfirmText(g) : `Cancel every product of ${g.supplier} ${g.orderId} (${g.lineCount}): Canceled = Ordered on each. Logged in History.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Keep it</Button>
            <Button variant="destructive" onClick={run} disabled={busy} data-testid="button-po-danger-confirm">{busy ? "Working…" : confirm === "delete" ? "Delete PO" : "Cancel PO"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

// ── §5.2 Reassign shipment ───────────────────────────────────────────────────
export function ReassignShipment({ shipment, asin, currentRowId, onDone }: { shipment: { id: string; qty_shipped: string }; asin: string; currentRowId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [target, setTarget] = useState<any | null>(null);
  const [units, setUnits] = useState(fmtQty(shipment.qty_shipped));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setRows([]); return; }
    const t = window.setTimeout(() => {
      fetch(`/api/pos/asin-rows/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json())
        .then((d) => setRows((d.rows ?? []).filter((r: any) => String(r.asin).toUpperCase() === asin.toUpperCase() && String(r.id) !== currentRowId)))
        .catch(() => setRows([]));
    }, 200);
    return () => window.clearTimeout(t);
  }, [q, open, asin, currentRowId]);
  const go = async () => {
    if (!target) return;
    setErr(null);
    try { await poApi(`/api/pos/shipments/${shipment.id}/reassign`, "POST", { po_asin_id: target.id, units }); setOpen(false); setTarget(null); onDone(); }
    catch (e: any) { setErr(e.message); }
  };
  if (!open) return <button onClick={(e) => { e.stopPropagation(); setOpen(true); setQ(""); setUnits(fmtQty(shipment.qty_shipped)); }} className="text-[11px] text-primary hover:underline" data-testid={`button-reassign-${shipment.id}`}>Reassign…</button>;
  return (
    <div className="mt-1 space-y-1 rounded border border-border/60 p-1.5" onClick={(e) => e.stopPropagation()} data-testid={`reassign-${shipment.id}`}>
      <div className="text-[10px] text-muted-foreground">Move to another PO's {asin} row (search by order #)</div>
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setTarget(null); }} placeholder="order #" className="h-6 w-full rounded border border-input bg-background px-1 text-xs" data-testid={`input-reassign-search-${shipment.id}`} />
      {rows.length > 0 && !target && (
        <div className="max-h-32 overflow-y-auto">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setTarget(r)} className="block w-full text-left px-1 py-0.5 text-[11px] hover:bg-muted" data-testid={`reassign-target-${r.id}`}>
              {r.supplier} <span className="font-mono">{r.order_id}</span> · {r.order_date} · {fmtQty(r.qty)} ordered
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && rows.length === 0 && !target && <div className="text-[11px] text-muted-foreground">No other PO has a {asin} row matching "{q.trim()}".</div>}
      {target && <div className="text-[11px]">→ {target.supplier} <span className="font-mono">{target.order_id}</span></div>}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground">units</span>
        <input value={units} onChange={(e) => setUnits(e.target.value)} className="h-6 w-14 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-reassign-units-${shipment.id}`} />
        <span className="text-[10px] text-muted-foreground">of {fmtQty(shipment.qty_shipped)}</span>
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!target} onClick={go} data-testid={`button-reassign-go-${shipment.id}`}>Move</Button>
        <button onClick={() => setOpen(false)} className="text-[11px] text-muted-foreground hover:underline">cancel</button>
      </div>
      {err && <div className="text-[11px] text-destructive" data-testid={`reassign-error-${shipment.id}`}>{err}</div>}
    </div>
  );
}
