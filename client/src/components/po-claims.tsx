/**
 * Supplier claims — the pieces the PO pages share with the Claims page (SPEC §22 "Supplier claims" §5, commit 2):
 * the Individual-unit equivalents text, the PoClaim row type the PO detail payload carries, and **Open claim** — the
 * small form a product line opens (kind, qty in Individual units prefilled from the gap when AF knows it, $ owed
 * auto or typed, note). The per-PO section this file held in commit 1 is gone: claims live on /claims.
 */
import React, { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { poApi } from "@/components/po-edit";
import { useToast } from "@/hooks/use-toast";
import { fmtQty } from "@/lib/po-qty";
import { QTY_KIND } from "@shared/quantity-kinds";
import { CLAIM_KINDS, CLAIM_KIND_LABELS, claimAmount, individualEquivalents, type ClaimKind, type ClaimOutcome, type ClaimTaskKind } from "@shared/supplier-claim";

export interface PoClaim {
  id: number; po_line_item_id: string | null; kind: ClaimKind; /** Individual units; null = not known yet (counts toward nothing). */ qty: number | null; amount_owed: number | null; amount_owed_source: "auto" | "manual"; found_at: string; note: string | null;
  status: "suggested" | "open" | "closed" | "dismissed"; outcome: ClaimOutcome | null; outcome_amount: number | null; write_off_reason: string | null; closed_at: string | null;
  asin: string | null; product_name: string | null; line_no: number; product_pack: number | null; asin_pack: number | null; qty_basis: string | null;
  refunds: Array<{ id: number; amount: number | null; amount_applied: number | null; refunded_at: string | null; method: string | null }>;
  tasks: Array<{ id: number; kind: ClaimTaskKind; group: string; reason: string | null; done_at: string | null }>;
  conversion_flags?: string[];
  owed: number | null; remaining: number | null; received: number;
}

/** "2 Product u. · 6 ASIN u." — the equivalents beside a typed Individual quantity (D16). */
export function qtyEquivalents(individual: number | null, productPack: number | string | null | undefined, asinPack: number | string | null | undefined): string {
  const e = individualEquivalents(individual, productPack, asinPack);
  return [e.product != null ? `${fmtQty(e.product)} Product u.` : null, e.asin != null ? `${fmtQty(e.asin)} ASIN u.` : null].filter(Boolean).join(" · ");
}

export interface OpenClaimLine { id: string; product_name: string | null; retailer_units_per_product: number | string | null; qty_basis: string | null; price: string | number | null; adjusted_product_cost: string | number | null }
export interface OpenClaimPoMoney { subtotal?: string | number | null; discount?: string | number | null; tax?: string | number | null; sh_donations?: string | number | null }

/**
 * The Open claim form (§5): kind · qty (Individual units; a product_legacy line's Product units) with the equivalents · $ owed
 * (blank = auto from the line's cost per Individual unit) · note · return required. POST /api/pos/:id/claims.
 */
export function OpenClaimForm({ poId, line, asinPack, gap, po, onOpened, onCancel }: {
  poId: string; line: OpenClaimLine; asinPack: number | string | null | undefined; /** Individual units AF expects are missing, when known. */ gap?: number | null; po?: OpenClaimPoMoney;
  onOpened?: (claimId: number) => void; onCancel?: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<ClaimKind>("missing");
  const [qty, setQty] = useState(gap != null && gap > 0 ? String(gap) : "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [returnRequired, setReturnRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const legacy = line.qty_basis === "product_legacy";
  const qtyN = Number(qty) > 0 ? Number(qty) : null;
  const proposed = qtyN ? claimAmount({ qty: qtyN, productPack: legacy ? 1 : line.retailer_units_per_product, adjustedProductCost: line.adjusted_product_cost, price: line.price, subtotal: po?.subtotal, discount: po?.discount, tax: po?.tax, shipping: po?.sh_donations }) : null;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await poApi(`/api/pos/${poId}/claims`, "POST", { po_line_item_id: line.id, kind, qty, note: note.trim() || null, return_required: returnRequired, ...(amount.trim() ? { amount_owed: amount } : {}) });
      toast({ title: "Claim opened", description: `${qty} ${legacy ? "Product" : "Individual"} units ${CLAIM_KIND_LABELS[kind]} — Contact supplier is the next task` });
      onOpened?.(Number(r?.id));
    } catch (e: any) { toast({ title: "Claim not opened", description: e.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 text-xs" data-testid="open-claim-form">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Open claim</div>
      <div className="truncate text-muted-foreground" title={line.product_name ?? ""}>{line.product_name ?? "this line"}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col"><span className="text-[9px] leading-tight text-muted-foreground">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ClaimKind)} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid="select-open-claim-kind">
            {CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select></label>
        {/* D16: typed in Individual units; the Product / ASIN equivalents beside it. */}
        <label className="flex flex-col"><span className="text-[9px] leading-tight text-muted-foreground">{legacy ? "Product units (pack not known)" : QTY_KIND.individual}</span>
          <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className="h-8 w-16 text-right text-xs" data-testid="input-open-claim-qty" /></label>
        <span className="text-[10px] text-muted-foreground min-w-[7rem] pb-2" data-testid="open-claim-equivalents">{!legacy && qtyN ? qtyEquivalents(qtyN, line.retailer_units_per_product, asinPack) : ""}{gap != null && gap > 0 ? <span className="block">gap: {fmtQty(gap)} indiv. expected, not at Velocity</span> : null}</span>
        <label className="flex flex-col"><span className="text-[9px] leading-tight text-muted-foreground">$ owed</span>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={proposed != null ? proposed.toFixed(2) : "auto"} title="Blank = qty × the line's cost per Individual unit (auto)" className="h-8 w-20 text-right text-xs" data-testid="input-open-claim-amount" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note" className="h-8 w-56 text-xs" data-testid="input-open-claim-note" />
        <label className="inline-flex items-center gap-1 text-[11px]"><input type="checkbox" checked={returnRequired} onChange={(e) => setReturnRequired(e.target.checked)} data-testid="checkbox-open-claim-return" /> return required</label>
        <Button size="sm" variant="outline" className="h-8" disabled={busy || !qtyN} onClick={() => void submit()} data-testid="button-open-claim-save">Open claim</Button>
        {onCancel && <button type="button" onClick={onCancel} className="text-[11px] text-muted-foreground hover:underline">cancel</button>}
      </div>
    </div>
  );
}

/** The line's "claim" control: a popover with the form. */
export function OpenClaimButton({ poId, line, asinPack, gap, po, onOpened }: { poId: string; line: OpenClaimLine; asinPack: number | string | null | undefined; gap?: number | null; po?: OpenClaimPoMoney; onOpened?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="text-[10px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 whitespace-nowrap" title="Open a supplier claim on this line (missing, damaged, wrong item, …)" data-testid={`button-open-claim-${line.id}`}>claim</button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-3" align="start" onClick={(e) => e.stopPropagation()}>
        <OpenClaimForm poId={poId} line={line} asinPack={asinPack} gap={gap} po={po} onOpened={() => { setOpen(false); onOpened?.(); }} onCancel={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
