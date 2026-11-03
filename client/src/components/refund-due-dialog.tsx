/**
 * Expected refunds (SPEC §22 "Refunds: due and received", Dashboard patch
 * §2.3 C1). Two small dialogs on the shared frame:
 *
 * - RefundProposalDialog — after a cancel (the Products tab's Canceled cell
 *   or an ASIN row's "cancel"), one proposed DUE refund row per canceled
 *   line: qty × line price × (1 − PO discount ratio) + the line's tax share
 *   (shared/po-refund.ts), each amount editable (the calculator input) and
 *   each line ticked by default. "Skip" saves no row — the cancel already
 *   happened; the probe's "no $ amount" list shows it.
 * - MarkReceivedDialog — a due row becomes received: date (today), method,
 *   nickname, last 4, and the amount corrected to what actually arrived
 *   (the edit log records the change).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { MoneyCalcInput, calcMoney } from "@/components/money-calc-input";
import { poApi } from "@/components/po-edit";
import { proposeRefund } from "@shared/po-refund";
import { PAYMENT_METHODS } from "@shared/po-form";

/** The PO header money the proposal allocates with (subtotal / discount / tax); any may be missing. */
export interface PoHeaderMoney { id: string; subtotal?: string | number | null; discount?: string | number | null; tax?: string | number | null }

export interface CanceledLine { lineId: string; productName: string | null; qty: number; price: string | number | null }

/** Build the proposals for a set of canceled lines (pure; exported for tests). */
export function proposalsFor(po: PoHeaderMoney | undefined, lines: CanceledLine[]): Array<CanceledLine & { amount: string; allocated: boolean }> {
  return lines.filter((l) => l.qty > 0).map((l) => {
    const p = proposeRefund({ qty: l.qty, price: l.price, subtotal: po?.subtotal, discount: po?.discount, tax: po?.tax });
    return { ...l, amount: p.amount == null ? "" : String(p.amount), allocated: p.allocated };
  });
}

const money = (v: string) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—"; };

export function RefundProposalDialog({ po, lines, onClose, onSaved }: { po: PoHeaderMoney | undefined; lines: CanceledLine[]; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState(() => proposalsFor(po, lines).map((p) => ({ ...p, on: p.amount !== "" })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setRows(proposalsFor(po, lines).map((p) => ({ ...p, on: p.amount !== "" }))); }, [po, lines]);
  const open = lines.length > 0 && !!po;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      for (const r of rows) {
        if (!r.on) continue;
        const c = calcMoney(r.amount);
        if (!c.ok) throw new Error(`${r.productName ?? "line"}: can't calculate "${r.amount}"`);
        await poApi(`/api/pos/${po!.id}/refunds`, "POST", { po_line_item_id: r.lineId, qty: String(r.qty), amount: c.text, status: "due", note: "canceled — refund expected" });
      }
      onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const anyOn = rows.some((r) => r.on);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent dialogId="refund-due-proposal" className="max-w-xl" data-testid="refund-due-proposal">
        <DialogHeader>
          <DialogTitle>Refund due for the canceled items?</DialogTitle>
          <DialogDescription>
            {rows.some((r) => r.allocated) ? "Qty × price less the PO's discount share, plus its tax share — edit any amount before saving." : "Qty × price — the PO has no subtotal to allocate discount or tax from; edit the amount if needed."}
            {" "}Skip saves no row; the cancel stays.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {rows.map((r, i) => (
            <label key={r.lineId} className="flex items-center gap-3" data-testid={`refund-proposal-${r.lineId}`}>
              <input type="checkbox" checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <span className="flex-1 truncate" title={r.productName ?? ""}>{r.productName ?? r.lineId}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{r.qty} × {r.price != null ? money(String(r.price)) : "—"}</span>
              <MoneyCalcInput value={r.amount} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: v, on: true } : x)))} className="h-8 w-24 text-right font-mono text-xs" data-testid={`input-refund-proposal-${r.lineId}`} />
            </label>
          ))}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} data-testid="button-refund-proposal-skip">Skip</Button>
          <Button onClick={() => void save()} disabled={busy || !anyOn} data-testid="button-refund-proposal-save">{busy ? "Saving…" : `Add refund${rows.filter((r) => r.on).length === 1 ? "" : "s"} due`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DueRefundRow { id: number; amount: string | null; product_name?: string | null; qty?: number | string | null }

export function MarkReceivedDialog({ refund, onClose, onSaved }: { refund: DueRefundRow | null; onClose: () => void; onSaved: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ refunded_at: today, method: "card", nickname: "", last4: "", amount: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (refund) setForm({ refunded_at: today, method: "card", nickname: "", last4: "", amount: refund.amount == null ? "" : String(Number(refund.amount)) }); }, [refund?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!refund) return;
    setBusy(true); setErr(null);
    try {
      const c = calcMoney(form.amount);
      if (!c.ok) throw new Error(`Can't calculate "${form.amount}"`);
      await poApi(`/api/pos/refunds/${refund.id}`, "PATCH", { status: "received", refunded_at: form.refunded_at, method: form.method, nickname: form.nickname || null, last4: form.last4 || null, amount: c.text });
      onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!refund} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent dialogId="refund-mark-received" className="max-w-md" data-testid="refund-mark-received">
        <DialogHeader>
          <DialogTitle>Refund received</DialogTitle>
          <DialogDescription>{refund?.product_name ?? "PO-level refund"}{refund?.qty != null ? ` · ${refund.qty} unit${Number(refund.qty) === 1 ? "" : "s"}` : ""} — expected {refund?.amount != null ? money(String(refund.amount)) : "—"}. Correct the amount to what arrived.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Received on</span><input type="date" value={form.refunded_at} onChange={(e) => setForm({ ...form, refunded_at: e.target.value })} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" data-testid="input-refund-received-date" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Amount</span><MoneyCalcInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} className="h-8 text-right font-mono text-xs" data-testid="input-refund-received-amount" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Method</span><select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="h-8 w-full rounded border border-input bg-background px-1 text-xs" data-testid="select-refund-received-method">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Nickname</span><Input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="Amex" className="h-8 text-xs" data-testid="input-refund-received-nickname" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Last 4</span><Input value={form.last4} onChange={(e) => setForm({ ...form, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })} className="h-8 font-mono text-xs" data-testid="input-refund-received-last4" /></label>
          </div>
          {err && <p className="col-span-2 text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-testid="button-refund-received-save">{busy ? "Saving…" : "Mark received"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
