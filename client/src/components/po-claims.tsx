/**
 * PO detail — Payments tab, Supplier claims (SPEC §22 "Supplier claims",
 * migration 101; was Supplier defects, 094). One row per supplier problem on a
 * line: kind, qty in INDIVIDUAL units (D16 — the Product / ASIN equivalents
 * beside it), the $ owed (auto from the line's cost per Individual unit, or
 * typed), status, outcome, the open tasks, the applied refunds. Actions: add,
 * link / unlink a received refund, set the outcome (refund / credit; replacement;
 * write-off with a reason), tick a task, dismiss, reopen, remove. The Claims
 * page with buckets and the step checklist is commit 2; this section is the
 * per-PO view until then. Every change is a History row; nothing here changes a
 * quantity or a cost.
 */
import React, { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineEdit } from "@/components/po-edit";
import { InlineNoteCell } from "@/components/inline-note";
import type { PoAsinRowData, PoAsinLine } from "@/components/po-asin-rows";
import type { PoRefund } from "@/components/po-money";
import { fmtQty } from "@/lib/po-qty";
import { INDIV_SHORT, QTY_KIND } from "@shared/quantity-kinds";
import { CLAIM_KINDS, CLAIM_KIND_LABELS, CLAIM_OUTCOME_LABELS, CLAIM_TASK_LABELS, QTY_UNKNOWN_LABEL, SHEET_ZEROED_LABEL, claimAmount, individualEquivalents, type ClaimKind, type ClaimOutcome, type ClaimTaskKind } from "@shared/supplier-claim";

export interface PoClaim {
  id: number; po_line_item_id: string | null; kind: ClaimKind; /** Individual units; null = not known yet (counts toward nothing). */ qty: number | null; amount_owed: number | null; amount_owed_source: "auto" | "manual"; found_at: string; note: string | null;
  status: "suggested" | "open" | "closed" | "dismissed"; outcome: ClaimOutcome | null; outcome_amount: number | null; write_off_reason: string | null; closed_at: string | null;
  asin: string | null; product_name: string | null; line_no: number; product_pack: number | null; asin_pack: number | null; qty_basis: string | null;
  refunds: Array<{ id: number; amount: number | null; amount_applied: number | null; refunded_at: string | null; method: string | null }>;
  tasks: Array<{ id: number; kind: ClaimTaskKind; group: string; reason: string | null; done_at: string | null }>;
  conversion_flags?: string[];
  owed: number | null; remaining: number | null; received: number;
}

