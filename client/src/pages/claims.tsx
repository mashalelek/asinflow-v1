/**
 * Claims pages (SPEC §22 "Supplier claims" §5 amended 2026-11-12 — the mockups docs/mockups/claims-list-2026-11-12.html
 * and claim-detail-2026-11-12.html win over the prose; commit 2b). The server side (claims, tasks, buckets, timers,
 * refunds) stays as built; the words come from shared/claim-ui.ts.
 *
 * /claims — header: Refunds due $X · N open, a filter box (supplier, PO, ASIN…), a kind select, + Open claim (PO
 * picker). Bucket tabs with counts. Needs attention grouped Decide / Supplier / Velocity / Money and arrivals / Timed
 * out. Row: Supplier · PO · Product · Kind · Qty (Individual units, "of N") · Owed / left · Step (ONE plain sentence) ·
 * Waiting (days) · Do (ONE primary button for the task, plus Dismiss / Snooze where they apply).
 *
 * /claims/:id — header (kind · supplier · order #; PO line, qty, the state sentence, days open) + Contacted supplier ·
 * Supplier replied · Set outcome ▾ · More ▾. Left: the Claim facts, each editable in place; the Steps, every one
 * clickable to set or change its date / data; Linked. Middle: the Timeline, newest first, every entry editable, the
 * inline forms. Right: Refunds (+ Refund received, Write off remainder), What happens next, More.
 *
 * Rules: no outcome is needed to proceed; nothing says "waiting" before reported_at; every change writes an event and a
 * History row (the server does). Quiet chrome (docs/UI_RULES.md): fixed table layout, content-sized widths, amber only
 * for what needs a hand; quantity labels name their kind.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Plus, Search, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { InlineEdit, poApi } from "@/components/po-edit";
import { InlineNoteBox } from "@/components/inline-note";
import { OpenClaimForm, qtyEquivalents } from "@/components/po-claims";
import { useToast } from "@/hooks/use-toast";
import { replaceQuery } from "@/lib/list-scroll";
import { fmtQty } from "@/lib/po-qty";
import { QTY_KIND } from "@shared/quantity-kinds";
import { CLAIM_BUCKET_LABELS, CLAIM_BUCKET_TABS, TASK_GROUPS, TASK_GROUP_LABELS, type ClaimBucket, type ClaimStep, type TaskGroup } from "@shared/claim-bucket";
import { GROUP_HINTS, type PrimaryAction, type UiStep, type StepHandler } from "@shared/claim-ui";
import { CLAIM_KINDS, CLAIM_KIND_LABELS, CLAIM_OUTCOMES, CLAIM_OUTCOME_LABELS, QTY_UNKNOWN_LABEL, SHEET_ZEROED_LABEL, type ClaimKind, type ClaimOutcome, type ClaimTaskKind } from "@shared/supplier-claim";
import { PAYMENT_METHODS } from "@shared/po-form";

// ── Types (the API's ClaimPageRow / ClaimDetail) ─────────────────────────────

export interface ClaimTask { id: number; kind: ClaimTaskKind; group: string; reason: string | null; created_at: string; due_at: string | null; done_at: string | null; snoozed_until: string | null }
export interface ClaimRowApi {
  id: number; po_id: string; po_line_item_id: string | null; kind: ClaimKind; qty: number | null; amount_owed: number | null; amount_owed_source: "auto" | "manual";
  status: "suggested" | "open" | "closed" | "dismissed"; outcome: ClaimOutcome | null; outcome_amount: number | null; outcome_detail: string | null; write_off_reason: string | null;
  found_at: string; found_by: string; reported_at: string | null; reported_channel: string | null; supplier_confirmed_at: string | null; last_supplier_reply_at: string | null; closed_at: string | null; note: string | null;
  replacement_qty: number | null; replacement_shipped_at: string | null; replacement_arrived_at: string | null; return_required: boolean; qty_disposed: number | null;
  supplier: string; order_id: string; order_date: string; ships_to: string | null; po_closed_at: string | null; alt_order_ids: string | null;
  asin: string | null; product_name: string | null; line_no: number; ordered: number | null; product_pack: number | null; asin_pack: number | null; qty_basis: string | null;
  refunds: Array<{ id: number; amount: number | null; amount_applied: number | null; refunded_at: string | null; method: string | null }>;
  tasks: ClaimTask[]; conversion_flags: string[]; owed: number | null; remaining: number | null; received: number; source_items_json?: unknown;
  bucket: ClaimBucket; bucket_since: string | null; due_at: string | null; timed_out: boolean; days_in_bucket: number | null; days_open: number | null;
  steps: ClaimStep[]; step: string; next_action: string; sentence: string; action: PrimaryAction; group: TaskGroup | null; ui_steps: UiStep[]; next: Array<{ when: "Now" | "Then"; text: string }>;
}
interface ClaimsResponse { claims: ClaimRowApi[]; counts: Record<ClaimBucket, number>; suppliers: string[]; kinds: string[]; swept: number; header: { due: number; open: number } }
interface ClaimDetailApi {
  claim: ClaimRowApi;
  po: { id: string; order_id: string; supplier: string; order_date: string; ships_to: string | null; closed_at: string | null; alt_order_ids: string | null; payments: Array<{ id: number; method: string; nickname: string | null; last4: string | null; amount: string | null }>; refunds: Array<{ id: number; amount: string | null; method: string | null; refunded_at: string | null; note: string | null; po_line_item_id: string | null }> };
  other_open_claims: Array<{ id: number; kind: string; asin: string | null; line_no: number; qty: number | null; remaining: number | null }>;
  events: Array<{ id: number; at: string; type: string; summary: string | null; by_name: string | null }>;
  linked: {
    documents: Array<{ id: number; type: string; file_name: string; drive_file_id: string | null }>;
    tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; direction: string | null; status: string | null }>;
    po_tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; carrier_status: string | null; delivered_at: string | null }>;
    velocity: Array<{ velocity_order_id: string; asin: string }>;
    po_received_individual: number | null;
  };
}

// ── Pure helpers (exported for the tests) ────────────────────────────────────

export interface ClaimsUrlState { bucket: ClaimBucket[]; q: string; kind: string; from: string; to: string; dismissed: boolean }
const isBucket = (v: string): v is ClaimBucket => (CLAIM_BUCKET_TABS as readonly string[]).includes(v) || v === "dismissed";
/** ?bucket=a,b (several = a combined view, the Dashboard's Refunds due), q (supplier / PO / ASIN; `po=` and `supplier=` still read), kind, from / to (PO date), dismissed=1. */
export function readClaimsUrl(search: string): ClaimsUrlState {
  const p = new URLSearchParams(search);
  const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const buckets = (p.get("bucket") ?? "").split(",").map((x) => x.trim()).filter(isBucket);
  return { bucket: buckets.length ? buckets : ["needs_attention"], q: (p.get("q") ?? p.get("po") ?? p.get("supplier") ?? "").trim(), kind: p.get("kind")?.trim() ?? "", from: ymd(p.get("from")), to: ymd(p.get("to")), dismissed: p.get("dismissed") === "1" };
}
export function writeClaimsUrl(s: ClaimsUrlState): string {
  const p = new URLSearchParams();
  if (!(s.bucket.length === 1 && s.bucket[0] === "needs_attention")) p.set("bucket", s.bucket.join(","));
  if (s.q) p.set("q", s.q);
  if (s.kind) p.set("kind", s.kind);
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  if (s.dismissed) p.set("dismissed", "1");
  const q = p.toString();
  return q ? `?${q}` : "";
}
/** The filter box: supplier, order # (or an alternate), ASIN or product name, case-insensitive. */
export function matchesFilter(c: Pick<ClaimRowApi, "supplier" | "order_id" | "alt_order_ids" | "asin" | "product_name">, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [c.supplier, c.order_id, c.alt_order_ids ?? "", c.asin ?? "", c.product_name ?? ""].some((v) => v.toLowerCase().includes(t));
}
/** The rows of a tab set: the filter, the kind, the PO date range (the Dashboard link); dismissed only on Closed with the toggle. */
export function rowsForView(rows: readonly ClaimRowApi[], s: ClaimsUrlState): ClaimRowApi[] {
  const set = new Set<string>(s.bucket);
  if (set.has("closed") && s.dismissed) set.add("dismissed");
  return rows.filter((r) => set.has(r.bucket) && matchesFilter(r, s.q) && (!s.kind || r.kind === s.kind) && (!s.from || r.order_date >= s.from) && (!s.to || r.order_date <= s.to));
}
/** Needs attention grouped by the server's group (the primary action's task group; an unreported claim → Supplier). */
export function groupNeedsAttention(rows: readonly ClaimRowApi[]): Array<{ group: TaskGroup; rows: ClaimRowApi[] }> {
  return TASK_GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}
