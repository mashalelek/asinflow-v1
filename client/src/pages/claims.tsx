/**
 * Claims page (SPEC §22 "Supplier claims" §5, docs/claude_spec-patch-supplier-claims.md §3.2–3.5, §3.7; commit 2).
 *
 * /claims — bucket tabs with counts (Needs attention · Waiting on supplier · Waiting on shipment · Waiting on refund to
 * post · Waiting on Velocity · Closed, + Dismissed toggle). Needs attention is grouped Decide / Supplier / Velocity /
 * Money and arrivals / Timed out, each task a checkbox (or the control the tick needs: a report's date + channel, the
 * reship order #, a suggestion's Open / Dismiss, Snooze on Check on it; Enter quantity is typed, Refund received adds the
 * refund row). Rows: Supplier · PO · Kind · Qty (Individual units, Product / ASIN in grey) · $ owed / remaining · Step ·
 * Days in bucket · Next action; longest waiting first. Toolbar: Open claim (PO picker), filters supplier / kind / PO.
 * The Dashboard's Refunds due cell opens ?bucket=waiting_refund,waiting_supplier with the column's PO date range.
 *
 * /claims/:id — the claim: header (PO, supplier, kind, qty in the three unit kinds, $ owed with override and Reset to
 * auto), the step checklist, open tasks, the refunds table with Refund received (method prefilled from the PO's
 * payments; one refund across the PO's other open claims), linked emails / labels / tracking (placeholders until commits
 * 6–7), the timeline, actions (Set outcome · Write off · Write off remainder · Reopen · Dismiss).
 *
 * Quiet chrome (docs/UI_RULES.md): fixed table layout, content-sized widths, amber only for what needs a hand.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { InlineEdit, poApi } from "@/components/po-edit";
import { InlineNoteBox } from "@/components/inline-note";
import { OpenClaimForm, qtyEquivalents } from "@/components/po-claims";
import { useToast } from "@/hooks/use-toast";
import { replaceQuery } from "@/lib/list-scroll";
import { fmtQty } from "@/lib/po-qty";
import { QTY_KIND } from "@shared/quantity-kinds";
import { CLAIM_BUCKET_LABELS, CLAIM_BUCKET_TABS, TASK_GROUPS, TASK_GROUP_LABELS, isActiveTask, type ClaimBucket, type ClaimStep, type TaskGroup } from "@shared/claim-bucket";
import { CLAIM_KINDS, CLAIM_KIND_LABELS, CLAIM_OUTCOME_LABELS, CLAIM_TASK_GROUP, CLAIM_TASK_LABELS, QTY_UNKNOWN_LABEL, SHEET_ZEROED_LABEL, type ClaimKind, type ClaimOutcome, type ClaimTaskKind } from "@shared/supplier-claim";
import { PAYMENT_METHODS } from "@shared/po-form";

// ── Types (the API's ClaimPageRow / ClaimDetail) ─────────────────────────────

export interface ClaimTask { id: number; kind: ClaimTaskKind; group: string; reason: string | null; created_at: string; due_at: string | null; done_at: string | null; snoozed_until: string | null }
export interface ClaimRowApi {
  id: number; po_id: string; po_line_item_id: string | null; kind: ClaimKind; qty: number | null; amount_owed: number | null; amount_owed_source: "auto" | "manual";
  status: "suggested" | "open" | "closed" | "dismissed"; outcome: ClaimOutcome | null; outcome_amount: number | null; outcome_detail: string | null; write_off_reason: string | null;
  found_at: string; found_by: string; reported_at: string | null; reported_channel: string | null; supplier_confirmed_at: string | null; closed_at: string | null; note: string | null;
  replacement_qty: number | null; replacement_shipped_at: string | null; replacement_arrived_at: string | null; return_required: boolean; qty_disposed: number | null;
  supplier: string; order_id: string; order_date: string; ships_to: string | null; po_closed_at: string | null; alt_order_ids: string | null;
  asin: string | null; product_name: string | null; line_no: number; product_pack: number | null; asin_pack: number | null; qty_basis: string | null;
  refunds: Array<{ id: number; amount: number | null; amount_applied: number | null; refunded_at: string | null; method: string | null }>;
  tasks: ClaimTask[]; conversion_flags: string[]; owed: number | null; remaining: number | null; received: number;
  bucket: ClaimBucket; bucket_since: string | null; due_at: string | null; timed_out: boolean; days_in_bucket: number | null; steps: ClaimStep[]; step: string; next_action: string;
}
interface ClaimsResponse { claims: ClaimRowApi[]; counts: Record<ClaimBucket, number>; suppliers: string[]; kinds: string[]; swept: number }
interface ClaimDetailApi {
  claim: ClaimRowApi;
  po: { id: string; order_id: string; supplier: string; order_date: string; ships_to: string | null; closed_at: string | null; alt_order_ids: string | null; payments: Array<{ id: number; method: string; nickname: string | null; last4: string | null; amount: string | null }>; refunds: Array<{ id: number; amount: string | null; method: string | null; refunded_at: string | null; note: string | null; po_line_item_id: string | null }> };
  other_open_claims: Array<{ id: number; kind: string; asin: string | null; line_no: number; qty: number | null; remaining: number | null }>;
  events: Array<{ id: number; at: string; type: string; summary: string | null; by_name: string | null }>;
  linked: { documents: Array<{ id: number; type: string; file_name: string; drive_file_id: string | null }>; tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; direction: string | null; status: string | null }> };
}

// ── Pure helpers (exported for the tests) ────────────────────────────────────

export interface ClaimsUrlState { bucket: ClaimBucket[]; supplier: string; kind: string; po: string; from: string; to: string; dismissed: boolean }
const isBucket = (v: string): v is ClaimBucket => (CLAIM_BUCKET_TABS as readonly string[]).includes(v) || v === "dismissed";
/** ?bucket=a,b (several = a combined view, the Dashboard's Refunds due), supplier, kind, po (order # or id), from / to (PO date), dismissed=1. */
export function readClaimsUrl(search: string): ClaimsUrlState {
  const p = new URLSearchParams(search);
  const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const buckets = (p.get("bucket") ?? "").split(",").map((x) => x.trim()).filter(isBucket);
  return { bucket: buckets.length ? buckets : ["needs_attention"], supplier: p.get("supplier")?.trim() ?? "", kind: p.get("kind")?.trim() ?? "", po: p.get("po")?.trim() ?? "", from: ymd(p.get("from")), to: ymd(p.get("to")), dismissed: p.get("dismissed") === "1" };
}
export function writeClaimsUrl(s: ClaimsUrlState): string {
  const p = new URLSearchParams();
  if (!(s.bucket.length === 1 && s.bucket[0] === "needs_attention")) p.set("bucket", s.bucket.join(","));
  if (s.supplier) p.set("supplier", s.supplier);
  if (s.kind) p.set("kind", s.kind);
  if (s.po) p.set("po", s.po);
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  if (s.dismissed) p.set("dismissed", "1");
  const q = p.toString();
  return q ? `?${q}` : "";
}
/** The rows of a tab set, the PO date range applied (the Dashboard link), dismissed shown only on Closed with the toggle. */
export function rowsForView(rows: readonly ClaimRowApi[], s: ClaimsUrlState): ClaimRowApi[] {
  const set = new Set<string>(s.bucket);
  if (set.has("closed") && s.dismissed) set.add("dismissed");
  return rows.filter((r) => set.has(r.bucket) && (!s.from || r.order_date >= s.from) && (!s.to || r.order_date <= s.to));
}
/** Needs attention grouped by task group: a claim appears under each group where it has an open task. */
export function groupNeedsAttention(rows: readonly ClaimRowApi[]): Array<{ group: TaskGroup; rows: Array<{ claim: ClaimRowApi; tasks: ClaimTask[] }> }> {
  return TASK_GROUPS.map((group) => ({
    group,
    // the passive ticks (Refund received, Replacement arrived) never place a claim here; they show on the row wherever it sits
    rows: rows.map((claim) => ({ claim, tasks: claim.tasks.filter((t) => isActiveTask(t) && (CLAIM_TASK_GROUP[t.kind] ?? t.group) === group) })).filter((x) => x.tasks.length > 0),
  })).filter((g) => g.rows.length > 0);
}
export const money = (v: number | string | null | undefined) => (v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`);
const fmtDate = (iso: string | null | undefined) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
/** "unknown (sheet zeroed the line)" / "qty unknown" / the number. */
export function qtyText(c: Pick<ClaimRowApi, "qty" | "conversion_flags">): string {
  if (c.qty == null) return (c.conversion_flags ?? []).includes("canceled_no_ordered_qty") ? SHEET_ZEROED_LABEL : QTY_UNKNOWN_LABEL;
  return fmtQty(c.qty);
}
/** The default method for a new refund row: the PO's first payment's method (§3.5 "method prefilled from the PO's payments"). */
export function prefillMethod(payments: ReadonlyArray<{ method: string }>): string { return payments[0]?.method ?? "card"; }

// ── Columns (docs/UI_RULES.md: fixed layout, content-sized defaults, a filler) ──

export const CLAIM_COLUMNS: ReadonlyArray<{ id: string; label: string; width: number; align?: "right"; kind?: string }> = [
  { id: "supplier", label: "Supplier", width: 150 },
  { id: "po", label: "PO", width: 170 },
  { id: "kind", label: "Kind", width: 96 },
  { id: "qty", label: "Qty", width: 120, align: "right", kind: QTY_KIND.individual },
  { id: "owed", label: "$ owed / remaining", width: 130, align: "right" },
  { id: "step", label: "Step", width: 120 },
  { id: "days", label: "Days in bucket", width: 90, align: "right" },
  { id: "next", label: "Next action", width: 250 },
];
export const CLAIMS_TABLE_WIDTH = CLAIM_COLUMNS.reduce((t, c) => t + c.width, 0); // 1,126 px, inside 1280 − the page padding

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
const th = "px-3 py-2 text-xs font-medium text-left align-bottom overflow-hidden";
const link = "text-[11px] underline-offset-2 hover:underline text-muted-foreground hover:text-foreground";

// ── Task controls (shared by the Needs attention groups and the detail) ──────

/** One open task: the tick, or the control the tick needs. `refresh` reloads the page's data. */
function TaskControl({ claim, task, refresh, onRefundReceived }: { claim: ClaimRowApi; task: ClaimTask; refresh: () => void; onRefundReceived: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [qty, setQty] = useState("");
  const call = async (url: string, body?: unknown) => { try { await poApi(url, "POST", body); refresh(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } };
  const label = CLAIM_TASK_LABELS[task.kind] ?? task.kind;
  // the reason: one muted line, truncated, the full text on hover (docs/UI_RULES.md 4)
  const reason = task.reason ? <span className="block max-w-[14rem] truncate text-[10px] text-muted-foreground" title={task.reason}>{task.reason}</span> : null;
  const k = task.kind;
  if (k === "enter_quantity") return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}>
      <span className="inline-flex flex-col"><span>{label}</span>{reason}</span>
      <label className="inline-flex flex-col"><span className="text-[9px] leading-tight text-muted-foreground">{claim.qty_basis === "product_legacy" ? "Product units" : QTY_KIND.individual}</span>
        <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className="h-7 w-16 text-right text-xs" data-testid={`input-task-qty-${task.id}`} /></label>
      <span className="text-[10px] text-muted-foreground">{Number(qty) > 0 && claim.qty_basis !== "product_legacy" ? qtyEquivalents(Number(qty), claim.product_pack, claim.asin_pack) : ""}</span>
      <Button size="sm" variant="outline" className="h-7" disabled={!(Number(qty) > 0)} onClick={async () => { try { await poApi(`/api/pos/claims/${claim.id}`, "PATCH", { qty }); refresh(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } }} data-testid={`button-task-qty-${task.id}`}>Save</Button>
    </span>);
  if (k === "refund_received") return <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}><span className="inline-flex flex-col"><span>{label}</span>{reason}</span><Button size="sm" variant="outline" className="h-7" onClick={onRefundReceived} data-testid={`button-task-refund-${task.id}`}>Add the refund…</Button></span>;
  if (k === "review_suggestion") return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}><span className="inline-flex flex-col"><span>{label}</span>{reason}</span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => void call(`/api/pos/claims/tasks/${task.id}/done`, { decision: "open" })} data-testid={`button-task-open-${task.id}`}>Open</Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => void call(`/api/pos/claims/tasks/${task.id}/done`, { decision: "dismiss" })} data-testid={`button-task-dismiss-${task.id}`}>Dismiss</Button></span>);
  if (k === "contact_supplier" || k === "follow_up_supplier") return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}>
      <span className="inline-flex flex-col"><label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={false} onChange={() => setForm(form ? null : { date: new Date().toISOString().slice(0, 10), channel: "email", note: "" })} data-testid={`checkbox-task-${task.id}`} />{label}</label>{reason}</span>
      {form && <>
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid={`input-task-date-${task.id}`} />
        <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid={`select-task-channel-${task.id}`}>
          {["email", "chat", "phone", "form", "other"].map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="note" className="h-7 w-40 text-xs" data-testid={`input-task-note-${task.id}`} />
        <Button size="sm" variant="outline" className="h-7" onClick={() => void call(`/api/pos/claims/tasks/${task.id}/done`, form)} data-testid={`button-task-save-${task.id}`}>{k === "contact_supplier" ? "Reported" : "Followed up"}</Button>
      </>}
    </span>);
  if (k === "confirm_reship_order") return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}><span className="inline-flex flex-col"><span>{label}</span>{reason}</span>
      <Input value={form?.alt ?? ""} onChange={(e) => setForm({ alt: e.target.value })} placeholder="order #" className="h-7 w-36 text-xs font-mono" data-testid={`input-task-alt-${task.id}`} />
      <Button size="sm" variant="outline" className="h-7" disabled={!form?.alt?.trim()} onClick={() => void call(`/api/pos/claims/tasks/${task.id}/done`, { alt_order_id: form?.alt })} data-testid={`button-task-alt-${task.id}`}>Add</Button></span>);
  if (k === "confirm_outcome") return <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}><span className="inline-flex flex-col"><span>{label}</span>{reason}</span><Link href={`/claims/${claim.id}`} className={link}>set it on the claim</Link></span>;
  if (k === "check_on_it") return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`task-${task.id}`}>
      <span className="inline-flex flex-col"><label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={false} onChange={() => void call(`/api/pos/claims/tasks/${task.id}/done`, {})} data-testid={`checkbox-task-${task.id}`} />{label}</label>{reason}</span>
      <button type="button" onClick={() => void call(`/api/pos/claims/tasks/${task.id}/snooze`, { business_days: 5 })} className={link} title="Tick it and ask again in 5 business days" data-testid={`button-task-snooze-${task.id}`}>snooze 5 bd</button></span>);
  // send_label · tell_velocity_replacement · dispose_units · update_velocity_order · replacement_arrived · upload_return_label: a plain tick
  return <span className="inline-flex flex-col" data-testid={`task-${task.id}`}><label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={false} onChange={() => void call(`/api/pos/claims/tasks/${task.id}/done`, {})} data-testid={`checkbox-task-${task.id}`} />{label}</label>{reason}</span>;
}

// ── Refund received (D6; §3.5 one refund across several claims) ─────────────

function RefundReceivedForm({ claim, payments, others, onDone, onCancel }: { claim: ClaimRowApi; payments: ReadonlyArray<{ method: string; nickname: string | null; last4: string | null }>; others: ClaimDetailApi["other_open_claims"]; onDone: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const first = payments[0];
  const [f, setF] = useState({ amount: claim.remaining != null ? claim.remaining.toFixed(2) : "", method: prefillMethod(payments), refunded_at: new Date().toISOString().slice(0, 10), nickname: first?.nickname ?? "", last4: first?.last4 ?? "", note: "" });
  const [split, setSplit] = useState<Record<number, string>>({});
  const othersSum = Object.values(split).reduce((t, v) => t + (Number(v) || 0), 0);
  const mine = Math.round(((Number(f.amount) || 0) - othersSum) * 100) / 100;
  const submit = async () => {
    try {
      const body = { ...f, nickname: f.nickname || null, last4: f.last4 || null, note: f.note || null, split: Object.entries(split).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ claim_id: Number(id), amount: v })) };
      await poApi(`/api/pos/claims/${claim.id}/refund-received`, "POST", body);
      toast({ title: "Refund received", description: `${money(f.amount)} ${f.method.replace("_", " ")}${othersSum > 0 ? ` — ${money(mine)} to this claim, ${money(othersSum)} to the others` : ""}` });
      onDone();
    } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); }
  };
  return (
    <div className="rounded-md p-3 space-y-2 text-xs" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="refund-received-form">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Refund received</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Amount</span><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="h-8 w-24 text-right text-xs" data-testid="input-refund-amount" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Method</span>
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid="select-refund-method">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Date</span><input type="date" value={f.refunded_at} onChange={(e) => setF({ ...f, refunded_at: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs" data-testid="input-refund-date" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Card / credit name</span><Input value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} className="h-8 w-32 text-xs" data-testid="input-refund-nickname" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Last 4</span><Input value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} className="h-8 w-14 text-xs" data-testid="input-refund-last4" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Note</span><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="h-8 w-44 text-xs" data-testid="input-refund-note" /></label>
      </div>
      {others.length > 0 && (
        <div className="space-y-1" data-testid="refund-split">
          <div className="text-muted-foreground">One refund for several claims? Give the PO's other open claims their share; the rest ({money(mine)}) stays on this one.</div>
          {others.map((o) => (
            <label key={o.id} className="flex items-center gap-2">
              <span className="w-56 truncate">{o.asin ?? "whole PO"}{o.line_no ? ` line ${o.line_no}` : ""} · {o.qty ?? "?"} {CLAIM_KIND_LABELS[o.kind as ClaimKind] ?? o.kind} · {money(o.remaining)} owed</span>
              <Input value={split[o.id] ?? ""} onChange={(e) => setSplit({ ...split, [o.id]: e.target.value })} placeholder="$" className="h-7 w-20 text-right text-xs" data-testid={`input-split-${o.id}`} />
            </label>))}
        </div>)}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-8" disabled={!(Number(f.amount) > 0) || mine < 0} onClick={() => void submit()} data-testid="button-refund-save">Refund received</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
        {claim.remaining != null && Number(f.amount) > 0 && mine < claim.remaining - 0.005 && <span className="text-amber-700 dark:text-amber-400">short by {money(claim.remaining - mine)} — the rest stays owed</span>}
      </div>
    </div>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────

function ClaimsList() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [s, setS] = useState<ClaimsUrlState>(() => readClaimsUrl(window.location.search));
  const [data, setData] = useState<ClaimsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [refundFor, setRefundFor] = useState<ClaimRowApi | null>(null);
  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (s.supplier) p.set("supplier", s.supplier);
    if (s.kind) p.set("kind", s.kind);
    if (s.po) p.set("po", s.po);
    try { const r = await fetch(`/api/claims?${p}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); setData(await r.json()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [s.supplier, s.kind, s.po]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { replaceQuery("/claims", writeClaimsUrl(s)); }, [s]);
  const rows = useMemo(() => (data ? rowsForView(data.claims, s) : []), [data, s]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of data?.claims ?? []) if ((!s.from || r.order_date >= s.from) && (!s.to || r.order_date <= s.to)) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, [data, s.from, s.to]);
  const setBucket = (b: ClaimBucket) => setS({ ...s, bucket: [b] });
  const combined = s.bucket.length > 1;
  const needsAttention = s.bucket.length === 1 && s.bucket[0] === "needs_attention";
  const groups = useMemo(() => (needsAttention ? groupNeedsAttention(rows) : []), [rows, needsAttention]);

  return (
    <div className="px-6 py-4 space-y-4" data-testid="claims-page">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Claims</h1>
          <p className="text-sm text-muted-foreground">Supplier problems on PO lines: what is missing, damaged, wrong, never came or was canceled — and the money owed back.{data?.swept ? ` ${data.swept} timer${data.swept === 1 ? "" : "s"} ran out since the last look.` : ""}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpening(true)} data-testid="button-open-claim"><Plus className="h-4 w-4 mr-1" /> Open claim</Button>
      </div>

      {/* Toolbar: supplier · kind · PO (order # or id) · the PO date range the Dashboard link carries */}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={s.supplier} onChange={(e) => setS({ ...s, supplier: e.target.value })} className="h-8 w-[180px] rounded border border-input bg-background px-1 text-xs" data-testid="select-claims-supplier">
          <option value="">Supplier: any</option>{(data?.suppliers ?? []).map((x) => <option key={x} value={x}>{x}</option>)}</select>
        <select value={s.kind} onChange={(e) => setS({ ...s, kind: e.target.value })} className="h-8 w-[150px] rounded border border-input bg-background px-1 text-xs" data-testid="select-claims-kind">
          <option value="">Kind: any</option>{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select>
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={s.po} onChange={(e) => setS({ ...s, po: e.target.value })} placeholder="PO order #" className="h-8 w-[200px] pl-8 text-sm font-mono" data-testid="input-claims-po" />
        </div>
        {(s.from || s.to) && <span className="text-xs text-muted-foreground" data-testid="claims-date-range">POs dated {s.from || "…"} to {s.to || "…"} <button type="button" onClick={() => setS({ ...s, from: "", to: "" })} className={link}>clear</button></span>}
      </div>

      {/* Bucket tabs with counts; several at once = the Dashboard's Refunds due view */}
      <div className="flex gap-1 flex-wrap items-end" style={{ borderBottom: "0.5px solid hsl(var(--border))" }} data-testid="claims-tabs">
        {CLAIM_BUCKET_TABS.map((b) => (
          <button key={b} onClick={() => setBucket(b)} data-testid={`tab-claims-${b}`}
            className={`px-3 py-1.5 text-sm -mb-px whitespace-nowrap ${s.bucket.includes(b) ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}>
            {CLAIM_BUCKET_LABELS[b]} <span className="text-xs text-muted-foreground tabular-nums" data-testid={`count-claims-${b}`}>{counts[b] ?? 0}</span>
          </button>))}
        {s.bucket.includes("closed") && (
          <label className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground pb-1.5"><input type="checkbox" checked={s.dismissed} onChange={(e) => setS({ ...s, dismissed: e.target.checked })} data-testid="toggle-claims-dismissed" /> show dismissed ({counts.dismissed ?? 0})</label>)}
        {combined && <span className="ml-auto text-xs text-muted-foreground pb-1.5" data-testid="claims-combined">Refunds due: {s.bucket.map((b) => CLAIM_BUCKET_LABELS[b]).join(" + ")}</span>}
      </div>

      {error && <div className="text-sm text-destructive" data-testid="text-claims-error">{error}</div>}
      {!data && !error && <div className="text-sm text-muted-foreground">Loading…</div>}

      {data && needsAttention && (
        <div className="space-y-4" data-testid="claims-needs-attention">
          {groups.length === 0 && <div className="text-sm text-muted-foreground">Nothing needs a hand.</div>}
          {groups.map((g) => (
            <section key={g.group} className="space-y-1" data-testid={`claims-group-${g.group}`}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{TASK_GROUP_LABELS[g.group]} <span className="font-normal tabular-nums">{g.rows.length}</span></h2>
              <ClaimsTable rows={g.rows.map((x) => x.claim)} onRow={(c) => navigate(`/claims/${c.id}`)}
                renderNext={(c) => <div className="space-y-1">{c.tasks.filter((t) => !t.done_at).map((t) => <div key={t.id}><TaskControl claim={c} task={t} refresh={() => void load()} onRefundReceived={() => setRefundFor(c)} /></div>)}</div>} />
            </section>))}
        </div>)}
      {data && !needsAttention && <ClaimsTable rows={rows} onRow={(c) => navigate(`/claims/${c.id}`)}
        renderNext={(c) => { const open = c.tasks.filter((t) => !t.done_at); return open.length
          ? <div className="space-y-1">{open.map((t) => <div key={t.id}><TaskControl claim={c} task={t} refresh={() => void load()} onRefundReceived={() => setRefundFor(c)} /></div>)}</div>
          : <span className="text-muted-foreground">{c.next_action || "—"}</span>; }} />}

      {refundFor && (
        <Dialog open onOpenChange={(v) => { if (!v) setRefundFor(null); }}>
          <DialogContent dialogId="claim-refund-received" className="max-w-2xl">
            <DialogHeader><DialogTitle className="text-base">{refundFor.supplier} {refundFor.order_id} · {refundFor.asin ?? "whole PO"} · {CLAIM_KIND_LABELS[refundFor.kind]}</DialogTitle><DialogDescription>Refund received for this claim (D6: your tick, one per refund row).</DialogDescription></DialogHeader>
            <RefundReceivedDialogBody claim={refundFor} onDone={() => { setRefundFor(null); void load(); }} onCancel={() => setRefundFor(null)} />
          </DialogContent>
        </Dialog>)}
      {opening && <OpenClaimDialog onClose={() => setOpening(false)} onOpened={(id) => { setOpening(false); toast({ title: "Claim opened" }); navigate(`/claims/${id}`); }} />}
    </div>
  );
}

/** The refund form on the list needs the PO's payments and other open claims: fetched from the claim's detail. */
function RefundReceivedDialogBody({ claim, onDone, onCancel }: { claim: ClaimRowApi; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<ClaimDetailApi | null>(null);
  useEffect(() => { fetch(`/api/claims/${claim.id}`).then((r) => r.json()).then(setD).catch(() => setD(null)); }, [claim.id]);
  if (!d) return <div className="text-sm text-muted-foreground">Loading…</div>;
  return <RefundReceivedForm claim={d.claim} payments={d.po.payments} others={d.other_open_claims} onDone={onDone} onCancel={onCancel} />;
}

function ClaimsTable({ rows, onRow, renderNext }: { rows: ClaimRowApi[]; onRow: (c: ClaimRowApi) => void; renderNext?: (c: ClaimRowApi) => React.ReactNode }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="border-collapse text-sm table-fixed" style={{ width: CLAIMS_TABLE_WIDTH, minWidth: "100%" }} data-testid="claims-table">
        <colgroup>{CLAIM_COLUMNS.map((c) => <col key={c.id} style={{ width: c.width }} />)}<col /></colgroup>
        <thead><tr className="table-header-stone">
          {CLAIM_COLUMNS.map((c) => <th key={c.id} className={`${th} ${c.align === "right" ? "text-right" : ""}`} style={{ width: c.width }} data-testid={`th-claims-${c.id}`}>
            {c.kind && <span className="block text-[9px] font-normal opacity-60">{c.kind}</span>}{c.label}</th>)}
          <th aria-hidden />
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={CLAIM_COLUMNS.length + 1} className="px-3 py-3 text-xs text-muted-foreground">No claims here.</td></tr>}
          {rows.map((c) => (
            <tr key={c.id} className="table-zebra-stone cursor-pointer hover:bg-muted/40 align-top" style={hairline} onClick={() => onRow(c)} data-testid={`row-claim-${c.id}`}>
              <td className="px-3 py-2 truncate" title={c.supplier}>{c.supplier}</td>
              <td className="px-3 py-2 min-w-0" onClick={(e) => e.stopPropagation()}>
                <Link href={`/purchase-orders/${c.po_id}`} className="font-mono text-xs hover:underline block truncate" title={c.order_id}>{c.order_id}</Link>
                <div className="truncate text-[11px] text-muted-foreground" title={`${c.asin ?? "whole PO"}${c.product_name ? ` — ${c.product_name}` : ""}`}>{c.asin ?? "whole PO"}{c.po_line_item_id ? ` line ${c.line_no}` : ""}{c.product_name ? ` — ${c.product_name}` : ""}</div>
              </td>
              <td className="px-3 py-2 text-xs">{CLAIM_KIND_LABELS[c.kind]}{c.outcome ? <div className="text-[10px] text-muted-foreground">{CLAIM_OUTCOME_LABELS[c.outcome]}</div> : null}</td>
              <td className={`px-3 py-2 text-right ${c.qty == null ? "text-amber-700 dark:text-amber-400 text-xs" : ""}`} data-testid={`claim-qty-${c.id}`}>
                {qtyText(c)}
                {c.qty != null && <div className="text-[10px] text-muted-foreground whitespace-nowrap">{c.qty_basis === "product_legacy" ? "Product u. (pack not known)" : qtyEquivalents(c.qty, c.product_pack, c.asin_pack)}</div>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{money(c.amount_owed)}{c.status === "open" && c.remaining != null && c.remaining !== c.amount_owed ? <div className="text-[10px] font-sans text-muted-foreground">{money(c.remaining)} remaining</div> : null}</td>
              <td className="px-3 py-2 text-xs truncate" title={c.step}>{c.step}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums" title={c.bucket_since ? `since ${fmtDate(c.bucket_since)}${c.due_at ? ` · timer runs out ${fmtDate(c.due_at)}` : ""}` : ""}>{c.days_in_bucket ?? "—"}</td>
              <td className="px-3 py-2 text-xs" onClick={(e) => e.stopPropagation()}>{renderNext ? renderNext(c) : <span className={c.tasks.some((t) => !t.done_at) ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{c.next_action || "—"}</span>}</td>
              <td aria-hidden />
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

// ── Open claim with a PO picker ──────────────────────────────────────────────

interface PickedRow { id: string; po_id: string; asin: string; asin_name: string | null; order_id: string; supplier: string; order_date: string; ships_to: string | null; closed: boolean; units_per_pack: number | null }
function OpenClaimDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (claimId: number) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PickedRow[]>([]);
  const [picked, setPicked] = useState<PickedRow | null>(null);
  const [po, setPo] = useState<{ po: Record<string, any>; asins: Array<{ id: string; asin: string; units_per_pack: number | null; lines: Array<any> }> } | null>(null);
  const [lineId, setLineId] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const h = setTimeout(() => { fetch(`/api/pos/asin-rows/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => setRows([])); }, 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (!picked) { setPo(null); return; }
    fetch(`/api/pos/${picked.po_id}`).then((r) => r.json()).then((d) => { setPo(d); const a = d.asins.find((x: any) => String(x.id) === String(picked.id)); setLineId(a?.lines?.[0]?.id ? String(a.lines[0].id) : ""); }).catch(() => setPo(null));
  }, [picked]);
  const asin = po?.asins.find((x) => String(x.id) === String(picked?.id));
  const line = asin?.lines.find((l) => String(l.id) === lineId);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent dialogId="claim-open" className="max-w-2xl" data-testid="dialog-open-claim">
        <DialogHeader><DialogTitle className="text-base">Open claim</DialogTitle><DialogDescription>Find the PO by order #, ASIN or supplier, pick the line, then the kind and the quantity (Individual units).</DialogDescription></DialogHeader>
        {!picked ? (
          <div className="space-y-2">
            <div className="relative"><Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, ASIN or supplier" className="h-8 pl-8 text-sm" data-testid="input-po-picker" /></div>
            <div className="max-h-72 overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
              {rows.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">{q.trim().length < 2 ? "Type at least two characters." : "No PO matches."}</div>}
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setPicked(r)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-3" style={hairline} data-testid={`po-picker-row-${r.id}`}>
                  <span className="font-mono w-40 truncate">{r.order_id}</span><span className="w-32 truncate">{r.supplier}</span><span className="w-20">{fmtDate(r.order_date)}</span><span className="font-mono">{r.asin}</span><span className="truncate text-muted-foreground">{r.asin_name}</span>{r.closed && <span className="ml-auto text-muted-foreground">closed</span>}
                </button>))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs"><span className="font-mono">{picked.order_id}</span> · {picked.supplier} · {fmtDate(picked.order_date)} · <span className="font-mono">{picked.asin}</span> <button type="button" onClick={() => setPicked(null)} className={link}>change</button></div>
            {!po && <div className="text-xs text-muted-foreground">Loading the PO…</div>}
            {po && asin && (asin.lines.length > 1 ? (
              <select value={lineId} onChange={(e) => setLineId(e.target.value)} className="h-8 max-w-[28rem] rounded border border-input bg-background px-1 text-xs" data-testid="select-open-claim-line">
                {asin.lines.map((l: any, i: number) => <option key={l.id} value={l.id}>line {i + 1} — {l.product_name ?? ""}</option>)}</select>) : null)}
            {po && asin && line && <OpenClaimForm poId={po.po.id} line={{ id: String(line.id), product_name: line.product_name, retailer_units_per_product: line.retailer_units_per_product ?? null, qty_basis: line.qty_basis ?? null, price: line.price, adjusted_product_cost: line.adjusted_product_cost }} asinPack={asin.units_per_pack} po={po.po} onOpened={onOpened} onCancel={onClose} />}
            {po && asin && asin.lines.length === 0 && <div className="text-xs text-muted-foreground">This ASIN row has no product line to claim on.</div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Claim detail ─────────────────────────────────────────────────────────────

function ClaimDetailPage({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [d, setD] = useState<ClaimDetailApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refund, setRefund] = useState(false);
  const [acting, setActing] = useState<{ kind: "outcome" | "write_off" | "remainder" | "dismiss" | "confirm"; text: string; outcome: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`/api/claims/${id}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); setD(await r.json()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const call = async (url: string, method: string, body?: unknown) => { try { await poApi(url, method, body); await load(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } };
  if (error) return <div className="px-6 py-8 space-y-3"><Link href="/claims" className="text-sm text-primary hover:underline">← Back to Claims</Link><p className="text-sm text-destructive">{error}</p></div>;
  if (!d) return <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>;
  const c = d.claim;
  const openTasks = c.tasks.filter((t) => !t.done_at);
  const eq = c.qty != null && c.qty_basis !== "product_legacy" ? qtyEquivalents(c.qty, c.product_pack, c.asin_pack) : "";
  const dl = "text-muted-foreground whitespace-nowrap";
  return (
    <div className="px-6 py-4 space-y-4" data-testid="claim-detail">
      <Link href="/claims" className="text-sm text-primary hover:underline" data-testid="button-back-to-claims">← Back to Claims</Link>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-claim-title">{CLAIM_KIND_LABELS[c.kind]} · <Link href={`/purchase-orders/${c.po_id}`} className="font-mono hover:underline">{c.order_id}</Link></h1>
          <p className="text-sm text-muted-foreground">{c.supplier} · PO dated {fmtDate(c.order_date)} · {c.asin ?? "whole PO"}{c.po_line_item_id ? ` line ${c.line_no}` : ""}{c.product_name ? ` — ${c.product_name}` : ""} · {CLAIM_BUCKET_LABELS[c.bucket]}{c.days_in_bucket != null && c.status === "open" ? ` for ${c.days_in_bucket} day${c.days_in_bucket === 1 ? "" : "s"}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="claim-actions">
          {c.status === "open" && !c.outcome && <Button size="sm" variant="outline" onClick={() => setActing({ kind: "outcome", text: "", outcome: "refund_card" })} data-testid="button-claim-set-outcome">Set outcome</Button>}
          {c.status === "open" && c.outcome && c.outcome !== "write_off" && !c.supplier_confirmed_at && <Button size="sm" variant="outline" onClick={() => setActing({ kind: "confirm", text: "", outcome: c.outcome! })} data-testid="button-claim-confirm">Confirmed by supplier</Button>}
          {c.status === "open" && <Button size="sm" variant="outline" onClick={() => setActing({ kind: "write_off", text: "", outcome: "" })} data-testid="button-claim-write-off">Write off</Button>}
          {c.status === "open" && c.received > 0 && c.remaining != null && c.remaining > 0 && <Button size="sm" variant="outline" onClick={() => setActing({ kind: "remainder", text: "", outcome: "" })} data-testid="button-claim-write-off-remainder">Write off remainder</Button>}
          {c.status === "open" && <Button size="sm" variant="ghost" onClick={() => setActing({ kind: "dismiss", text: "", outcome: "" })} data-testid="button-claim-dismiss">Dismiss</Button>}
          {c.status !== "open" && <Button size="sm" variant="outline" onClick={() => void call(`/api/pos/claims/${c.id}/reopen`, "POST")} data-testid="button-claim-reopen">Reopen</Button>}
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => { if (window.confirm("Remove this claim? Its History rows stay on the PO.")) void poApi(`/api/pos/claims/${c.id}`, "DELETE").then(() => navigate("/claims")); }} data-testid="button-claim-remove">Remove</Button>
        </div>
      </div>

      {acting && (
        <div className="rounded-md p-3 flex flex-wrap items-center gap-2 text-xs" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid={`claim-acting-${acting.kind}`}>
          {acting.kind === "outcome" && <>
            <span className="text-muted-foreground">Outcome (D3, one per claim)</span>
            <select value={acting.outcome} onChange={(e) => setActing({ ...acting, outcome: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-claim-outcome">
              {(["refund_card", "gift_card", "store_credit", "replacement"] as const).map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o]}</option>)}</select>
            {acting.outcome === "replacement" && <Input value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} placeholder="units coming (blank = the claim's qty)" className="h-7 w-56 text-xs" data-testid="input-claim-replacement-qty" />}
            <Button size="sm" variant="outline" className="h-7" onClick={() => void call(`/api/pos/claims/${c.id}/outcome`, "POST", acting.outcome === "replacement" ? { outcome: "replacement", qty: acting.text.trim() || null } : { outcome: acting.outcome }).then(() => setActing(null))} data-testid="button-claim-outcome-save">Set outcome</Button></>}
          {acting.kind === "confirm" && <>
            <span className="text-muted-foreground">The supplier confirmed the {CLAIM_OUTCOME_LABELS[acting.outcome as ClaimOutcome]} (by hand — the email match is a later commit)</span>
            <Input value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} placeholder="detail (optional)" className="h-7 w-56 text-xs" data-testid="input-claim-confirm-detail" />
            <Button size="sm" variant="outline" className="h-7" onClick={() => void call(`/api/pos/claims/${c.id}/confirm-supplier`, "POST", { detail: acting.text.trim() || null }).then(() => setActing(null))} data-testid="button-claim-confirm-save">Confirmed</Button></>}
          {(acting.kind === "write_off" || acting.kind === "remainder") && <>
            <span className="text-muted-foreground">{acting.kind === "remainder" ? `Write off the ${money(c.remaining)} still owed — reason` : "Write-off reason"}</span>
            <Input autoFocus value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} className="h-7 w-72 text-xs" data-testid={`input-claim-${acting.kind}-reason`} />
            <Button size="sm" variant="outline" className="h-7" disabled={!acting.text.trim()} onClick={() => void call(acting.kind === "remainder" ? `/api/pos/claims/${c.id}/write-off-remainder` : `/api/pos/claims/${c.id}/outcome`, "POST", acting.kind === "remainder" ? { reason: acting.text.trim() } : { outcome: "write_off", reason: acting.text.trim() }).then(() => setActing(null))} data-testid={`button-claim-${acting.kind}-save`}>Write off</Button></>}
          {acting.kind === "dismiss" && <>
            <span className="text-muted-foreground">Dismiss this claim (it never counts, never blocks)</span>
            <Input value={acting.text} onChange={(e) => setActing({ ...acting, text: e.target.value })} placeholder="why (optional)" className="h-7 w-56 text-xs" data-testid="input-claim-dismiss-reason" />
            <Button size="sm" variant="outline" className="h-7" onClick={() => void call(`/api/pos/claims/${c.id}/dismiss`, "POST", { reason: acting.text.trim() || null }).then(() => setActing(null))} data-testid="button-claim-dismiss-save">Dismiss</Button></>}
          <button type="button" onClick={() => setActing(null)} className={link}>cancel</button>
        </div>)}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* The claim */}
        <div className="rounded-md p-3 space-y-1.5 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="claim-card">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Claim</div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Kind</span>
            <select value={c.kind} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { kind: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-claim-kind">{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Qty <span className="text-[10px]">({c.qty_basis === "product_legacy" ? "Product units, pack not known" : QTY_KIND.individual})</span></span>
            <span className="text-right"><InlineEdit value={c.qty == null ? null : String(c.qty)} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { qty: v })} align="right" width="w-16" testId={`claim-qty-${c.id}`}>
              {c.qty == null ? <span className="text-amber-700 dark:text-amber-400 text-xs">{qtyText(c)}</span> : fmtQty(c.qty)}</InlineEdit>
              {eq && <div className="text-[10px] text-muted-foreground">{eq}</div>}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>$ owed <span className="text-[10px]">({c.amount_owed_source === "manual" ? "typed" : "auto: qty × cost per Individual unit"})</span></span>
            <span className="text-right"><InlineEdit money value={c.amount_owed == null ? null : String(c.amount_owed)} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: v })} align="right" width="w-20" testId={`claim-amount-${c.id}`}>{money(c.amount_owed)}</InlineEdit>
              {c.amount_owed_source === "manual" && <button type="button" onClick={() => void call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: "" })} className={`block ml-auto ${link}`} data-testid="button-claim-reset-auto">Reset to auto</button>}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Received</span><span className="font-mono text-xs">{money(c.received)}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Remaining</span><span className={`font-mono text-xs ${c.remaining != null && c.remaining > 0 && c.status === "open" ? "text-amber-700 dark:text-amber-400" : ""}`} data-testid="claim-remaining">{money(c.remaining)}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Status</span><span className="text-xs" data-testid="claim-status">{c.status}{c.outcome ? ` · ${CLAIM_OUTCOME_LABELS[c.outcome]}` : ""}{c.write_off_reason ? ` · written off: ${c.write_off_reason}` : ""}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Found</span><span className="text-xs">{fmtDate(c.found_at)} by {c.found_by}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Reported</span><span className="text-xs">{c.reported_at ? `${fmtDate(c.reported_at)}${c.reported_channel ? ` · ${c.reported_channel}` : ""}` : "—"}</span></div>
          <div className="flex items-baseline justify-between gap-3"><span className={dl}>Return required</span><label className="text-xs"><input type="checkbox" checked={c.return_required} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { return_required: e.target.checked })} data-testid="checkbox-claim-return" /></label></div>
          {c.conversion_flags.length > 0 && <div className="text-[10px] text-muted-foreground">converted from the sheet era: {c.conversion_flags.join(", ")}</div>}
          <div className="pt-1"><InlineNoteBox value={c.note} label="claim note" testId="claim-note" onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { note: v })} /></div>
        </div>

        {/* Steps + tasks */}
        <div className="rounded-md p-3 space-y-3 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Steps</div>
            <ol className="space-y-0.5" data-testid="claim-steps">
              {c.steps.map((s) => (
                <li key={s.key} className={`flex items-center gap-2 text-xs ${s.current ? "font-medium" : s.done ? "" : "text-muted-foreground"}`} data-testid={`step-${s.key}`} data-done={s.done} data-current={s.current}>
                  <span className={`inline-block w-3.5 text-center ${s.done ? "" : "opacity-40"}`}>{s.done ? "✓" : s.current ? "›" : "·"}</span>{s.label}{s.at ? <span className="text-[10px] text-muted-foreground">{fmtDate(s.at)}</span> : null}
                </li>))}
            </ol>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Open tasks</div>
            {openTasks.length === 0 ? <div className="text-xs text-muted-foreground">{c.status === "open" ? c.next_action || "none" : "none"}</div>
              : <div className="space-y-1.5 text-xs" data-testid="claim-open-tasks">{openTasks.map((t) => <div key={t.id}><TaskControl claim={c} task={t} refresh={() => void load()} onRefundReceived={() => setRefund(true)} /></div>)}</div>}
            {c.status === "open" && c.due_at && <div className="text-[10px] text-muted-foreground mt-1">timer: {c.timed_out ? "ran out" : `runs out ${fmtDate(c.due_at)}`} (5 business days)</div>}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Linked</div>
            <div className="text-xs text-muted-foreground space-y-0.5" data-testid="claim-linked">
              <div>Emails: <span className="opacity-70">none yet — supplier replies and refund confirmations attach from commit 6</span></div>
              <div>Labels: {d.linked.documents.length ? d.linked.documents.map((x) => <span key={x.id} className="font-mono">{x.file_name} </span>) : <span className="opacity-70">none — return labels from commit 7</span>}</div>
              <div>Tracking: {d.linked.tracking.length ? d.linked.tracking.map((t) => <span key={t.id} className="font-mono">{t.carrier} {t.tracking_number} ({t.direction ?? "outbound"}) </span>) : <span className="opacity-70">none linked</span>}</div>
              {c.alt_order_ids && <div>Alternate order #s: <span className="font-mono">{c.alt_order_ids}</span></div>}
            </div>
          </div>
        </div>

        {/* Refunds + timeline */}
        <div className="rounded-md p-3 space-y-3 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <div>
            <div className="flex items-baseline justify-between mb-1"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Refunds</div>
              {c.status === "open" && !refund && <button type="button" onClick={() => setRefund(true)} className={link} data-testid="button-claim-refund-received">Refund received…</button>}</div>
            <table className="w-full border-collapse text-xs" data-testid="claim-refunds">
              <thead><tr className="text-muted-foreground"><th className="text-left font-normal pb-0.5">Method</th><th className="text-right font-normal">Applied</th><th className="text-right font-normal">Date</th></tr></thead>
              <tbody>
                {c.refunds.length === 0 && <tr><td colSpan={3} className="text-muted-foreground/60 py-0.5">none yet</td></tr>}
                {c.refunds.map((r) => <tr key={r.id} data-testid={`claim-refund-${r.id}`}><td className="py-0.5">{(r.method ?? "refund").replace("_", " ")}</td><td className="text-right font-mono">{money(r.amount_applied ?? r.amount)}{r.amount_applied != null && r.amount != null && r.amount_applied !== r.amount ? <span className="text-muted-foreground"> of {money(r.amount)}</span> : null}</td><td className="text-right">{fmtDate(r.refunded_at)}</td></tr>)}
                <tr className="border-t border-border/60"><td className="pt-0.5 text-muted-foreground">remaining</td><td className="pt-0.5 text-right font-mono">{money(c.remaining)}</td><td /></tr>
              </tbody>
            </table>
            {refund && <div className="mt-2"><RefundReceivedForm claim={c} payments={d.po.payments} others={d.other_open_claims} onDone={() => { setRefund(false); void load(); }} onCancel={() => setRefund(false)} /></div>}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Timeline</div>
            <ol className="space-y-0.5 text-xs" data-testid="claim-timeline">
              {d.events.map((e) => <li key={e.id} className="flex gap-2"><span className="text-muted-foreground whitespace-nowrap tabular-nums">{fmtDate(e.at)}</span><span><span className="font-medium">{e.type.replace(/_/g, " ")}</span>{e.summary ? ` — ${e.summary}` : ""}{e.by_name ? <span className="text-muted-foreground"> · {e.by_name}</span> : null}</span></li>)}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Claims() {
  const params = useParams<{ id?: string }>();
  const id = params.id ? Number(params.id) : null;
  return id && Number.isFinite(id) ? <ClaimDetailPage id={id} /> : <ClaimsList />;
}
