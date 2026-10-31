/**
 * PO detail — Payments tab (patch docs/claude_spec-patch-po-ai-prefill.md §8,
 * commit 8): payments, promos (with the counts-toward-COGS toggle), refunds
 * per line and the per-ASIN costs with the COGS adjustment, so a PO that
 * came in without them can be completed. Every save hits the server, which
 * logs the change, recomputes a v2 PO's costs when a promo or adjustment
 * changes (never an imported PO), and the page reloads.
 */
import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { InlineEdit, SelectEdit, poApi } from "@/components/po-edit";
import type { PoAsinRowData, PoAsinLine } from "@/components/po-asin-rows";
import { PAYMENT_METHODS, PROMO_TYPES, CASHBACK_STATUSES } from "@shared/po-form";

export interface PoPayment { id: number; method: string; nickname: string | null; last4: string | null; amount: string | null; gift_card_discount_pct: string | null; needs_review: boolean; raw_text: string | null }
export interface PoPromo { id: number; type: string | null; description: string | null; amount: string | null; percent: string | null; counts_toward_cogs: boolean; raw_text: string | null; confidence: string | null; source: string }
export interface PoRefund { id: number; po_line_item_id: string | null; product_name: string | null; qty: number | string | null; amount: string | null; refunded_at: string | null; method: string | null; nickname: string | null; last4: string | null; note: string | null; needs_split: boolean; source: string }

const money = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const sum = (rows: Array<{ amount: string | null }>) => rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
const th = "px-3 py-2 text-xs font-medium whitespace-nowrap text-left";
const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
const Muted = ({ v }: { v: React.ReactNode }) => <span className="text-muted-foreground/50">{v}</span>;