const money = (v: number | string | null | undefined) => (v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`);
const th = "px-3 py-2 text-xs font-medium whitespace-nowrap text-left align-bottom";
const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
const link = "text-[10px] underline-offset-2 hover:underline text-muted-foreground hover:text-foreground";

/** "12 Individual u. · 2 Product u. · 6 ASIN u." — the equivalents beside a typed Individual quantity (D16). */
export function qtyEquivalents(individual: number | null, productPack: number | string | null | undefined, asinPack: number | string | null | undefined): string {
  const e = individualEquivalents(individual, productPack, asinPack);
  return [e.product != null ? `${fmtQty(e.product)} Product u.` : null, e.asin != null ? `${fmtQty(e.asin)} ASIN u.` : null].filter(Boolean).join(" · ");
}

function statusText(d: PoClaim): string {
  if (d.status === "dismissed") return "dismissed";
  if (d.status === "suggested") return "suggested";
  if (d.status === "closed") return d.outcome === "write_off" ? `written off: ${d.write_off_reason ?? ""}` : d.outcome === "replacement" ? "replaced" : d.outcome ? `${CLAIM_OUTCOME_LABELS[d.outcome]} ${money(d.received)}` : "closed";
  return d.outcome ? `open · ${CLAIM_OUTCOME_LABELS[d.outcome]}${d.remaining != null ? ` · ${money(d.remaining)} remaining` : ""}` : "open";
}

export function PoClaimsSection({ po, asins, refunds, claims, call }: {
  po: Record<string, any>; asins: Array<PoAsinRowData & { lines?: PoAsinLine[] }>; refunds: PoRefund[]; claims: PoClaim[];
  call: (url: string, method: string, body?: unknown) => Promise<void>;
}) {
  const lines = asins.flatMap((a) => (a.lines ?? []).map((l, i) => ({ ...l, asin: a.asin, lineNo: i + 1, asinPack: a.units_per_pack })));
  const [add, setAdd] = useState({ po_line_item_id: lines.length === 1 ? String(lines[0].id) : "", kind: "missing" as ClaimKind, qty: "", amount_owed: "", note: "" });
  const [acting, setActing] = useState<{ id: number; kind: "write_off" | "refund" | "replacement"; text: string } | null>(null);
  const line = lines.find((l) => String(l.id) === add.po_line_item_id);
  const legacy = line?.qty_basis === "product_legacy";
  const qtyN = Number(add.qty) > 0 ? Number(add.qty) : null;
  const proposed = line && qtyN
    ? claimAmount({ qty: qtyN, productPack: legacy ? 1 : line.retailer_units_per_product, adjustedProductCost: line.adjusted_product_cost, price: line.price, subtotal: po.subtotal, discount: po.discount, tax: po.tax, shipping: po.sh_donations })
    : null;
  const patch = (id: number, field: string) => async (v: string) => call(`/api/pos/claims/${id}`, "PATCH", { [field]: v });
  const open = claims.filter((d) => d.status === "open");
  const linked = (d: PoClaim) => new Set(d.refunds.map((r) => Number(r.id)));

  return (
    <section className="space-y-2" data-testid="po-claims">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Supplier claims</h3>
        <span className="text-xs text-muted-foreground" data-testid="po-claims-summary">{open.length ? `${open.length} open · ${money(open.reduce((t, d) => t + (d.remaining ?? 0), 0))} owed` : claims.length ? "none open" : ""}</span>
      </div>
      <table className="w-full border-collapse text-sm rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <thead><tr className="table-header-stone"><th className={th}>Line</th><th className={th}>Kind</th>
          <th className={`${th} text-right`}><span className="block text-[9px] font-normal opacity-60">{QTY_KIND.individual}</span>Qty</th>
          <th className={`${th} text-right`} title="What the supplier owes for these units; auto = qty × the line's cost per Individual unit">Owed</th><th className={th}>Found</th><th className={th}>Note</th><th className={th}>Status · tasks</th><th className={th}></th></tr></thead>
        <tbody>
          {claims.length === 0 && <tr><td colSpan={8} className="px-3 py-2 text-xs text-muted-foreground">No supplier claims.</td></tr>}
          {claims.map((d) => (
            <React.Fragment key={d.id}>
              <tr className={`table-zebra-stone align-top ${d.status === "dismissed" ? "opacity-60" : ""}`} style={hairline} data-testid={`row-claim-${d.id}`}>
                <td className="px-3 py-1.5 text-xs">{d.po_line_item_id ? <><span className="font-mono">{d.asin}</span> line {d.line_no}<div className="text-muted-foreground truncate max-w-[14rem]" title={d.product_name ?? ""}>{d.product_name}</div></> : <span className="text-muted-foreground">whole PO</span>}</td>
                <td className="px-3 py-1.5 text-xs"><select value={d.kind} onChange={(e) => void patch(d.id, "kind")(e.target.value)} className="h-6 rounded border border-input bg-background px-1 text-xs" data-testid={`select-claim-kind-${d.id}`}>
                  {CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select></td>
                {/* qty NULL = not known yet (a converted badge: "Enter quantity"; a sheet-zeroed line: unknown) — counts toward nothing until typed */}
                <td className="px-3 py-1.5 text-right"><InlineEdit value={d.qty == null ? null : String(d.qty)} onSave={patch(d.id, "qty")} align="right" width="w-14" testId={`claim-qty-${d.id}`} title={d.qty == null ? "Not known — type the Individual units" : d.qty_basis === "product_legacy" ? "Product units (the line's pack is not known)" : QTY_KIND.individual}>
                  {d.qty == null ? <span className="text-amber-700 dark:text-amber-400 whitespace-nowrap text-xs" data-testid={`claim-qty-unknown-${d.id}`}>{(d.conversion_flags ?? []).includes("canceled_no_ordered_qty") ? SHEET_ZEROED_LABEL : QTY_UNKNOWN_LABEL}</span> : fmtQty(d.qty)}</InlineEdit>
                  {d.qty != null && <div className="text-[10px] text-muted-foreground whitespace-nowrap" data-testid={`claim-qty-equiv-${d.id}`}>{d.qty_basis === "product_legacy" ? "Product u. (pack not known)" : qtyEquivalents(d.qty, d.product_pack, d.asin_pack) || `${INDIV_SHORT}`}</div>}</td>
                <td className="px-3 py-1.5 text-right font-mono"><InlineEdit money value={d.amount_owed == null ? null : String(d.amount_owed)} onSave={patch(d.id, "amount_owed")} align="right" width="w-20" testId={`claim-amount-${d.id}`} title={d.amount_owed_source === "manual" ? "Typed — AF never recalculates it; clear to go back to auto" : "Auto: qty × the line's cost per Individual unit"}>{money(d.amount_owed)}</InlineEdit>
                  {d.amount_owed_source === "manual" && <div className="text-[10px] text-muted-foreground">manual</div>}
                  {d.status === "open" && d.received > 0 && <div className="text-[10px] text-muted-foreground">{money(d.remaining)} remaining</div>}</td>
                <td className="px-3 py-1.5 text-xs whitespace-nowrap">{d.found_at}</td>
                <td className="p-0 text-xs"><InlineNoteCell value={d.note} label="claim note" showText emptyLabel="—" className="px-3 py-1.5 max-w-[16rem]" testId={`claim-note-${d.id}`} onSave={async (v) => { await call(`/api/pos/claims/${d.id}`, "PATCH", { note: v }); }} /></td>
                <td className="px-3 py-1.5 text-xs" data-testid={`claim-status-${d.id}`}>
                  <span className={d.status === "open" ? "text-amber-700 dark:text-amber-400" : ""}>{statusText(d)}</span>
                  {d.tasks.filter((t) => t.done_at == null).map((t) => (
                    <div key={t.id} className="text-[10px]" data-testid={`claim-task-${d.id}-${t.kind}`} title={t.reason ?? ""}>
                      {t.kind === "enter_quantity"
                        ? <span className="text-amber-700 dark:text-amber-400">Enter quantity ← type it in Qty</span>
                        : <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" onChange={() => void call(`/api/pos/claims/tasks/${t.id}/done`, "POST")} data-testid={`checkbox-claim-task-${t.id}`} />{CLAIM_TASK_LABELS[t.kind] ?? t.kind}</label>}
                    </div>
                  ))}
                  {d.refunds.map((r) => (
                    <div key={r.id} className="text-[10px] text-muted-foreground" data-testid={`claim-refund-${d.id}-${r.id}`}>refund {money(r.amount_applied ?? r.amount)}{r.amount_applied != null && r.amount != null && r.amount_applied !== r.amount ? ` of ${money(r.amount)}` : ""} {r.method ?? ""}
                      <button onClick={() => void call(`/api/pos/claims/${d.id}/refunds/${r.id}`, "DELETE")} className="ml-1 align-middle hover:text-destructive" title="Unlink this refund"><X className="inline h-3 w-3" /></button></div>
                  ))}
                  <div className="flex flex-wrap gap-x-2">
                    {d.status === "open" && refunds.some((r) => !linked(d).has(Number(r.id))) && (
                      <select value="" onChange={(e) => e.target.value && void call(`/api/pos/claims/${d.id}/refunds`, "POST", { refund_id: Number(e.target.value) })} className="h-6 max-w-[9rem] rounded border border-input bg-background px-1 text-[10px]" data-testid={`select-claim-link-refund-${d.id}`}>
                        <option value="">link refund…</option>
                        {refunds.filter((r) => !linked(d).has(Number(r.id))).map((r) => <option key={r.id} value={r.id}>{money(r.amount)} {r.method ?? ""}{r.note ? ` — ${r.note}` : ""}</option>)}
                      </select>
                    )}
                    {d.status === "open" && !d.outcome && <button onClick={() => setActing({ id: d.id, kind: "refund", text: "refund_card" })} className={link} data-testid={`button-claim-refund-${d.id}`}>refund / credit…</button>}
                    {d.status === "open" && <button onClick={() => setActing({ id: d.id, kind: "replacement", text: "" })} className={link} data-testid={`button-claim-replacement-${d.id}`}>replacement…</button>}
                    {d.status === "open" && <button onClick={() => setActing({ id: d.id, kind: "write_off", text: "" })} className={link} data-testid={`button-claim-write-off-${d.id}`}>write off…</button>}
                    {d.status === "open" && <button onClick={() => void call(`/api/pos/claims/${d.id}/dismiss`, "POST", {})} className={link} data-testid={`button-claim-dismiss-${d.id}`}>dismiss</button>}
                    {d.status !== "open" && <button onClick={() => void call(`/api/pos/claims/${d.id}/reopen`, "POST")} className={link} data-testid={`button-claim-reopen-${d.id}`}>reopen</button>}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => { if (window.confirm("Remove this claim?")) void call(`/api/pos/claims/${d.id}`, "DELETE"); }} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-remove-claim-${d.id}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
              {acting?.id === d.id && (
                <tr style={hairline} data-testid={`claim-acting-${d.id}`}>
                  <td colSpan={8} className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {acting.kind === "refund" ? (
                        <><span className="text-muted-foreground">Promised as</span>
                          <select value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid={`select-claim-outcome-${d.id}`}>
                            {(["refund_card", "gift_card", "store_credit"] as const).map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o]}</option>)}</select>
                          <Button size="sm" variant="outline" className="h-7" data-testid={`button-claim-outcome-save-${d.id}`} onClick={() => void call(`/api/pos/claims/${d.id}/outcome`, "POST", { outcome: acting.text }).then(() => setActing(null))}>Set outcome</Button></>
                      ) : (
                        <><span className="text-muted-foreground">{acting.kind === "replacement" ? "Replacement: units coming (blank = the claim's qty); tick arrived if it is here" : "Write-off reason"}</span>
                          <Input autoFocus value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} className="h-7 w-64 text-xs" data-testid={`input-claim-${acting.kind}-${d.id}`} />
                          {acting.kind === "replacement" && <label className="inline-flex items-center gap-1"><input type="checkbox" id={`arrived-${d.id}`} data-testid={`checkbox-claim-replacement-arrived-${d.id}`} /> arrived</label>}
                          <Button size="sm" variant="outline" className="h-7" disabled={acting.kind === "write_off" && !acting.text.trim()} data-testid={`button-claim-${acting.kind}-save-${d.id}`}
                            onClick={() => void call(`/api/pos/claims/${d.id}/outcome`, "POST", acting.kind === "replacement"
                              ? { outcome: "replacement", qty: acting.text.trim() || null, arrived: (document.getElementById(`arrived-${d.id}`) as HTMLInputElement | null)?.checked === true }
                              : { outcome: "write_off", reason: acting.text.trim() }).then(() => setActing(null))}>
                            {acting.kind === "replacement" ? "Set replacement" : "Write off"}</Button></>
                      )}
                      <button onClick={() => setActing(null)} className={link}>cancel</button>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-end gap-2" data-testid="po-add-claim">
        <select value={add.po_line_item_id} onChange={(e) => setAdd({ ...add, po_line_item_id: e.target.value })} className="h-8 max-w-[20rem] rounded border border-input bg-background px-1 text-xs" data-testid="select-add-claim-line">
          <option value="">whole PO…</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.asin} line {l.lineNo} — {l.product_name ?? ""}</option>)}
        </select>
        <select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as ClaimKind })} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid="select-add-claim-kind">
          {CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}
        </select>
        {/* D16: the qty is typed in Individual units; the Product / ASIN equivalents show beside the field. */}
        <label className="flex flex-col">
          <span className="text-[9px] leading-tight text-muted-foreground">{legacy ? "Product units (pack not known)" : QTY_KIND.individual}</span>
          <Input value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} placeholder="qty" className="h-8 w-16 text-right text-xs" data-testid="input-add-claim-qty" />
        </label>
        <span className="text-[10px] text-muted-foreground min-w-[7rem]" data-testid="add-claim-equivalents">{line && !legacy && qtyN ? qtyEquivalents(qtyN, line.retailer_units_per_product, line.asinPack) : ""}</span>
        <Input value={add.amount_owed} onChange={(e) => setAdd({ ...add, amount_owed: e.target.value })} placeholder={proposed != null ? proposed.toFixed(2) : "$"} title="Blank = qty × the line's cost per Individual unit (auto)" className="h-8 w-20 text-right text-xs" data-testid="input-add-claim-amount" />
        <Input value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} placeholder="note" className="h-8 w-48 text-xs" data-testid="input-add-claim-note" />
        <Button size="sm" variant="outline" disabled={!(Number(add.qty) > 0) || (!add.po_line_item_id && !add.amount_owed.trim())} title={!add.po_line_item_id ? "A whole-PO claim needs the $ owed typed" : undefined} data-testid="button-add-claim"
          onClick={() => void call(`/api/pos/${po.id}/claims`, "POST", { po_line_item_id: add.po_line_item_id || null, kind: add.kind, qty: add.qty, note: add.note || null, ...(add.amount_owed.trim() ? { amount_owed: add.amount_owed } : {}) })
            .then(() => setAdd({ ...add, qty: "", amount_owed: "", note: "" }))}><Plus className="h-3.5 w-3.5 mr-1" /> Claim</Button>
      </div>
    </section>
  );
}
