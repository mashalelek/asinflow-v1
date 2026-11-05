/**
 * PO detail — Payments tab, Supplier defects (SPEC §22 "Supplier defects",
 * migration 094): per product line, units missing / damaged / wrong from the
 * supplier, the $ owed, and how it was resolved — refund (linked refund rows;
 * received in full resolves it, a partial one leaves the rest owed),
 * replacement (the PO line that supplied it) or write-off (a reason). An open
 * defect is what shows "Missing / damaged from supplier" on the PO. Every
 * change is a History row; nothing here changes a quantity or a cost.
 */
import React, { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineEdit } from "@/components/po-edit";
import { InlineNoteCell } from "@/components/inline-note";
import type { PoAsinRowData, PoAsinLine } from "@/components/po-asin-rows";
import type { PoRefund } from "@/components/po-money";
import { DEFECT_KINDS, DEFECT_KIND_LABELS, defectAmount, type DefectKind } from "@shared/po-defect";

export interface PoDefect {
  id: number; po_line_item_id: string; kind: DefectKind; qty: number; amount: number | null; opened_at: string; note: string | null;
  status: "open" | "resolved"; resolution: "refund" | "replacement" | "write_off" | null; write_off_reason: string | null; resolved_at: string | null;
  asin: string | null; product_name: string | null; line_no: number;
  refunds: Array<{ id: number; amount: number | null; status: string; refunded_at: string | null }>;
  replacement: { po_id: string; order_id: string; supplier: string; asin: string | null; line_no: number } | null;
  owed: number | null; uncovered: number | null; received: number;
}