export const money = (v: number | string | null | undefined) => (v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`);
const fmtDate = (iso: string | null | undefined) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
const fmtMD = (iso: string | null | undefined) => { if (!iso) return "—"; const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}`; };
const fmtWhen = (iso: string) => { const d = new Date(iso); const date = `${d.getMonth() + 1}/${d.getDate()}`; const t = d.getHours() || d.getMinutes() ? ` ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : ""; return date + t; };
/** "unknown (sheet zeroed the line)" / "qty unknown" / the number. */
export function qtyText(c: Pick<ClaimRowApi, "qty" | "conversion_flags">): string {
  if (c.qty == null) return (c.conversion_flags ?? []).includes("canceled_no_ordered_qty") ? SHEET_ZEROED_LABEL : QTY_UNKNOWN_LABEL;
  return fmtQty(c.qty);
}
/** The default method for a new refund row: the PO's first payment's method (§3.5). */
export function prefillMethod(payments: ReadonlyArray<{ method: string }>): string { return payments[0]?.method ?? "card"; }
/** The product cell: the name (or "Whole order" for a whole-PO claim) over the ASIN. */
export function productText(c: Pick<ClaimRowApi, "po_line_item_id" | "product_name" | "asin" | "kind">): { main: string; sub: string } {
  if (!c.po_line_item_id) return { main: c.kind === "canceled" ? "Whole order" : "Whole PO", sub: "all lines" };
  return { main: c.product_name ?? c.asin ?? "line", sub: c.asin ?? "" };
}

// ── Columns (docs/UI_RULES.md: fixed layout, content-sized defaults, a filler) ──

export const CLAIM_COLUMNS: ReadonlyArray<{ id: string; label: string; width: number; align?: "right"; kind?: string }> = [
  { id: "supplier", label: "Supplier · PO", width: 150 },
  { id: "product", label: "Product", width: 180 },
  { id: "kind", label: "Kind", width: 118 },
  { id: "qty", label: "Qty", width: 100, align: "right", kind: QTY_KIND.individual },
  { id: "owed", label: "Owed / left", width: 110, align: "right" },
  { id: "step", label: "Step", width: 300 },
  { id: "waiting", label: "Waiting", width: 70, align: "right" },
  { id: "do", label: "Do", width: 190 },
];
export const CLAIMS_TABLE_WIDTH = CLAIM_COLUMNS.reduce((t, c) => t + c.width, 0); // 1,218 px: inside 1280 − the page padding

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
const th = "px-3 py-2 text-xs font-medium text-left align-bottom overflow-hidden";
const link = "text-[11px] underline-offset-2 hover:underline text-muted-foreground hover:text-foreground";
const amber = "text-amber-700 dark:text-amber-400";
const card = "rounded-md p-3 space-y-2 text-sm";
const cardStyle = { border: "0.5px solid hsl(var(--border))" } as const;
const cardTitle = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const CHANNELS = ["email", "chat", "phone", "form", "other"];

// ── Inline forms (the row's Do column and the detail's timeline slot) ────────

/** Contacted supplier / Followed up: date · how · note. */
function ContactForm({ label, onSave, onCancel, hint }: { label: string; onSave: (f: { date: string; channel: string; note: string }) => Promise<void>; onCancel: () => void; hint?: string }) {
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), channel: "email", note: "" });
  return (
    <div className="space-y-1.5" data-testid="contact-form">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1"><span className="text-muted-foreground">Date</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="input-contact-date" /></label>
        <label className="flex items-center gap-1"><span className="text-muted-foreground">How</span>
          <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-contact-channel">{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="note" className="h-7 w-56 text-xs" data-testid="input-contact-note" />
        <Button size="sm" className="h-7 text-xs" onClick={() => void onSave(f)} data-testid="button-contact-save">Save</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
      </div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
/** Supplier replied: date · how · summary · the outcome when the reply told it. */
function ReplyForm({ claim, onSave, onCancel }: { claim: ClaimRowApi; onSave: (f: { date: string; channel: string; summary: string; outcome: string; amount: string }) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), channel: "email", summary: "", outcome: claim.outcome ?? "", amount: "" });
  return (
    <div className="space-y-1.5" data-testid="reply-form">
      <div className="text-xs font-medium">Supplier replied</div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1"><span className="text-muted-foreground">Date</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="input-reply-date" /></label>
        <label className="flex items-center gap-1"><span className="text-muted-foreground">How</span>
          <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-reply-channel">{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <Input value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} placeholder="what they said" className="h-7 w-72 text-xs" data-testid="input-reply-summary" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1"><span className="text-muted-foreground">Sets the outcome</span>
          <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-reply-outcome">
            <option value="">not told yet</option>{CLAIM_OUTCOMES.map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o]}</option>)}</select></label>
        {["refund_card", "gift_card", "store_credit"].includes(f.outcome) && <Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="$ promised" className="h-7 w-24 text-right text-xs" data-testid="input-reply-amount" />}
        <Button size="sm" className="h-7 text-xs" onClick={() => void onSave(f)} data-testid="button-reply-save">Save</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
      </div>
      <div className="text-[11px] text-muted-foreground">Each reply is its own entry; the timer restarts from the latest. Without an outcome the claim goes to Decide to confirm one.</div>
    </div>
  );
}
/** A one-date form (Confirmed by supplier, Shipped, Arrived, Found) with an optional outcome. */
function DateForm({ label, hint, withOutcome, onSave, onCancel, initial }: { label: string; hint?: string; withOutcome?: boolean; initial?: string | null; onSave: (date: string, outcome: string) => Promise<void>; onCancel: () => void }) {
  const [date, setDate] = useState(initial?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [outcome, setOutcome] = useState("refund_card");
  return (
    <div className="space-y-1.5" data-testid="date-form">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="input-date-form" />
        {withOutcome && <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid="select-date-form-outcome">{["refund_card", "gift_card", "store_credit", "replacement"].map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o as ClaimOutcome]}</option>)}</select>}
        <Button size="sm" className="h-7 text-xs" onClick={() => void onSave(date, outcome)} data-testid="button-date-form-save">Save</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
      </div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
/** A reason / text form (Write off, Dismiss, Remove). */
function TextForm({ label, placeholder, button, onSave, onCancel, danger }: { label: string; placeholder: string; button: string; danger?: boolean; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-1.5" data-testid="text-form">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="h-7 w-72 text-xs" data-testid="input-text-form" />
        <Button size="sm" variant={danger ? "destructive" : "default"} className="h-7 text-xs" onClick={() => void onSave(text)} data-testid="button-text-form-save">{button}</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
      </div>
    </div>
  );
}

/** Refund received: amount · method · date · card / credit name · last 4 · note; one refund across the PO's other open claims. */
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
    <div className="space-y-2 text-xs" data-testid="refund-received-form">
      <div className="text-xs font-medium">Refund received</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Amount</span><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="h-8 w-24 text-right text-xs" data-testid="input-refund-amount" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Method</span>
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid="select-refund-method">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Date</span><input type="date" value={f.refunded_at} onChange={(e) => setF({ ...f, refunded_at: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs" data-testid="input-refund-date" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Card / credit name</span><Input value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} className="h-8 w-32 text-xs" data-testid="input-refund-nickname" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Last 4</span><Input value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} className="h-8 w-14 text-xs" data-testid="input-refund-last4" /></label>
        <label className="flex flex-col"><span className="text-[9px] text-muted-foreground">Note</span><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="h-8 w-40 text-xs" data-testid="input-refund-note" /></label>
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
        <Button size="sm" className="h-8 text-xs" disabled={!(Number(f.amount) > 0) || mine < 0} onClick={() => void submit()} data-testid="button-refund-save">Refund received</Button>
        <button type="button" onClick={onCancel} className={link}>cancel</button>
        {claim.remaining != null && Number(f.amount) > 0 && mine < claim.remaining - 0.005 && <span className={amber}>short by {money(claim.remaining - mine)} — the rest stays owed</span>}
      </div>
    </div>
  );
}

// ── The Do cell ───────────────────────────────────────────────────────────────

/** ONE primary button for the row's task, plus Dismiss / Snooze where they apply. */
function DoCell({ claim, refresh, onRefund }: { claim: ClaimRowApi; refresh: () => void; onRefund: (c: ClaimRowApi) => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [form, setForm] = useState<"contact" | null>(null);
  const a = claim.action;
  const call = async (url: string, body?: unknown) => { try { await poApi(url, "POST", body ?? {}); refresh(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } };
  if (a.kind === "none") return <span className="text-muted-foreground">—</span>;
  if (form === "contact") {
    return <ContactForm label={a.label} onCancel={() => setForm(null)} onSave={async (f) => { await call(a.taskKind === "follow_up_supplier" && a.taskId ? `/api/pos/claims/tasks/${a.taskId}/done` : `/api/pos/claims/${claim.id}/contacted`, f); setForm(null); }} />;
  }
  const primary = a.kind === "task" && a.taskId ? () => void call(`/api/pos/claims/tasks/${a.taskId}/done`, a.taskKind === "review_suggestion" ? { decision: "open" } : {})
    : a.kind === "contact" ? () => setForm("contact")
    : a.kind === "refund" ? () => onRefund(claim)
    : () => navigate(`/claims/${claim.id}`);
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid={`do-${claim.id}`}>
      <Button size="sm" variant={a.kind === "detail" ? "outline" : "default"} className="h-7 text-xs" onClick={primary} data-testid={`button-do-${claim.id}`}>{a.label}</Button>
      {a.secondary === "dismiss" && a.taskId && <button type="button" onClick={() => void call(`/api/pos/claims/tasks/${a.taskId}/done`, { decision: "dismiss" })} className={link} data-testid={`button-dismiss-${claim.id}`}>Dismiss</button>}
      {a.secondary === "snooze" && a.taskId && <button type="button" onClick={() => void call(`/api/pos/claims/tasks/${a.taskId}/snooze`, { business_days: 5 })} className={link} title="Ask again in 5 business days" data-testid={`button-snooze-${claim.id}`}>Snooze</button>}
    </span>
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
    try { const r = await fetch(`/api/claims`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); setData(await r.json()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { replaceQuery("/claims", writeClaimsUrl(s)); }, [s]);
  const rows = useMemo(() => (data ? rowsForView(data.claims, s) : []), [data, s]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of data?.claims ?? []) if (matchesFilter(r, s.q) && (!s.kind || r.kind === s.kind) && (!s.from || r.order_date >= s.from) && (!s.to || r.order_date <= s.to)) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, [data, s.q, s.kind, s.from, s.to]);
  const needsAttention = s.bucket.length === 1 && s.bucket[0] === "needs_attention";
  const groups = useMemo(() => (needsAttention ? groupNeedsAttention(rows) : []), [rows, needsAttention]);

  return (
    <div className="px-6 py-4 space-y-4" data-testid="claims-page">
      <div className="flex items-center flex-wrap gap-4">
        <h1 className="text-2xl font-semibold">Claims</h1>
        {data && <span className="text-sm text-muted-foreground" data-testid="claims-header">Refunds due <b className="font-mono font-medium text-foreground">{money(data.header?.due)}</b> · {data.header?.open ?? 0} open</span>}
        <span className="flex-1" />
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={s.q} onChange={(e) => setS({ ...s, q: e.target.value })} placeholder="Supplier, PO, ASIN…" aria-label="Filter claims" className="h-8 w-[220px] pl-8 text-sm" data-testid="input-claims-filter" />
        </div>
        <select value={s.kind} onChange={(e) => setS({ ...s, kind: e.target.value })} aria-label="Kind" className="h-8 w-[140px] rounded border border-input bg-background px-1 text-xs" data-testid="select-claims-kind">
          <option value="">All kinds</option>{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select>
        <Button size="sm" onClick={() => setOpening(true)} data-testid="button-open-claim"><Plus className="h-4 w-4 mr-1" /> Open claim</Button>
      </div>
      {(s.from || s.to) && <div className="text-xs text-muted-foreground" data-testid="claims-date-range">POs dated {s.from || "…"} to {s.to || "…"} <button type="button" onClick={() => setS({ ...s, from: "", to: "" })} className={link}>clear</button></div>}

      <div className="flex gap-1 flex-wrap items-end" style={{ borderBottom: "0.5px solid hsl(var(--border))" }} data-testid="claims-tabs">
        {CLAIM_BUCKET_TABS.map((b) => (
          <button key={b} onClick={() => setS({ ...s, bucket: [b] })} data-testid={`tab-claims-${b}`}
            className={`px-3 py-1.5 text-sm -mb-px whitespace-nowrap ${s.bucket.includes(b) ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}>
            {CLAIM_BUCKET_LABELS[b]} <span className="text-xs text-muted-foreground tabular-nums" data-testid={`count-claims-${b}`}>{counts[b] ?? 0}</span>
          </button>))}
        {s.bucket.includes("closed") && (
          <label className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground pb-1.5"><input type="checkbox" checked={s.dismissed} onChange={(e) => setS({ ...s, dismissed: e.target.checked })} data-testid="checkbox-claims-dismissed" /> show dismissed</label>)}
        {s.bucket.length > 1 && <span className="ml-auto text-xs text-muted-foreground pb-1.5" data-testid="claims-combined">Refunds due: {s.bucket.map((b) => CLAIM_BUCKET_LABELS[b]).join(" + ")}</span>}
      </div>

      {error && <div className="text-sm text-destructive" data-testid="text-claims-error">{error}</div>}
      {!data && !error && <div className="text-sm text-muted-foreground">Loading…</div>}

      {data && needsAttention && (
        <div className="space-y-4" data-testid="claims-needs-attention">
          {groups.length === 0 && <div className="text-sm text-muted-foreground">Nothing needs a hand.</div>}
          {groups.map((g) => (
            <section key={g.group} className="space-y-1" data-testid={`claims-group-${g.group}`}>
              <h2 className={`text-sm font-medium ${amber}`}>{TASK_GROUP_LABELS[g.group]} <span className="font-normal text-muted-foreground">· {g.rows.length}{GROUP_HINTS[g.group] ? ` · ${GROUP_HINTS[g.group]}` : ""}</span></h2>
              <ClaimsTable rows={g.rows} onRow={(c) => navigate(`/claims/${c.id}`)} refresh={() => void load()} onRefund={setRefundFor} />
            </section>))}
        </div>)}
      {data && !needsAttention && <ClaimsTable rows={rows} onRow={(c) => navigate(`/claims/${c.id}`)} refresh={() => void load()} onRefund={setRefundFor} />}

      {refundFor && (
        <Dialog open onOpenChange={(v) => { if (!v) setRefundFor(null); }}>
          <DialogContent dialogId="claim-refund-received" className="max-w-2xl">
            <DialogHeader><DialogTitle className="text-base">{refundFor.supplier} {refundFor.order_id} · {refundFor.asin ?? "whole PO"} · {CLAIM_KIND_LABELS[refundFor.kind]}</DialogTitle><DialogDescription>Refund received — the row, linked to this claim.</DialogDescription></DialogHeader>
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

function ClaimsTable({ rows, onRow, refresh, onRefund }: { rows: ClaimRowApi[]; onRow: (c: ClaimRowApi) => void; refresh: () => void; onRefund: (c: ClaimRowApi) => void }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={cardStyle}>
      <table className="border-collapse text-sm table-fixed" style={{ width: CLAIMS_TABLE_WIDTH, minWidth: "100%" }} data-testid="claims-table">
        <colgroup>{CLAIM_COLUMNS.map((c) => <col key={c.id} style={{ width: c.width }} />)}<col /></colgroup>
        <thead><tr className="table-header-stone">
          {CLAIM_COLUMNS.map((c) => <th key={c.id} className={`${th} ${c.align === "right" ? "text-right" : ""}`} style={{ width: c.width }} data-testid={`th-claims-${c.id}`}>
            {c.kind && <span className="block text-[9px] font-normal opacity-60">{c.kind}</span>}{c.label}</th>)}
          <th aria-hidden />
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={CLAIM_COLUMNS.length + 1} className="px-3 py-3 text-xs text-muted-foreground">No claims here.</td></tr>}
          {rows.map((c) => {
            const p = productText(c);
            return (
              <tr key={c.id} className="table-zebra-stone cursor-pointer hover:bg-muted/40 align-top" style={hairline} onClick={() => onRow(c)} data-testid={`row-claim-${c.id}`}>
                <td className="px-3 py-2 min-w-0" onClick={(e) => e.stopPropagation()}>
                  <div className="truncate text-xs" title={c.supplier}>{c.supplier}</div>
                  <Link href={`/purchase-orders/${c.po_id}`} className="font-mono text-xs hover:underline block truncate" title={c.order_id}>{c.order_id}</Link>
                </td>
                <td className="px-3 py-2 min-w-0"><div className="truncate text-xs" title={p.main}>{p.main}</div><div className="truncate text-[11px] text-muted-foreground font-mono" title={p.sub}>{p.sub}</div></td>
                <td className="px-3 py-2 text-xs">{CLAIM_KIND_LABELS[c.kind]}{c.status === "suggested" ? <span className={amber}> · {c.found_by === "email" ? "from email" : "suggested"}</span> : null}{c.outcome && c.status !== "suggested" ? <div className="text-[10px] text-muted-foreground">{CLAIM_OUTCOME_LABELS[c.outcome]}</div> : null}</td>
                <td className={`px-3 py-2 text-right font-mono text-xs ${c.qty == null ? amber : ""}`} data-testid={`claim-qty-${c.id}`}>
                  {c.qty == null ? "?" : fmtQty(c.qty)}{c.qty != null && c.ordered != null ? <span className="text-muted-foreground font-sans"> of {fmtQty(c.ordered)}</span> : null}
                  {c.qty == null && <div className="text-[10px] font-sans text-muted-foreground whitespace-normal">{qtyText(c) === QTY_UNKNOWN_LABEL ? "not known yet" : qtyText(c)}</div>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">{money(c.amount_owed)}{c.status === "open" && c.remaining != null && c.remaining > 0.005 && c.received > 0 ? <div className={`text-[10px] font-sans ${amber}`}>{money(c.remaining)} left</div> : null}</td>
                <td className="px-3 py-2 text-xs whitespace-normal" title={c.sentence}>{c.sentence}</td>
                <td className={`px-3 py-2 text-right text-xs tabular-nums ${c.timed_out ? amber : "text-muted-foreground"}`} title={c.bucket_since ? `since ${fmtDate(c.bucket_since)}${c.due_at ? ` · timer runs out ${fmtDate(c.due_at)}` : ""}` : ""}>{c.days_in_bucket != null ? `${c.days_in_bucket} d` : "—"}</td>
                <td className="px-3 py-2 text-xs" onClick={(e) => e.stopPropagation()}><DoCell claim={c} refresh={refresh} onRefund={onRefund} /></td>
                <td aria-hidden />
              </tr>);
          })}
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
            <div className="max-h-72 overflow-auto rounded-md" style={cardStyle}>
              {rows.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">{q.trim().length < 2 ? "Type at least two characters." : "No PO matches."}</div>}
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setPicked(r)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-3" style={hairline} data-testid={`po-picker-row-${r.id}`}>
                  <span className="font-mono w-40 truncate">{r.order_id}</span><span className="w-32 truncate">{r.supplier}</span><span className="w-20">{fmtDate(r.order_date)}</span><span className="font-mono">{r.asin}</span><span className="truncate text-muted-foreground">{r.asin_name ?? ""}</span>{r.closed && <span className="text-muted-foreground">closed</span>}
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
            {po && asin && line && <OpenClaimForm poId={po.po.id} line={{ id: String(line.id), product_name: line.product_name, retailer_units_per_product: line.retailer_units_per_product ?? null, qty_basis: line.qty_basis ?? null, price: line.price ?? null, adjusted_product_cost: line.adjusted_product_cost ?? null }} asinPack={asin.units_per_pack} po={po.po} onOpened={onOpened} onCancel={onClose} />}
            {po && asin && asin.lines.length === 0 && <div className="text-xs text-muted-foreground">This ASIN row has no product line to claim on.</div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Claim detail ─────────────────────────────────────────────────────────────

type Slot =
  | { kind: "contact" } | { kind: "reply" } | { kind: "confirm" } | { kind: "refund" } | { kind: "write_off" } | { kind: "remainder" } | { kind: "dismiss" } | { kind: "remove" } | { kind: "merge" }
  | { kind: "date"; step: "found" | "shipped" | "arrived" | "promised"; label: string; initial?: string | null };

/** The timeline's inline form slot: what a button or a step opened. */
function SlotForm({ slot, d, call, close, reload }: { slot: Slot; d: ClaimDetailApi; call: (url: string, method: string, body?: unknown) => Promise<void>; close: () => void; reload: () => void }) {
  const c = d.claim;
  const [, navigate] = useLocation();
  switch (slot.kind) {
    case "contact": return <ContactForm label="Contacted supplier" hint="Starts the 5-business-day timer. Each later message is its own entry — add as many as it takes." onCancel={close} onSave={async (f) => { await call(`/api/pos/claims/${c.id}/contacted`, "POST", f); close(); }} />;
    case "reply": return <ReplyForm claim={c} onCancel={close} onSave={async (f) => { await call(`/api/pos/claims/${c.id}/replied`, "POST", { ...f, outcome: f.outcome || null, amount: f.amount || null }); close(); }} />;
    case "confirm": return <DateForm label="Confirmed by supplier" withOutcome={!c.outcome} hint={c.outcome ? `Confirms the ${CLAIM_OUTCOME_LABELS[c.outcome]} — a refund then waits to post.` : "Pick what the supplier confirmed."} onCancel={close} onSave={async (date, outcome) => { await call(`/api/pos/claims/${c.id}/confirm-supplier`, "POST", { at: date, ...(c.outcome ? {} : { outcome }) }); close(); }} />;
    case "refund": return <RefundReceivedForm claim={c} payments={d.po.payments} others={d.other_open_claims} onDone={() => { close(); reload(); }} onCancel={close} />;
    case "write_off": return <TextForm label="Write off" placeholder="why (required)" button="Write off" onCancel={close} onSave={async (t) => { if (!t.trim()) return; await call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "write_off", reason: t.trim() }); close(); }} />;
    case "remainder": return <TextForm label={`Write off the remainder (${money(c.remaining)})`} placeholder="why (required)" button="Write off remainder" onCancel={close} onSave={async (t) => { if (!t.trim()) return; await call(`/api/pos/claims/${c.id}/write-off-remainder`, "POST", { reason: t.trim() }); close(); }} />;
    case "dismiss": return <TextForm label="Dismiss this claim" placeholder="reason (optional)" button="Dismiss" onCancel={close} onSave={async (t) => { await call(`/api/pos/claims/${c.id}/dismiss`, "POST", { reason: t.trim() || null }); close(); }} />;
    case "remove": return <TextForm label="Remove this claim for good" placeholder="type REMOVE to confirm" button="Remove" danger onCancel={close} onSave={async (t) => { if (t.trim() !== "REMOVE") return; await call(`/api/pos/claims/${c.id}`, "DELETE"); navigate("/claims"); }} />;
    case "merge": return (
      <div className="space-y-1.5" data-testid="merge-form">
        <div className="text-xs font-medium">Merge into another claim on this PO</div>
        {d.other_open_claims.length === 0 ? <div className="text-xs text-muted-foreground">No other open claim on this PO.</div> : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {d.other_open_claims.map((o) => <Button key={o.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => void call(`/api/pos/claims/${c.id}/merge`, "POST", { into: o.id }).then(() => navigate(`/claims/${o.id}`))} data-testid={`button-merge-into-${o.id}`}>#{o.id} · {o.asin ?? "whole PO"} · {o.qty ?? "?"} {CLAIM_KIND_LABELS[o.kind as ClaimKind] ?? o.kind}</Button>)}
          </div>)}
        <div className="text-[11px] text-muted-foreground">This claim's refunds and timeline move over, the quantities add up, and this claim is dismissed as merged.</div>
        <button type="button" onClick={close} className={link}>cancel</button>
      </div>);
    case "date": {
      const save = async (date: string) => {
        if (slot.step === "found") await call(`/api/pos/claims/${c.id}`, "PATCH", { found_at: date });
        else if (slot.step === "promised") await call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "replacement" });
        else if (slot.step === "shipped") await call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "replacement", shipped_at: date });
        else await call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "replacement", arrived_at: date });
        close();
      };
      return <DateForm label={slot.label} initial={slot.initial} onCancel={close} onSave={save} />;
    }
  }
}