export function PoMoneyTab({ po, asins, payments, promos, refunds, onChanged }: { po: Record<string, any>; asins: Array<PoAsinRowData & { lines?: PoAsinLine[] }>; payments: PoPayment[]; promos: PoPromo[]; refunds: PoRefund[]; onChanged: () => void }) {
  const { toast } = useToast();
  const call = async (url: string, method: string, body?: unknown) => { try { const r = await poApi(url, method, body); if (r?.recomputed && !r.recomputed.skipped && r.recomputed.changed > 0) toast({ title: `Costs recomputed (${r.recomputed.changed} change${r.recomputed.changed === 1 ? "" : "s"})` }); onChanged(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } };
  const patch = (url: string, field: string) => async (v: string) => call(url, "PATCH", { [field]: v });
  const [newPay, setNewPay] = useState({ method: "card", nickname: "", last4: "", amount: "" });
  const [newPromo, setNewPromo] = useState({ type: "coupon", description: "", amount: "", percent: "" });
  const lines = asins.flatMap((a) => (a.lines ?? []).map((l) => ({ ...l, asin: a.asin })));
  const [newRefund, setNewRefund] = useState({ po_line_item_id: "", qty: "", amount: "", refunded_at: "", note: "" });
  const total = Number(po.order_total) || 0, paid = sum(payments);
  const imported = po.cost_formula_version == null;

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Payments */}
      <section className="space-y-2" data-testid="po-payments">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Payments</h3>
          <span className="text-xs text-muted-foreground">{payments.length ? `${money(paid)} of ${money(total)}` : po.payment_method ? `sheet: ${po.payment_method}` : ""}{payments.length && Math.abs(paid - total) > 0.005 ? <span className="ml-2 text-amber-700 dark:text-amber-400">differs from the order total</span> : null}</span>
        </div>
        <table className="w-full border-collapse text-sm rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <thead><tr className="table-header-stone"><th className={th}>Method</th><th className={th}>Nickname</th><th className={th}>Last 4</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>GC %</th><th className={th}></th></tr></thead>
          <tbody>
            {payments.length === 0 && <tr><td colSpan={6} className="px-3 py-2 text-xs text-muted-foreground">No payments recorded.</td></tr>}
            {payments.map((p) => (
              <tr key={p.id} className="table-zebra-stone" style={hairline} data-testid={`row-payment-${p.id}`}>
                <td className="px-3 py-1.5"><SelectEdit value={p.method} options={PAYMENT_METHODS} onSave={patch(`/api/pos/payments/${p.id}`, "method")} testId={`payment-method-${p.id}`} />{p.needs_review && <span className="ml-1.5 text-[10px] text-amber-700 dark:text-amber-400" title={p.raw_text ?? ""}>review</span>}</td>
                <td className="px-3 py-1.5"><InlineEdit value={p.nickname} onSave={patch(`/api/pos/payments/${p.id}`, "nickname")} width="w-32" testId={`payment-nickname-${p.id}`}>{p.nickname ?? <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5 font-mono text-xs"><InlineEdit value={p.last4} onSave={patch(`/api/pos/payments/${p.id}`, "last4")} width="w-16" testId={`payment-last4-${p.id}`}>{p.last4 ?? <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={p.amount} onSave={patch(`/api/pos/payments/${p.id}`, "amount")} align="right" width="w-24" testId={`payment-amount-${p.id}`}>{money(p.amount)}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right">{p.method === "gift_card" ? <InlineEdit value={p.gift_card_discount_pct} onSave={patch(`/api/pos/payments/${p.id}`, "gift_card_discount_pct")} align="right" width="w-16" testId={`payment-gc-${p.id}`}>{p.gift_card_discount_pct != null ? `${Number(p.gift_card_discount_pct)}%` : <Muted v="—" />}</InlineEdit> : <Muted v="—" />}</td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => { if (window.confirm("Remove this payment?")) void call(`/api/pos/payments/${p.id}`, "DELETE"); }} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-remove-payment-${p.id}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2" data-testid="po-add-payment">
          <select value={newPay.method} onChange={(e) => setNewPay({ ...newPay, method: e.target.value })} className="h-8 rounded border border-input bg-background px-1 text-xs">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select>
          <Input value={newPay.nickname} onChange={(e) => setNewPay({ ...newPay, nickname: e.target.value })} placeholder="Amex" className="h-8 w-28 text-xs" data-testid="input-add-payment-nickname" />
          <Input value={newPay.last4} onChange={(e) => setNewPay({ ...newPay, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="last 4" className="h-8 w-16 font-mono text-xs" data-testid="input-add-payment-last4" />
          <Input value={newPay.amount} onChange={(e) => setNewPay({ ...newPay, amount: e.target.value })} placeholder="$" className="h-8 w-20 text-right text-xs" data-testid="input-add-payment-amount" />
          <Button size="sm" variant="outline" onClick={() => void call(`/api/pos/${po.id}/payments`, "POST", newPay).then(() => setNewPay({ method: "card", nickname: "", last4: "", amount: "" }))} data-testid="button-add-payment"><Plus className="h-3.5 w-3.5 mr-1" /> Payment</Button>
        </div>
      </section>

      {/* Promos */}
      <section className="space-y-2" data-testid="po-promos">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Promos</h3>
          <span className="text-xs text-muted-foreground">{imported ? "imported PO — costs stay as imported" : "a promo that does not count toward COGS is added back (v2 costs recompute)"}{po.promo ? ` · sheet: ${po.promo}` : ""}</span>
        </div>
        <table className="w-full border-collapse text-sm" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <thead><tr className="table-header-stone"><th className={th}>Type</th><th className={th}>Description</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>%</th><th className={th}>Counts toward COGS</th><th className={th}></th></tr></thead>
          <tbody>
            {promos.length === 0 && <tr><td colSpan={6} className="px-3 py-2 text-xs text-muted-foreground">No promos.</td></tr>}
            {promos.map((p) => (
              <tr key={p.id} className="table-zebra-stone" style={hairline} data-testid={`row-promo-${p.id}`}>
                <td className="px-3 py-1.5"><SelectEdit value={p.type ?? ""} options={["", ...PROMO_TYPES]} onSave={patch(`/api/pos/promos/${p.id}`, "type")} testId={`promo-type-${p.id}`} />{p.type == null && <span className="ml-1.5 text-[10px] text-amber-700 dark:text-amber-400" title={p.raw_text ?? ""}>choose</span>}</td>
                <td className="px-3 py-1.5"><InlineEdit value={p.description} onSave={patch(`/api/pos/promos/${p.id}`, "description")} width="w-72" testId={`promo-desc-${p.id}`}><span title={p.raw_text ?? ""}>{p.description ?? p.raw_text ?? <Muted v="—" />}</span></InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={p.amount} onSave={patch(`/api/pos/promos/${p.id}`, "amount")} align="right" width="w-20" testId={`promo-amount-${p.id}`}>{money(p.amount)}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right"><InlineEdit value={p.percent} onSave={patch(`/api/pos/promos/${p.id}`, "percent")} align="right" width="w-14" testId={`promo-pct-${p.id}`}>{p.percent != null ? `${Number(p.percent)}%` : <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5"><label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={p.counts_toward_cogs} onChange={(e) => void call(`/api/pos/promos/${p.id}`, "PATCH", { counts_toward_cogs: e.target.checked })} data-testid={`promo-counts-${p.id}`} />{p.counts_toward_cogs ? "yes" : "no (added back)"}</label></td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => { if (window.confirm("Remove this promo?")) void call(`/api/pos/promos/${p.id}`, "DELETE"); }} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-remove-promo-${p.id}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2" data-testid="po-add-promo">
          <select value={newPromo.type} onChange={(e) => setNewPromo({ ...newPromo, type: e.target.value })} className="h-8 rounded border border-input bg-background px-1 text-xs">{PROMO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Input value={newPromo.description} onChange={(e) => setNewPromo({ ...newPromo, description: e.target.value })} placeholder="15% off with WELCOME15" className="h-8 w-64 text-xs" data-testid="input-add-promo-desc" />
          <Input value={newPromo.amount} onChange={(e) => setNewPromo({ ...newPromo, amount: e.target.value })} placeholder="$" className="h-8 w-20 text-right text-xs" data-testid="input-add-promo-amount" />
          <Input value={newPromo.percent} onChange={(e) => setNewPromo({ ...newPromo, percent: e.target.value })} placeholder="%" className="h-8 w-14 text-right text-xs" data-testid="input-add-promo-pct" />
          <Button size="sm" variant="outline" onClick={() => void call(`/api/pos/${po.id}/promos`, "POST", newPromo).then(() => setNewPromo({ type: "coupon", description: "", amount: "", percent: "" }))} data-testid="button-add-promo"><Plus className="h-3.5 w-3.5 mr-1" /> Promo</Button>
        </div>
      </section>

      {/* Refunds per line */}
      <section className="space-y-2" data-testid="po-refunds">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Refunds</h3>
          <span className="text-xs text-muted-foreground">{refunds.length ? `${money(sum(refunds))} refunded` : Number(po.refund_amount) > 0 ? `sheet refund amount ${money(po.refund_amount)}` : ""}</span>
        </div>
        <table className="w-full border-collapse text-sm" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <thead><tr className="table-header-stone"><th className={th}>Line</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Amount</th><th className={th}>Date</th><th className={th}>Method</th><th className={th}>Note</th><th className={th}></th></tr></thead>
          <tbody>
            {refunds.length === 0 && <tr><td colSpan={7} className="px-3 py-2 text-xs text-muted-foreground">No refunds.</td></tr>}
            {refunds.map((r) => (
              <tr key={r.id} className="table-zebra-stone" style={hairline} data-testid={`row-refund-${r.id}`}>
                <td className="px-3 py-1.5 text-xs">
                  {r.po_line_item_id ? <span className="truncate block max-w-[18rem]" title={r.product_name ?? ""}>{r.product_name ?? r.po_line_item_id}</span> : (
                    <select value="" onChange={(e) => void call(`/api/pos/refunds/${r.id}`, "PATCH", { po_line_item_id: e.target.value, needs_split: false })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid={`refund-line-${r.id}`}>
                      <option value="">PO-level{r.needs_split ? " — split across the lines" : ""}…</option>
                      {lines.map((l) => <option key={l.id} value={l.id}>{l.product_name ?? l.id} ({l.asin})</option>)}
                    </select>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right"><InlineEdit value={r.qty} onSave={patch(`/api/pos/refunds/${r.id}`, "qty")} align="right" width="w-14" testId={`refund-qty-${r.id}`}>{r.qty ?? <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={r.amount} onSave={patch(`/api/pos/refunds/${r.id}`, "amount")} align="right" width="w-20" testId={`refund-amount-${r.id}`}>{money(r.amount)}</InlineEdit></td>
                <td className="px-3 py-1.5 text-xs"><InlineEdit value={r.refunded_at} onSave={patch(`/api/pos/refunds/${r.id}`, "refunded_at")} width="w-28" testId={`refund-date-${r.id}`}>{r.refunded_at ?? <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5"><SelectEdit value={r.method ?? ""} options={["", ...PAYMENT_METHODS]} onSave={patch(`/api/pos/refunds/${r.id}`, "method")} testId={`refund-method-${r.id}`} /></td>
                <td className="px-3 py-1.5 text-xs"><InlineEdit value={r.note} onSave={patch(`/api/pos/refunds/${r.id}`, "note")} width="w-56" testId={`refund-note-${r.id}`}><span className="truncate block max-w-[16rem] text-muted-foreground" title={r.note ?? ""}>{r.note ?? "—"}</span></InlineEdit></td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => { if (window.confirm("Remove this refund?")) void call(`/api/pos/refunds/${r.id}`, "DELETE"); }} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-remove-refund-${r.id}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2" data-testid="po-add-refund">
          <select value={newRefund.po_line_item_id} onChange={(e) => setNewRefund({ ...newRefund, po_line_item_id: e.target.value })} className="h-8 max-w-[20rem] rounded border border-input bg-background px-1 text-xs" data-testid="select-add-refund-line">
            <option value="">PO-level (split later)</option>{lines.map((l) => <option key={l.id} value={l.id}>{l.product_name ?? l.id} ({l.asin})</option>)}
          </select>
          <Input value={newRefund.qty} onChange={(e) => setNewRefund({ ...newRefund, qty: e.target.value })} placeholder="qty" className="h-8 w-14 text-right text-xs" data-testid="input-add-refund-qty" />
          <Input value={newRefund.amount} onChange={(e) => setNewRefund({ ...newRefund, amount: e.target.value })} placeholder="$" className="h-8 w-20 text-right text-xs" data-testid="input-add-refund-amount" />
          <input type="date" value={newRefund.refunded_at} onChange={(e) => setNewRefund({ ...newRefund, refunded_at: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs" data-testid="input-add-refund-date" />
          <Input value={newRefund.note} onChange={(e) => setNewRefund({ ...newRefund, note: e.target.value })} placeholder="note" className="h-8 w-40 text-xs" data-testid="input-add-refund-note" />
          <Button size="sm" variant="outline" onClick={() => void call(`/api/pos/${po.id}/refunds`, "POST", { ...newRefund, po_line_item_id: newRefund.po_line_item_id || null, needs_split: !newRefund.po_line_item_id }).then(() => setNewRefund({ po_line_item_id: "", qty: "", amount: "", refunded_at: "", note: "" }))} data-testid="button-add-refund"><Plus className="h-3.5 w-3.5 mr-1" /> Refund</Button>
        </div>
      </section>

      {/* Costs per ASIN row */}
      <section className="space-y-2" data-testid="po-costs">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Costs per ASIN</h3>
          <span className="text-xs text-muted-foreground">Sourcing = col AR (Update COGS in SC) · COGS = col Y (+ adjustment) · Paid = every discount{imported ? " · imported values, never recomputed" : ""}</span>
        </div>
        <table className="w-full border-collapse text-sm" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <thead><tr className="table-header-stone"><th className={th}>ASIN</th><th className={`${th} text-right`}>Sourcing</th><th className={`${th} text-right`}>COGS / unit</th><th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>Adjustment</th><th className={th}>Reason</th></tr></thead>
          <tbody>
            {asins.map((a: any) => (
              <tr key={a.id} className="table-zebra-stone" style={hairline} data-testid={`row-cost-${a.asin}`}>
                <td className="px-3 py-1.5 font-mono text-xs">{a.asin}</td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={a.sourcing_cost} onSave={patch(`/api/pos/asin-rows/${a.id}`, "sourcing_cost")} align="right" width="w-20" testId={`cost-sourcing-${a.asin}`}>{money(a.sourcing_cost)}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono">{money(a.cost_per_unit)}</td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={a.paid_cost} onSave={patch(`/api/pos/asin-rows/${a.id}`, "paid_cost")} align="right" width="w-20" testId={`cost-paid-${a.asin}`}>{money(a.paid_cost)}</InlineEdit></td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={a.cogs_adjustment} onSave={patch(`/api/pos/asin-rows/${a.id}`, "cogs_adjustment")} align="right" width="w-20" testId={`cost-adj-${a.asin}`}>{a.cogs_adjustment != null ? money(a.cogs_adjustment) : <Muted v="—" />}</InlineEdit></td>
                <td className="px-3 py-1.5 text-xs"><InlineEdit value={a.cogs_adjustment_reason} onSave={patch(`/api/pos/asin-rows/${a.id}`, "cogs_adjustment_reason")} width="w-56" testId={`cost-adj-reason-${a.asin}`}><span className="text-muted-foreground">{a.cogs_adjustment_reason ?? "—"}</span></InlineEdit></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-[11px] text-muted-foreground">Cashback status: <select value={po.cashback_status ?? ""} onChange={(e) => void call(`/api/pos/${po.id}`, "PATCH", { cashback_status: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-cashback-status"><option value="">—</option>{CASHBACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>{po.cashback_site ? ` · ${po.cashback_site}${po.cashback_pct != null ? ` ${Number(po.cashback_pct)}%` : ""}` : ""}</p>
    </div>
  );
}