const money = (v: number | string | null | undefined) => (v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`);
const th = "px-3 py-2 text-xs font-medium whitespace-nowrap text-left";
const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
const link = "text-[10px] underline-offset-2 hover:underline text-muted-foreground hover:text-foreground";

function resolutionText(d: PoDefect): string {
  if (d.resolution === "refund") return `refunded ${money(d.received)}`;
  if (d.resolution === "replacement") return d.replacement ? `replaced by ${d.replacement.order_id}${d.replacement.asin ? ` ${d.replacement.asin} line ${d.replacement.line_no}` : ""}` : "replaced";
  if (d.resolution === "write_off") return `written off: ${d.write_off_reason ?? ""}`;
  return "";
}

export function PoDefectsSection({ po, asins, refunds, defects, call }: {
  po: Record<string, any>; asins: Array<PoAsinRowData & { lines?: PoAsinLine[] }>; refunds: PoRefund[]; defects: PoDefect[];
  call: (url: string, method: string, body?: unknown) => Promise<void>;
}) {
  const lines = asins.flatMap((a) => (a.lines ?? []).map((l, i) => ({ ...l, asin: a.asin, lineNo: i + 1 })));
  const [add, setAdd] = useState({ po_line_item_id: lines.length === 1 ? String(lines[0].id) : "", kind: "missing" as DefectKind, qty: "", amount: "", note: "" });
  const [acting, setActing] = useState<{ id: number; kind: "replacement" | "write_off"; text: string } | null>(null);
  const line = lines.find((l) => String(l.id) === add.po_line_item_id);
  const proposed = line && Number(add.qty) > 0
    ? defectAmount({ qty: Number(add.qty), adjustedProductCost: line.adjusted_product_cost, price: line.price, subtotal: po.subtotal, discount: po.discount, tax: po.tax, shipping: po.sh_donations })
    : null;
  const patch = (id: number, field: string) => async (v: string) => call(`/api/pos/defects/${id}`, "PATCH", { [field]: v });
  const open = defects.filter((d) => d.status === "open");
  // refund ids arrive as strings (bigint) on the refund rows, as numbers on the links
  const linked = new Set(defects.flatMap((d) => d.refunds.map((r) => Number(r.id))));

  return (
    <section className="space-y-2" data-testid="po-defects">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Supplier defects</h3>
        <span className="text-xs text-muted-foreground" data-testid="po-defects-summary">{open.length ? `${open.length} open · ${money(open.reduce((t, d) => t + (d.owed ?? 0), 0))} owed` : defects.length ? "all resolved" : ""}</span>
      </div>
      <table className="w-full border-collapse text-sm rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <thead><tr className="table-header-stone"><th className={th}>Line</th><th className={th}>Kind</th><th className={`${th} text-right`} title="Retailer units">Qty</th><th className={`${th} text-right`} title="What the supplier owes for these units">Owed</th><th className={th}>Opened</th><th className={th}>Note</th><th className={th}>Status</th><th className={th}></th></tr></thead>
        <tbody>
          {defects.length === 0 && <tr><td colSpan={8} className="px-3 py-2 text-xs text-muted-foreground">No supplier defects.</td></tr>}
          {defects.map((d) => (
            <React.Fragment key={d.id}>
              <tr className="table-zebra-stone align-top" style={hairline} data-testid={`row-defect-${d.id}`}>
                <td className="px-3 py-1.5 text-xs"><span className="font-mono">{d.asin}</span> line {d.line_no}<div className="text-muted-foreground truncate max-w-[14rem]" title={d.product_name ?? ""}>{d.product_name}</div></td>
                <td className="px-3 py-1.5 text-xs"><select value={d.kind} onChange={(e) => void patch(d.id, "kind")(e.target.value)} className="h-6 rounded border border-input bg-background px-1 text-xs" data-testid={`select-defect-kind-${d.id}`}>
                  {DEFECT_KINDS.map((k) => <option key={k} value={k}>{DEFECT_KIND_LABELS[k]}</option>)}</select></td>
                <td className="px-3 py-1.5 text-right"><InlineEdit value={String(d.qty)} onSave={patch(d.id, "qty")} align="right" width="w-14" testId={`defect-qty-${d.id}`}>{d.qty}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={d.amount == null ? null : String(d.amount)} onSave={patch(d.id, "amount")} align="right" width="w-20" testId={`defect-amount-${d.id}`}>{money(d.amount)}</InlineEdit>
                  {d.status === "open" && d.received > 0 && <div className="text-[10px] text-muted-foreground">{money(d.owed)} still owed</div>}</td>
                <td className="px-3 py-1.5 text-xs whitespace-nowrap">{d.opened_at}</td>
                <td className="p-0 text-xs"><InlineNoteCell value={d.note} label="defect note" showText emptyLabel="—" className="px-3 py-1.5 max-w-[16rem]" testId={`defect-note-${d.id}`} onSave={async (v) => { await call(`/api/pos/defects/${d.id}`, "PATCH", { note: v }); }} /></td>
                <td className="px-3 py-1.5 text-xs" data-testid={`defect-status-${d.id}`}>
                  {d.status === "open" ? <span className="text-amber-700 dark:text-amber-400">open</span> : <span>{resolutionText(d)}</span>}
                  {d.refunds.map((r) => (
                    <div key={r.id} className="text-[10px] text-muted-foreground" data-testid={`defect-refund-${d.id}-${r.id}`}>refund {money(r.amount)} {r.status}
                      <button onClick={() => void call(`/api/pos/defects/${d.id}/refunds/${r.id}`, "DELETE")} className="ml-1 align-middle hover:text-destructive" title="Unlink this refund"><X className="inline h-3 w-3" /></button></div>
                  ))}
                  <div className="flex flex-wrap gap-x-2">
                    {d.status === "open" && refunds.some((r) => !linked.has(Number(r.id))) && (
                      <select value="" onChange={(e) => e.target.value && void call(`/api/pos/defects/${d.id}/refunds`, "POST", { refund_id: Number(e.target.value) })} className="h-6 max-w-[9rem] rounded border border-input bg-background px-1 text-[10px]" data-testid={`select-defect-link-refund-${d.id}`}>
                        <option value="">link refund…</option>
                        {refunds.filter((r) => !linked.has(Number(r.id))).map((r) => <option key={r.id} value={r.id}>{money(r.amount)} {r.status}{r.note ? ` — ${r.note}` : ""}</option>)}
                      </select>
                    )}
                    {d.status === "open" && <button onClick={() => setActing({ id: d.id, kind: "replacement", text: "" })} className={link} data-testid={`button-defect-replacement-${d.id}`}>replacement…</button>}
                    {d.status === "open" && <button onClick={() => setActing({ id: d.id, kind: "write_off", text: "" })} className={link} data-testid={`button-defect-write-off-${d.id}`}>write off…</button>}
                    {d.status === "resolved" && <button onClick={() => void call(`/api/pos/defects/${d.id}/reopen`, "POST")} className={link} data-testid={`button-defect-reopen-${d.id}`}>reopen</button>}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => { if (window.confirm("Remove this supplier defect?")) void call(`/api/pos/defects/${d.id}`, "DELETE"); }} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-remove-defect-${d.id}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
              {acting?.id === d.id && (
                <tr style={hairline} data-testid={`defect-acting-${d.id}`}>
                  <td colSpan={8} className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{acting.kind === "replacement" ? `Replacement PO order # (its ${d.asin} line)` : "Write-off reason"}</span>
                      <Input autoFocus value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} className="h-7 w-64 text-xs" data-testid={`input-defect-${acting.kind}-${d.id}`} />
                      <Button size="sm" variant="outline" className="h-7" disabled={!acting.text.trim()} data-testid={`button-defect-${acting.kind}-save-${d.id}`}
                        onClick={() => void call(`/api/pos/defects/${d.id}/resolve`, "POST", acting.kind === "replacement" ? { resolution: "replacement", replacement_order_id: acting.text.trim() } : { resolution: "write_off", reason: acting.text.trim() }).then(() => setActing(null))}>
                        {acting.kind === "replacement" ? "Resolve by replacement" : "Write off"}</Button>
                      <button onClick={() => setActing(null)} className={link}>cancel</button>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2" data-testid="po-add-defect">
        <select value={add.po_line_item_id} onChange={(e) => setAdd({ ...add, po_line_item_id: e.target.value })} className="h-8 max-w-[20rem] rounded border border-input bg-background px-1 text-xs" data-testid="select-add-defect-line">
          <option value="">line…</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.asin} line {l.lineNo} — {l.product_name ?? ""}</option>)}
        </select>
        <select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as DefectKind })} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid="select-add-defect-kind">
          {DEFECT_KINDS.map((k) => <option key={k} value={k}>{DEFECT_KIND_LABELS[k]}</option>)}
        </select>
        <Input value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} placeholder="qty" title="Retailer units" className="h-8 w-14 text-right text-xs" data-testid="input-add-defect-qty" />
        <Input value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} placeholder={proposed != null ? proposed.toFixed(2) : "$"} title="Blank = qty × the line's cost per retailer unit" className="h-8 w-20 text-right text-xs" data-testid="input-add-defect-amount" />
        <Input value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} placeholder="note" className="h-8 w-48 text-xs" data-testid="input-add-defect-note" />
        <Button size="sm" variant="outline" disabled={!add.po_line_item_id || !(Number(add.qty) > 0)} data-testid="button-add-defect"
          onClick={() => void call(`/api/pos/${po.id}/defects`, "POST", { po_line_item_id: add.po_line_item_id, kind: add.kind, qty: add.qty, note: add.note || null, ...(add.amount.trim() ? { amount: add.amount } : {}) })
            .then(() => setAdd({ ...add, qty: "", amount: "", note: "" }))}><Plus className="h-3.5 w-3.5 mr-1" /> Defect</Button>
      </div>
    </section>
  );
}