const EVENT_TITLES: Record<string, string> = {
  found: "Found", opened: "Opened", dismissed: "Dismissed", reported: "Contacted supplier", supplier_reply: "Supplier replied", outcome_set: "Outcome set", label_saved: "Return label saved",
  return_shipped: "Return shipped", return_delivered: "Return delivered", supplier_confirmed: "Confirmed by supplier", refund_received: "Refund received", replacement_shipped: "Replacement shipped",
  replacement_arrived: "Replacement arrived", task_done: "Task done", amount_overridden: "$ owed overridden", remainder_written_off: "Remainder written off", reopened: "Reopened", closed: "Closed",
  converted: "Converted", timed_out: "Timed out", snoozed: "Snoozed", followed_up: "Followed up", checked: "Checked on it", reship_confirmed: "Reship order # confirmed", refund_short: "Refund short",
};
/** One timeline entry, editable in place (summary and date). */
function TimelineEntry({ e, call }: { e: ClaimDetailApi["events"][number]; call: (url: string, method: string, body?: unknown) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ at: e.at.slice(0, 10), summary: e.summary ?? "" });
  const title = EVENT_TITLES[e.type] ?? e.type.replace(/_/g, " ");
  const on = ["reported", "supplier_reply", "outcome_set", "timed_out", "followed_up", "checked"].includes(e.type);
  const ok = ["refund_received", "supplier_confirmed", "closed", "replacement_arrived", "task_done"].includes(e.type);
  return (
    <div className="grid gap-x-2" style={{ gridTemplateColumns: "76px 14px minmax(0, 1fr)" }} data-testid={`event-${e.id}`}>
      <div className="text-[11px] text-muted-foreground pt-0.5 tabular-nums">{fmtWhen(e.at)}</div>
      <div className={`mt-1.5 h-2.5 w-2.5 rounded-full ${on ? "bg-amber-600/80" : ok ? "bg-emerald-600/70" : "bg-muted-foreground/40"}`} />
      <div className="pb-3 min-w-0">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input type="date" value={f.at} onChange={(ev) => setF({ ...f, at: ev.target.value })} className="h-7 rounded border border-input bg-background px-1 text-xs" data-testid={`input-event-date-${e.id}`} />
            <Input value={f.summary} onChange={(ev) => setF({ ...f, summary: ev.target.value })} className="h-7 w-64 text-xs" data-testid={`input-event-summary-${e.id}`} />
            <Button size="sm" className="h-7 text-xs" onClick={() => void call(`/api/pos/claims/events/${e.id}`, "PATCH", { at: f.at !== e.at.slice(0, 10) ? f.at : undefined, summary: f.summary }).then(() => setEditing(false))} data-testid={`button-event-save-${e.id}`}>Save</Button>
            <button type="button" onClick={() => setEditing(false)} className={link}>cancel</button>
          </div>
        ) : (
          <>
            <div className="text-xs font-medium">{title} <button type="button" onClick={() => setEditing(true)} className={`${link} ml-1`} data-testid={`button-event-edit-${e.id}`}>edit</button></div>
            {(e.summary || e.by_name) && <div className="text-[11px] text-muted-foreground break-words">{e.summary}{e.by_name ? ` · ${e.by_name}` : ""}</div>}
          </>)}
      </div>
    </div>
  );
}

function ClaimDetailPage({ id }: { id: number }) {
  const { toast } = useToast();
  const [d, setD] = useState<ClaimDetailApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`/api/claims/${id}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); setD(await r.json()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const call = async (url: string, method: string, body?: unknown) => { try { await poApi(url, method, body); await load(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); throw e; } };
  if (error) return <div className="px-6 py-8 space-y-3"><Link href="/claims" className="text-sm text-primary hover:underline">← Claims</Link><p className="text-sm text-destructive">{error}</p></div>;
  if (!d) return <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>;
  const c = d.claim;
  const emailed = c.kind === "canceled" && c.found_by === "email";
  const open = c.status === "open";
  const dl = "text-muted-foreground";
  const openStep = (s: UiStep) => {
    const h: StepHandler = s.handler;
    if (h.type === "none") { toast({ title: "Not yet", description: h.why }); return; }
    if (h.type === "edit_found") setSlot({ kind: "date", step: "found", label: "Found on", initial: c.found_at });
    else if (h.type === "contact") setSlot({ kind: "contact" });
    else if (h.type === "reply") setSlot({ kind: "reply" });
    else if (h.type === "confirm") setSlot({ kind: "confirm" });
    else if (h.type === "refund") setSlot({ kind: "refund" });
    else if (h.type === "write_off") setSlot({ kind: "write_off" });
    else if (h.type === "replacement_promised") setSlot({ kind: "date", step: "promised", label: "Replacement promised" });
    else if (h.type === "replacement_shipped") setSlot({ kind: "date", step: "shipped", label: "Replacement shipped on", initial: c.replacement_shipped_at });
    else if (h.type === "replacement_arrived") setSlot({ kind: "date", step: "arrived", label: "Replacement arrived on", initial: c.replacement_arrived_at });
    else if (h.type === "task") {
      const t = c.tasks.find((x) => x.kind === h.task && !x.done_at);
      if (t) void call(`/api/pos/claims/tasks/${t.id}/done`, "POST", {});
      else toast({ title: "Nothing to tick", description: `${h.task.replace(/_/g, " ")} is not open on this claim.` });
    }
  };
  const canMerge = d.other_open_claims.length > 0;
  return (
    <div className="px-6 py-4 space-y-4" data-testid="claim-detail">
      <Link href="/claims" className="text-sm text-primary hover:underline" data-testid="button-back-to-claims">← Claims</Link>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold" data-testid="text-claim-title">{CLAIM_KIND_LABELS[c.kind]} · {c.supplier} <Link href={`/purchase-orders/${c.po_id}`} className="font-mono font-normal text-base text-muted-foreground hover:underline">{c.order_id}</Link></h1>
          <div className="text-sm text-muted-foreground mt-1" data-testid="claim-subtitle">
            PO {fmtDate(c.order_date)} · {productText(c).main}{c.asin ? <> · <span className="font-mono">{c.asin}</span></> : null} · {c.qty == null ? "quantity not known yet" : `${fmtQty(c.qty)} ${c.qty_basis === "product_legacy" ? "Product" : "Individual"} units`}
            <span className="mx-1.5">·</span><span className={open && !c.reported_at && !emailed ? amber : ""} data-testid="claim-state">{c.sentence}</span>{c.days_open != null ? <> — open {c.days_open} days</> : null}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap" data-testid="claim-actions">
          {open && !emailed && <Button size="sm" variant={c.reported_at ? "outline" : "default"} onClick={() => setSlot({ kind: "contact" })} data-testid="button-claim-contacted">Contacted supplier</Button>}
          {open && <Button size="sm" variant="outline" onClick={() => setSlot({ kind: "reply" })} data-testid="button-claim-replied">Supplier replied</Button>}
          {open && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline" data-testid="button-claim-set-outcome">Set outcome <ChevronDown className="h-3.5 w-3.5 ml-1" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(["refund_card", "gift_card", "store_credit"] as const).map((o) => <DropdownMenuItem key={o} onClick={() => void call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: o })} data-testid={`menu-outcome-${o}`}>{CLAIM_OUTCOME_LABELS[o]}</DropdownMenuItem>)}
                <DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "replacement" })} data-testid="menu-outcome-replacement">replacement</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSlot({ kind: "write_off" })} data-testid="menu-outcome-write_off">write-off…</DropdownMenuItem>
                {c.outcome && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/clear-outcome`, "POST", {})} data-testid="menu-outcome-clear">clear the outcome</DropdownMenuItem></>}
              </DropdownMenuContent>
            </DropdownMenu>)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" data-testid="button-claim-more">More <ChevronDown className="h-3.5 w-3.5 ml-1" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {c.status !== "dismissed" && c.status !== "closed" && <DropdownMenuItem onClick={() => setSlot({ kind: "dismiss" })} data-testid="menu-more-dismiss">Dismiss this claim</DropdownMenuItem>}
              {(c.status === "closed" || c.status === "dismissed") && <DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/reopen`, "POST", {})} data-testid="menu-more-reopen">Reopen</DropdownMenuItem>}
              <DropdownMenuItem disabled={!canMerge} onClick={() => setSlot({ kind: "merge" })} data-testid="menu-more-merge">Merge into another claim on this PO</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setSlot({ kind: "remove" })} data-testid="menu-more-remove">Remove</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Three columns: 340 · the rest · 360 (1280 − 48 padding → 500 px for the timeline) */}
      <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "340px minmax(0, 1fr) 360px" }} data-testid="claim-columns">
        {/* Left: facts, steps, linked */}
        <div className="space-y-4 min-w-0">
          <div className={card} style={cardStyle} data-testid="claim-facts">
            <div className={cardTitle}>Claim <span className="normal-case tracking-normal font-normal">· click a value to change it</span></div>
            <div className="grid gap-x-3 gap-y-1 text-xs" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
              <span className={dl}>Kind</span>
              <span className="text-right"><select value={c.kind} disabled={!open && c.status !== "suggested"} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { kind: e.target.value })} className="h-6 rounded border border-input bg-background px-1 text-xs" data-testid="select-claim-kind">{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select></span>
              <span className={dl}>{c.qty_basis === "product_legacy" ? "Qty (Product units)" : "Qty (Individual units)"}</span>
              <span className="text-right"><InlineEdit value={c.qty ?? ""} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { qty: v })} align="right" width="w-16" testId="claim-qty"><span className={`font-mono ${c.qty == null ? amber : ""}`}>{c.qty == null ? "not known yet" : fmtQty(c.qty)}</span></InlineEdit>
                {c.qty != null && c.qty_basis !== "product_legacy" && <div className="text-[10px] text-muted-foreground">{qtyEquivalents(c.qty, c.product_pack, c.asin_pack)}{c.ordered != null ? ` · of ${fmtQty(c.ordered)}` : ""}</div>}</span>
              <span className={dl}>$ owed</span>
              <span className="text-right"><InlineEdit money value={c.amount_owed == null ? null : String(c.amount_owed)} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: v })} align="right" width="w-20" testId="claim-amount"><span className="font-mono">{money(c.amount_owed)}</span></InlineEdit>
                <span className="text-[10px] text-muted-foreground ml-1">{c.amount_owed_source === "manual" ? "override" : "auto"}</span>
                {c.amount_owed_source === "manual" && <button type="button" onClick={() => void call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: "" })} className={`${link} ml-1`} data-testid="button-claim-reset-auto">back to auto</button>}</span>
              <span className={dl}>Received</span><span className="text-right font-mono">{money(c.received)}</span>
              <span className={dl}>Remaining</span><span className={`text-right font-mono ${c.remaining != null && c.remaining > 0 && open ? amber : ""}`} data-testid="claim-remaining">{money(c.remaining)}</span>
              <span className={dl}>Outcome</span>
              <span className="text-right" data-testid="claim-outcome">{c.outcome ? <>{CLAIM_OUTCOME_LABELS[c.outcome]}{c.outcome_amount != null ? ` ${money(c.outcome_amount)}` : ""}{open && <button type="button" onClick={() => void call(`/api/pos/claims/${c.id}/clear-outcome`, "POST", {})} className={`${link} ml-1`} data-testid="button-claim-clear-outcome">clear</button>}</> : <span className="text-muted-foreground">not known yet</span>}</span>
              <span className={dl}>Return needed</span>
              <span className="text-right"><label className="inline-flex items-center gap-1"><input type="checkbox" checked={c.return_required} disabled={!open} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { return_required: e.target.checked })} data-testid="checkbox-claim-return" />{c.return_required ? "yes" : "no"}</label></span>
              <span className={dl}>Found</span>
              <span className="text-right"><button type="button" onClick={() => setSlot({ kind: "date", step: "found", label: "Found on", initial: c.found_at })} className="hover:underline underline-offset-2" data-testid="button-claim-found">{fmtDate(c.found_at)}</button> · {c.found_by}</span>
              <span className={dl}>Reported</span>
              <span className="text-right" data-testid="claim-reported">{c.reported_at ? <button type="button" onClick={() => setSlot({ kind: "contact" })} className="hover:underline underline-offset-2">{fmtDate(c.reported_at)}{c.reported_channel ? ` · ${c.reported_channel}` : ""}</button> : emailed ? <span className="text-muted-foreground">not needed (emailed cancellation)</span> : <span className="text-muted-foreground">— not yet</span>}</span>
              {c.status === "closed" && <><span className={dl}>Closed</span><span className="text-right">{fmtDate(c.closed_at)}</span></>}
              {c.conversion_flags.length > 0 && <div className="col-span-2 text-[10px] text-muted-foreground">converted from the sheet era: {c.conversion_flags.join(", ")}</div>}
            </div>
            <div className="pt-2" style={{ borderTop: "0.5px solid hsl(var(--border))" }}><InlineNoteBox value={c.note} label="note" testId="claim-note" onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { note: v })} /></div>
          </div>

          <div className={card} style={cardStyle} data-testid="claim-steps-card">
            <div className={cardTitle}>Steps <span className="normal-case tracking-normal font-normal">· click any to set or change</span></div>
            <ol className="space-y-0.5" data-testid="claim-steps">
              {c.ui_steps.map((s) => (
                <li key={s.key} className={`flex items-center gap-2 text-xs ${s.current ? "font-medium" : s.done ? "" : "text-muted-foreground"}`} data-testid={`step-${s.key}`} data-done={s.done} data-current={s.current} data-handler={s.handler.type}>
                  <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${s.done ? "border-emerald-700/60 text-emerald-700 dark:text-emerald-400" : s.current ? `border-amber-700/60 ${amber}` : "border-border opacity-60"}`}>{s.done ? "✓" : s.current ? "›" : ""}</span>
                  <button type="button" disabled={s.handler.type === "none" || (!open && c.status !== "suggested")} onClick={() => openStep(s)} className="text-left hover:underline underline-offset-2 disabled:no-underline disabled:cursor-default" title={s.handler.type === "none" ? s.handler.why : "set or change"} data-testid={`button-step-${s.key}`}>{s.current && s.todo ? s.todo : s.label}</button>
                  {s.at ? <span className="text-[10px] text-muted-foreground">{fmtMD(s.at)}</span> : null}
                </li>))}
            </ol>
            <div className="text-[11px] text-muted-foreground">Steps change with the outcome: a return adds label → sent → shipped → delivered; a replacement adds promised → shipped → arrived.</div>
          </div>

          <div className={card} style={cardStyle} data-testid="claim-linked">
            <div className={cardTitle}>Linked</div>
            <div className="grid gap-x-3 gap-y-1 text-xs" style={{ gridTemplateColumns: "80px minmax(0, 1fr)" }}>
              <span className={dl}>PO</span><span className="min-w-0 truncate"><Link href={`/purchase-orders/${c.po_id}`} className="font-mono hover:underline">{c.order_id}</Link> · {d.po.closed_at ? "closed" : "open"}{d.linked.po_received_individual != null ? ` · ${fmtQty(d.linked.po_received_individual)} Individual units received` : ""}</span>
              <span className={dl}>Velocity</span><span className="min-w-0 truncate">{d.linked.velocity.length ? d.linked.velocity.map((v) => `inbound #${v.velocity_order_id} (${v.asin})`).join(", ") : <span className="text-muted-foreground">no order linked</span>}</span>
              <span className={dl}>Emails</span><span className="text-muted-foreground">none matched yet (commit 6)</span>
              <span className={dl}>Tracking</span><span className="min-w-0">{d.linked.po_tracking.length ? d.linked.po_tracking.map((t) => <div key={t.id} className="truncate font-mono" title={`${t.carrier} ${t.tracking_number}`}>{t.carrier} {t.tracking_number} <span className="font-sans text-muted-foreground">{t.delivered_at ? `delivered ${fmtMD(t.delivered_at)}` : t.carrier_status?.replace(/_/g, " ") ?? ""}</span></div>) : <span className="text-muted-foreground">none</span>}</span>
              <span className={dl}>Documents</span><span className="min-w-0 truncate">{d.linked.documents.length ? d.linked.documents.map((x) => x.file_name).join(", ") : <span className="text-muted-foreground">none (labels from commit 7)</span>}</span>
              {c.alt_order_ids && <><span className={dl}>Alt order #s</span><span className="font-mono truncate">{c.alt_order_ids}</span></>}
            </div>
          </div>
        </div>

        {/* Middle: the timeline with the inline form slot */}
        <div className="rounded-md text-sm min-w-0" style={cardStyle} data-testid="claim-timeline-card">
          <div className="flex items-center gap-3 px-3 py-2" style={hairline}><span className={cardTitle}>Timeline</span><span className="text-xs text-muted-foreground">newest first · every entry editable</span></div>
          {slot && <div className="px-3 py-3 bg-muted/30" style={hairline} data-testid="claim-slot"><SlotForm slot={slot} d={d} call={call} close={() => setSlot(null)} reload={() => void load()} /></div>}
          <div className="px-3 pt-3" data-testid="claim-timeline">
            {[...d.events].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).map((e) => <TimelineEntry key={e.id} e={e} call={call} />)}
            <div className="grid gap-x-2" style={{ gridTemplateColumns: "76px 14px minmax(0, 1fr)" }}><div className="text-[11px] text-muted-foreground tabular-nums">{fmtMD(c.order_date)}</div><div className="mt-1.5 h-2.5 w-2.5 rounded-full bg-muted-foreground/40" /><div className="pb-3 text-xs font-medium">PO placed <span className="font-normal text-muted-foreground">· {c.supplier}</span></div></div>
          </div>
        </div>

        {/* Right: refunds, what happens next, more */}
        <div className="space-y-4 min-w-0">
          <div className={card} style={cardStyle} data-testid="claim-refunds-card">
            <div className={cardTitle}>Refunds</div>
            <table className="w-full border-collapse text-xs table-fixed" data-testid="claim-refunds">
              <colgroup><col /><col style={{ width: 80 }} /><col style={{ width: 70 }} /></colgroup>
              <thead><tr className="text-muted-foreground"><th className="text-left font-normal pb-0.5">Method</th><th className="text-right font-normal">Applied</th><th className="text-right font-normal">Date</th></tr></thead>
              <tbody>
                {c.refunds.length === 0 && <tr><td colSpan={3} className="text-muted-foreground py-0.5">none yet</td></tr>}
                {c.refunds.map((r) => <tr key={r.id} data-testid={`claim-refund-${r.id}`}><td className="py-0.5 truncate">{(r.method ?? "refund").replace("_", " ")}</td><td className="text-right font-mono">{money(r.amount_applied ?? r.amount)}</td><td className="text-right">{fmtMD(r.refunded_at)}</td></tr>)}
                <tr style={{ borderTop: "0.5px solid hsl(var(--border))" }}><td className="pt-1">Remaining</td><td className={`pt-1 text-right font-mono ${c.remaining != null && c.remaining > 0 && open ? amber : ""}`}>{money(c.remaining)}</td><td /></tr>
              </tbody>
            </table>
            {open && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSlot({ kind: "refund" })} data-testid="button-claim-refund-received">+ Refund received</Button>
              {c.remaining != null && c.remaining > 0 && c.received > 0 && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSlot({ kind: "remainder" })} data-testid="button-claim-write-off-remainder">Write off remainder</Button>}</div>}
            <div className="text-[11px] text-muted-foreground">Several refunds can land on one claim (two gift cards); one refund can cover several claims on the same PO.</div>
          </div>

          <div className={card} style={cardStyle} data-testid="claim-next">
            <div className={cardTitle}>What happens next</div>
            <div className="space-y-1.5 text-xs">
              {c.next.map((n, i) => <div key={i}><span className={n.when === "Now" ? amber : "text-muted-foreground"}>{n.when}</span> · {n.text}</div>)}
              {open && c.due_at && <div className="text-[11px] text-muted-foreground">timer: {c.timed_out ? "ran out" : `runs out ${fmtDate(c.due_at)}`} (5 business days)</div>}
            </div>
          </div>

          <div className={card} style={cardStyle} data-testid="claim-more">
            <div className={cardTitle}>More</div>
            <div className="flex flex-col gap-1 text-xs">
              {c.status !== "dismissed" && c.status !== "closed" && <button type="button" onClick={() => setSlot({ kind: "dismiss" })} className="text-left hover:underline underline-offset-2" data-testid="link-more-dismiss">Dismiss this claim</button>}
              {(c.status === "closed" || c.status === "dismissed") && <button type="button" onClick={() => void call(`/api/pos/claims/${c.id}/reopen`, "POST", {})} className="text-left hover:underline underline-offset-2" data-testid="link-more-reopen">Reopen</button>}
              <button type="button" disabled={!canMerge} onClick={() => setSlot({ kind: "merge" })} className="text-left hover:underline underline-offset-2 disabled:text-muted-foreground disabled:no-underline" title={canMerge ? "" : "no other open claim on this PO"} data-testid="link-more-merge">Merge into another claim on this PO</button>
              <button type="button" onClick={() => setSlot({ kind: "remove" })} className="text-left text-destructive hover:underline underline-offset-2" data-testid="link-more-remove">Remove</button>
            </div>
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
