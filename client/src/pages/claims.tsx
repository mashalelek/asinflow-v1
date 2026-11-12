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
 * History row (the server does). The LOOK is the mockups' too (Maria 2026-11-12, docs/UI_RULES.md "When a mockup
 * exists"): claims.css is their <style> blocks scoped to `.cl`; the list is the mockup's `.hd` / `.row` grid, not AF's
 * fixed-layout table, and the Qty header is the mockup's bare "Qty" (the Individual-units kind is its title) — both
 * conflicts with the older rules noted, not resolved.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import "./claims.css";
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

// ── Columns: the mockup's grid (28 · 150 · 180 · 130 · 110 · 120 · 1fr · 90 · 180, 12 px gaps) ────────────────────────

export const CLAIM_COLUMNS: ReadonlyArray<{ id: string; label: string; width: number | "1fr"; kind?: string }> = [
  { id: "chk", label: "", width: 28 },
  { id: "supplier", label: "Supplier · PO", width: 150 },
  { id: "product", label: "Product", width: 180 },
  { id: "kind", label: "Kind", width: 130 },
  { id: "qty", label: "Qty", width: 110, kind: QTY_KIND.individual },
  { id: "owed", label: "Owed / left", width: 120 },
  { id: "step", label: "Step", width: "1fr" },
  { id: "waiting", label: "Waiting", width: 90 },
  { id: "do", label: "Do", width: 180 },
];
/** The fixed columns plus the gaps (the mockup's `.row` / `.hd`): 1,084 px, leaving the Step column ≥ 148 px at 1280 (page padding 24). */
export const CLAIMS_TABLE_WIDTH = CLAIM_COLUMNS.reduce((t, c) => t + (c.width === "1fr" ? 0 : c.width), 0) + (CLAIM_COLUMNS.length - 1) * 12;
export const CLAIMS_GRID = CLAIM_COLUMNS.map((c) => (c.width === "1fr" ? "1fr" : `${c.width}px`)).join(" ");

const CHANNELS = ["email", "chat", "phone", "form", "other"];
const fieldRow = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } as const;

// ── Inline forms (the row's Do column and the detail's timeline slot) ────────

/** Contacted supplier / Followed up: date · how · note (the mockup's form band). */
function ContactForm({ label, onSave, onCancel, hint }: { label: string; onSave: (f: { date: string; channel: string; note: string }) => Promise<void>; onCancel: () => void; hint?: string }) {
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), channel: "email", note: "" });
  return (
    <div data-testid="contact-form">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>{label}</div>
      <div style={fieldRow}>
        <label className="mut" htmlFor="cf-date">Date</label><input className="f" id="cf-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ width: 120 }} data-testid="input-contact-date" />
        <label className="mut" htmlFor="cf-how">How</label>
        <select className="f" id="cf-how" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} data-testid="select-contact-channel">{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <input className="f" aria-label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="note" style={{ flex: 1, minWidth: 220 }} data-testid="input-contact-note" />
        <button type="button" className="btn p" onClick={() => void onSave(f)} data-testid="button-contact-save">Save</button><button type="button" className="lnk mut" onClick={onCancel}>cancel</button>
      </div>
      {hint && <div className="mut" style={{ marginTop: 8 }}>{hint}</div>}
    </div>
  );
}
/** Supplier replied: date · how · summary · the outcome when the reply told it. */
function ReplyForm({ claim, onSave, onCancel }: { claim: ClaimRowApi; onSave: (f: { date: string; channel: string; summary: string; outcome: string; amount: string }) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), channel: "email", summary: "", outcome: claim.outcome ?? "", amount: "" });
  return (
    <div data-testid="reply-form">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>Supplier replied</div>
      <div style={fieldRow}>
        <label className="mut" htmlFor="rf-date">Date</label><input className="f" id="rf-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ width: 120 }} data-testid="input-reply-date" />
        <label className="mut" htmlFor="rf-how">How</label>
        <select className="f" id="rf-how" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} data-testid="select-reply-channel">{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <input className="f" aria-label="What they said" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} placeholder="what they said" style={{ flex: 1, minWidth: 220 }} data-testid="input-reply-summary" />
      </div>
      <div style={{ ...fieldRow, marginTop: 8 }}>
        <label className="mut" htmlFor="rf-outcome">Sets the outcome</label>
        <select className="f" id="rf-outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} data-testid="select-reply-outcome">
          <option value="">not told yet</option>{CLAIM_OUTCOMES.map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o]}</option>)}</select>
        {["refund_card", "gift_card", "store_credit"].includes(f.outcome) && <input className="f num" aria-label="$ promised" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="$ promised" style={{ width: 110, textAlign: "right" }} data-testid="input-reply-amount" />}
        <button type="button" className="btn p" onClick={() => void onSave(f)} data-testid="button-reply-save">Save</button><button type="button" className="lnk mut" onClick={onCancel}>cancel</button>
      </div>
      <div className="mut" style={{ marginTop: 8 }}>Each reply is its own entry; the timer restarts from the latest. Without an outcome the claim goes to Decide to confirm one.</div>
    </div>
  );
}
/** A one-date form (Confirmed by supplier, Shipped, Arrived, Found) with an optional outcome. */
function DateForm({ label, hint, withOutcome, onSave, onCancel, initial }: { label: string; hint?: string; withOutcome?: boolean; initial?: string | null; onSave: (date: string, outcome: string) => Promise<void>; onCancel: () => void }) {
  const [date, setDate] = useState(initial?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [outcome, setOutcome] = useState("refund_card");
  return (
    <div data-testid="date-form">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>{label}</div>
      <div style={fieldRow}>
        <label className="mut" htmlFor="df-date">Date</label><input className="f" id="df-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 120 }} data-testid="input-date-form" />
        {withOutcome && <select className="f" aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} data-testid="select-date-form-outcome">{["refund_card", "gift_card", "store_credit", "replacement"].map((o) => <option key={o} value={o}>{CLAIM_OUTCOME_LABELS[o as ClaimOutcome]}</option>)}</select>}
        <button type="button" className="btn p" onClick={() => void onSave(date, outcome)} data-testid="button-date-form-save">Save</button><button type="button" className="lnk mut" onClick={onCancel}>cancel</button>
      </div>
      {hint && <div className="mut" style={{ marginTop: 8 }}>{hint}</div>}
    </div>
  );
}
/** A reason / text form (Write off, Dismiss, Remove). */
function TextForm({ label, placeholder, button, onSave, onCancel, danger }: { label: string; placeholder: string; button: string; danger?: boolean; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <div data-testid="text-form">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>{label}</div>
      <div style={fieldRow}>
        <input className="f" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 220 }} data-testid="input-text-form" />
        <button type="button" className={danger ? "btn" : "btn p"} style={danger ? { color: "#c97b6a" } : undefined} onClick={() => void onSave(text)} data-testid="button-text-form-save">{button}</button>
        <button type="button" className="lnk mut" onClick={onCancel}>cancel</button>
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
  const col = (label: string, el: React.ReactNode) => <label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="mut" style={{ fontSize: 11 }}>{label}</span>{el}</label>;
  return (
    <div data-testid="refund-received-form">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>Refund received</div>
      <div style={{ ...fieldRow, alignItems: "flex-end" }}>
        {col("Amount", <input className="f num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ width: 100, textAlign: "right" }} data-testid="input-refund-amount" />)}
        {col("Method", <select className="f" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} data-testid="select-refund-method">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select>)}
        {col("Date", <input className="f" type="date" value={f.refunded_at} onChange={(e) => setF({ ...f, refunded_at: e.target.value })} style={{ width: 120 }} data-testid="input-refund-date" />)}
        {col("Card / credit name", <input className="f" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} style={{ width: 130 }} data-testid="input-refund-nickname" />)}
        {col("Last 4", <input className="f num" value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} style={{ width: 64 }} data-testid="input-refund-last4" />)}
        {col("Note", <input className="f" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ width: 160 }} data-testid="input-refund-note" />)}
      </div>
      {others.length > 0 && (
        <div style={{ marginTop: 8 }} data-testid="refund-split">
          <div className="mut">One refund for several claims? Give the PO's other open claims their share; the rest ({money(mine)}) stays on this one.</div>
          {others.map((o) => (
            <label key={o.id} style={{ ...fieldRow, marginTop: 4 }}>
              <span style={{ width: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.asin ?? "whole PO"}{o.line_no ? ` line ${o.line_no}` : ""} · {o.qty ?? "?"} {CLAIM_KIND_LABELS[o.kind as ClaimKind] ?? o.kind} · {money(o.remaining)} owed</span>
              <input className="f num" value={split[o.id] ?? ""} onChange={(e) => setSplit({ ...split, [o.id]: e.target.value })} placeholder="$" style={{ width: 90, textAlign: "right" }} data-testid={`input-split-${o.id}`} />
            </label>))}
        </div>)}
      <div style={{ ...fieldRow, marginTop: 10 }}>
        <button type="button" className="btn p" disabled={!(Number(f.amount) > 0) || mine < 0} onClick={() => void submit()} data-testid="button-refund-save">Refund received</button>
        <button type="button" className="lnk mut" onClick={onCancel}>cancel</button>
        {claim.remaining != null && Number(f.amount) > 0 && mine < claim.remaining - 0.005 && <span className="amb">short by {money(claim.remaining - mine)} — the rest stays owed</span>}
      </div>
    </div>
  );
}

// ── The Do cell ───────────────────────────────────────────────────────────────

/** ONE primary button for the row's task (`.btn.p` when it is the next action, `.btn` to open the detail), plus Dismiss / Snooze where they apply. */
function DoCell({ claim, refresh, onRefund }: { claim: ClaimRowApi; refresh: () => void; onRefund: (c: ClaimRowApi) => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [form, setForm] = useState<"contact" | null>(null);
  const a = claim.action;
  const call = async (url: string, body?: unknown) => { try { await poApi(url, "POST", body ?? {}); refresh(); } catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); } };
  if (a.kind === "none") return <span className="mut">—</span>;
  if (form === "contact") {
    return <ContactForm label={a.label} onCancel={() => setForm(null)} onSave={async (f) => { await call(a.taskKind === "follow_up_supplier" && a.taskId ? `/api/pos/claims/tasks/${a.taskId}/done` : `/api/pos/claims/${claim.id}/contacted`, f); setForm(null); }} />;
  }
  const primary = a.kind === "task" && a.taskId ? () => void call(`/api/pos/claims/tasks/${a.taskId}/done`, a.taskKind === "review_suggestion" ? { decision: "open" } : {})
    : a.kind === "contact" ? () => setForm("contact")
    : a.kind === "refund" ? () => onRefund(claim)
    : () => navigate(`/claims/${claim.id}`);
  return (
    <span data-testid={`do-${claim.id}`}>
      <button type="button" className={a.kind === "detail" || a.taskKind === "review_suggestion" ? "btn" : "btn p"} onClick={primary} data-testid={`button-do-${claim.id}`}>{a.label}</button>
      {a.secondary === "dismiss" && a.taskId && <button type="button" className="lnk mut" style={{ marginLeft: 8 }} onClick={() => void call(`/api/pos/claims/tasks/${a.taskId}/done`, { decision: "dismiss" })} data-testid={`button-dismiss-${claim.id}`}>Dismiss</button>}
      {a.secondary === "snooze" && a.taskId && <button type="button" className="lnk mut" style={{ marginLeft: 8 }} onClick={() => void call(`/api/pos/claims/tasks/${a.taskId}/snooze`, { business_days: 5 })} title="Ask again in 5 business days" data-testid={`button-snooze-${claim.id}`}>Snooze</button>}
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
    <div className="cl" style={{ display: "flex", flexDirection: "column" }} data-testid="claims-page">
      <div style={{ padding: "20px 24px 0", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1>Claims</h1>
        {data && <span className="mut" data-testid="claims-header">Refunds due <b className="num" style={{ color: "#e6e3dc", fontWeight: 500 }}>{money(data.header?.due)}</b> · {data.header?.open ?? 0} open</span>}
        <span style={{ flex: 1 }} />
        <input className="f" value={s.q} onChange={(e) => setS({ ...s, q: e.target.value })} placeholder="Supplier, PO, ASIN…" aria-label="Filter claims" style={{ width: 220 }} data-testid="input-claims-filter" />
        <select className="f" value={s.kind} onChange={(e) => setS({ ...s, kind: e.target.value })} aria-label="Kind" data-testid="select-claims-kind">
          <option value="">All kinds</option>{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select>
        <button type="button" className="btn p" onClick={() => setOpening(true)} data-testid="button-open-claim">+ Open claim</button>
      </div>
      {(s.from || s.to) && <div className="mut" style={{ padding: "8px 24px 0" }} data-testid="claims-date-range">POs dated {s.from || "…"} to {s.to || "…"} <button type="button" className="lnk mut" onClick={() => setS({ ...s, from: "", to: "" })}>clear</button></div>}

      <div style={{ display: "flex", gap: 4, padding: "12px 24px 0", borderBottom: "1px solid #2a2824", flexWrap: "wrap", alignItems: "flex-end" }} data-testid="claims-tabs">
        {CLAIM_BUCKET_TABS.map((b) => (
          <button key={b} type="button" className={`tab${s.bucket.includes(b) ? " on" : ""}`} onClick={() => setS({ ...s, bucket: [b] })} data-testid={`tab-claims-${b}`}>
            {CLAIM_BUCKET_LABELS[b]} <b data-testid={`count-claims-${b}`}>{counts[b] ?? 0}</b>
          </button>))}
        {s.bucket.includes("closed") && (
          <label className="mut" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, paddingBottom: 10 }}><input type="checkbox" checked={s.dismissed} onChange={(e) => setS({ ...s, dismissed: e.target.checked })} data-testid="checkbox-claims-dismissed" /> show dismissed</label>)}
        {s.bucket.length > 1 && <span className="mut" style={{ marginLeft: "auto", paddingBottom: 10 }} data-testid="claims-combined">Refunds due: {s.bucket.map((b) => CLAIM_BUCKET_LABELS[b]).join(" + ")}</span>}
      </div>

      <div style={{ padding: "4px 12px 24px" }}>
        {error && <div style={{ color: "#c97b6a", padding: 12 }} data-testid="text-claims-error">{error}</div>}
        {!data && !error && <div className="mut" style={{ padding: 12 }}>Loading…</div>}
        {data && (
          <div className="hd" data-testid="claims-table">
            {CLAIM_COLUMNS.map((c) => <span key={c.id} title={c.kind} data-testid={`th-claims-${c.id}`}>{c.label}</span>)}
          </div>)}
        {data && needsAttention && (
          <div data-testid="claims-needs-attention">
            {groups.length === 0 && <div className="mut" style={{ padding: 12 }}>Nothing needs a hand.</div>}
            {groups.map((g) => (
              <section key={g.group} data-testid={`claims-group-${g.group}`}>
                <div className="grp">{TASK_GROUP_LABELS[g.group]} <span>· {g.rows.length}{GROUP_HINTS[g.group] ? ` · ${GROUP_HINTS[g.group]}` : ""}</span></div>
                <ClaimRows rows={g.rows} onRow={(c) => navigate(`/claims/${c.id}`)} refresh={() => void load()} onRefund={setRefundFor} />
              </section>))}
          </div>)}
        {data && !needsAttention && <ClaimRows rows={rows} onRow={(c) => navigate(`/claims/${c.id}`)} refresh={() => void load()} onRefund={setRefundFor} />}
      </div>

      {refundFor && (
        <Dialog open onOpenChange={(v) => { if (!v) setRefundFor(null); }}>
          <DialogContent dialogId="claim-refund-received" className="cl max-w-2xl" style={{ borderColor: "#2a2824" }}>
            <DialogHeader><DialogTitle style={{ fontSize: 15, fontWeight: 600 }}>{refundFor.supplier} {refundFor.order_id} · {refundFor.asin ?? "whole PO"} · {CLAIM_KIND_LABELS[refundFor.kind]}</DialogTitle><DialogDescription className="mut">Refund received — the row, linked to this claim.</DialogDescription></DialogHeader>
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
  if (!d) return <div className="mut">Loading…</div>;
  return <RefundReceivedForm claim={d.claim} payments={d.po.payments} others={d.other_open_claims} onDone={onDone} onCancel={onCancel} />;
}

const ell = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
/** The mockup's `.row`s: one grid row per claim, the Do column's controls stop the row click. */
function ClaimRows({ rows, onRow, refresh, onRefund }: { rows: ClaimRowApi[]; onRow: (c: ClaimRowApi) => void; refresh: () => void; onRefund: (c: ClaimRowApi) => void }) {
  if (rows.length === 0) return <div className="row mut" style={{ display: "block" }}>No claims here.</div>;
  return (
    <>
      {rows.map((c) => {
        const p = productText(c);
        return (
          <div key={c.id} className="row" style={{ cursor: "pointer" }} onClick={() => onRow(c)} data-testid={`row-claim-${c.id}`}>
            <span className="chk" aria-hidden="true" />
            <span style={{ minWidth: 0 }} onClick={(e) => e.stopPropagation()}><span style={{ display: "block", ...ell }} title={c.supplier}>{c.supplier}</span><Link href={`/purchase-orders/${c.po_id}`} className="num" style={{ display: "block", ...ell }} title={c.order_id}>{c.order_id}</Link></span>
            <span style={{ minWidth: 0 }}><span style={{ display: "block", ...ell }} title={p.main}>{p.main}</span><span className="mut" style={{ display: "block", ...ell }} title={p.sub}>{p.sub}</span></span>
            <span>{CLAIM_KIND_LABELS[c.kind]}{c.status === "suggested" ? <span className="amb"> · {c.found_by === "email" ? "from email" : "suggested"}</span> : null}{c.outcome && c.status !== "suggested" ? <><br /><span className="mut">{CLAIM_OUTCOME_LABELS[c.outcome]}</span></> : null}</span>
            <span className={`num${c.qty == null ? " amb" : ""}`} data-testid={`claim-qty-${c.id}`}>
              {c.qty == null ? "?" : fmtQty(c.qty)}{c.qty != null && c.ordered != null ? <span className="mut"> of {fmtQty(c.ordered)}</span> : null}
              {c.qty == null && <span className="mut"> {qtyText(c) === QTY_UNKNOWN_LABEL ? "not known yet" : qtyText(c)}</span>}
            </span>
            <span className={`num${c.amount_owed == null ? " mut" : ""}`}>{money(c.amount_owed)}{c.status === "open" && c.remaining != null && c.remaining > 0.005 && c.received > 0 ? <span className="amb"> · {money(c.remaining)} left</span> : null}</span>
            <span title={c.sentence}>{c.sentence}</span>
            <span className={`num ${c.timed_out ? "amb" : "mut"}`} title={c.bucket_since ? `since ${fmtDate(c.bucket_since)}${c.due_at ? ` · timer runs out ${fmtDate(c.due_at)}` : ""}` : ""}>{c.days_in_bucket != null ? `${c.days_in_bucket} d` : "—"}</span>
            <span onClick={(e) => e.stopPropagation()}><DoCell claim={c} refresh={refresh} onRefund={onRefund} /></span>
          </div>);
      })}
    </>
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
      <DialogContent dialogId="claim-open" className="cl max-w-2xl" style={{ borderColor: "#2a2824" }} data-testid="dialog-open-claim">
        <DialogHeader><DialogTitle style={{ fontSize: 15, fontWeight: 600 }}>Open claim</DialogTitle><DialogDescription className="mut">Find the PO by order #, ASIN or supplier, pick the line, then the kind and the quantity (Individual units).</DialogDescription></DialogHeader>
        {!picked ? (
          <div>
            <input className="f" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, ASIN or supplier" aria-label="Find the PO" style={{ width: "100%" }} data-testid="input-po-picker" />
            <div style={{ maxHeight: 288, overflow: "auto", marginTop: 8, border: "1px solid #2a2824", borderRadius: 8 }}>
              {rows.length === 0 && <div className="mut" style={{ padding: "8px 12px" }}>{q.trim().length < 2 ? "Type at least two characters." : "No PO matches."}</div>}
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setPicked(r)} className="row" style={{ display: "flex", gap: 12, width: "100%", textAlign: "left", background: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: "8px 12px" }} data-testid={`po-picker-row-${r.id}`}>
                  <span className="num" style={{ width: 160, ...ell }}>{r.order_id}</span><span style={{ width: 130, ...ell }}>{r.supplier}</span><span style={{ width: 80 }}>{fmtDate(r.order_date)}</span><span className="num">{r.asin}</span><span className="mut" style={ell}>{r.asin_name ?? ""}</span>{r.closed && <span className="mut">closed</span>}
                </button>))}
            </div>
          </div>
        ) : (
          <div>
            <div><span className="num">{picked.order_id}</span> · {picked.supplier} · {fmtDate(picked.order_date)} · <span className="num">{picked.asin}</span> <button type="button" className="ed" onClick={() => setPicked(null)}>change</button></div>
            {!po && <div className="mut" style={{ marginTop: 8 }}>Loading the PO…</div>}
            {po && asin && (asin.lines.length > 1 ? (
              <select className="f" value={lineId} onChange={(e) => setLineId(e.target.value)} style={{ marginTop: 8, maxWidth: 448 }} data-testid="select-open-claim-line">
                {asin.lines.map((l: any, i: number) => <option key={l.id} value={l.id}>line {i + 1} — {l.product_name ?? ""}</option>)}</select>) : null)}
            <div style={{ marginTop: 12 }}>
              {po && asin && line && <OpenClaimForm poId={po.po.id} line={{ id: String(line.id), product_name: line.product_name, retailer_units_per_product: line.retailer_units_per_product ?? null, qty_basis: line.qty_basis ?? null, price: line.price ?? null, adjusted_product_cost: line.adjusted_product_cost ?? null }} asinPack={asin.units_per_pack} po={po.po} onOpened={onOpened} onCancel={onClose} />}
              {po && asin && asin.lines.length === 0 && <div className="mut">This ASIN row has no product line to claim on.</div>}
            </div>
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
      <div data-testid="merge-form">
        <div style={{ fontWeight: 500, marginBottom: 10 }}>Merge into another claim on this PO</div>
        {d.other_open_claims.length === 0 ? <div className="mut">No other open claim on this PO.</div> : (
          <div style={fieldRow}>
            {d.other_open_claims.map((o) => <button key={o.id} type="button" className="btn" onClick={() => void call(`/api/pos/claims/${c.id}/merge`, "POST", { into: o.id }).then(() => navigate(`/claims/${o.id}`))} data-testid={`button-merge-into-${o.id}`}>#{o.id} · {o.asin ?? "whole PO"} · {o.qty ?? "?"} {CLAIM_KIND_LABELS[o.kind as ClaimKind] ?? o.kind}</button>)}
          </div>)}
        <div className="mut" style={{ marginTop: 8 }}>This claim's refunds and timeline move over, the quantities add up, and this claim is dismissed as merged. <button type="button" className="lnk mut" onClick={close}>cancel</button></div>
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
/** The entries "Remove this entry" undoes (the server's REMOVABLE_EVENT_TYPES): the fact each records goes with it. */
const REMOVABLE_EVENTS = ["reported", "followed_up", "checked", "supplier_reply", "supplier_confirmed", "refund_received", "outcome_set", "task_done", "timed_out"];
/** One timeline entry (the mockup's `.tl` cells: date · dot · entry), editable in place (summary and date) and removable (the fact it records is undone with it). */
function TimelineEntry({ e, call, current }: { e: ClaimDetailApi["events"][number]; call: (url: string, method: string, body?: unknown) => Promise<void>; current: boolean }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [f, setF] = useState({ at: e.at.slice(0, 10), summary: e.summary ?? "" });
  const title = EVENT_TITLES[e.type] ?? e.type.replace(/_/g, " ");
  const ok = ["refund_received", "supplier_confirmed", "closed", "replacement_arrived", "task_done", "reported", "supplier_reply", "followed_up", "checked", "reship_confirmed"].includes(e.type);
  return (
    <React.Fragment>
      <div className="d num" data-testid={`event-${e.id}`}>{fmtWhen(e.at)}</div><div className={`dot${current ? " on" : ok ? " ok" : ""}`} />
      <div className="e">
        {editing ? (
          <div style={fieldRow}>
            <input className="f" type="date" value={f.at} onChange={(ev) => setF({ ...f, at: ev.target.value })} style={{ width: 120 }} data-testid={`input-event-date-${e.id}`} />
            <input className="f" aria-label="Summary" value={f.summary} onChange={(ev) => setF({ ...f, summary: ev.target.value })} style={{ flex: 1, minWidth: 200 }} data-testid={`input-event-summary-${e.id}`} />
            <button type="button" className="btn p" onClick={() => void call(`/api/pos/claims/events/${e.id}`, "PATCH", { at: f.at !== e.at.slice(0, 10) ? f.at : undefined, summary: f.summary }).then(() => setEditing(false))} data-testid={`button-event-save-${e.id}`}>Save</button>
            <button type="button" className="lnk mut" onClick={() => setEditing(false)}>cancel</button>
          </div>
        ) : (
          <>
            <div className="t">{title}<button type="button" className="ed" onClick={() => setEditing(true)} data-testid={`button-event-edit-${e.id}`}>edit</button>
              {REMOVABLE_EVENTS.includes(e.type) && (removing
                ? <span className="mut" style={{ fontSize: 11, marginLeft: 6 }}>remove this entry and undo what it records? <button type="button" className="lnk red" style={{ fontSize: 11 }} onClick={() => void call(`/api/pos/claims/events/${e.id}`, "DELETE").then(() => setRemoving(false))} data-testid={`button-event-remove-confirm-${e.id}`}>Remove</button> <button type="button" className="ed" onClick={() => setRemoving(false)}>cancel</button></span>
                : <button type="button" className="ed" onClick={() => setRemoving(true)} data-testid={`button-event-remove-${e.id}`}>remove</button>)}</div>
            {(e.summary || e.by_name) && <div className="n" style={{ overflowWrap: "anywhere" }}>{e.summary}{e.by_name ? ` · ${e.by_name}` : ""}</div>}
          </>)}
      </div>
    </React.Fragment>
  );
}

const cardTitle = (text: string, sub?: string) => <div className="ct">{text}{sub ? <span className="mut"> {sub}</span> : null}</div>;

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
  if (error) return <div className="cl" style={{ padding: "14px 24px" }}><Link href="/claims">← Claims</Link><p style={{ color: "#c97b6a", marginTop: 12 }}>{error}</p></div>;
  if (!d) return <div className="cl mut" style={{ padding: "14px 24px" }}>Loading…</div>;
  const c = d.claim;
  const emailed = c.kind === "canceled" && c.found_by === "email";
  const open = c.status === "open";
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
  const events = [...d.events].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
  const sectionLine = { borderTop: "1px solid #2a2824", paddingTop: 12, marginTop: 12 } as const;
  return (
    <div className="cl" data-testid="claim-detail">
      <div style={{ padding: "14px 24px 0" }}><Link href="/claims" data-testid="button-back-to-claims">← Claims</Link></div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap", padding: "12px 24px 0" }}>
        <div style={{ flex: 1, minWidth: 360 }}>
          <h1 data-testid="text-claim-title">{CLAIM_KIND_LABELS[c.kind]} · {c.supplier} <Link href={`/purchase-orders/${c.po_id}`} className="num" style={{ fontWeight: 400, fontSize: 16, color: "#a39f96" }}>{c.order_id}</Link></h1>
          <div className="mut" style={{ marginTop: 6 }} data-testid="claim-subtitle">
            PO {fmtDate(c.order_date)} · {productText(c).main}{c.asin ? <> · <span className="num">{c.asin}</span></> : null} · {c.qty == null ? "quantity not known yet" : `${fmtQty(c.qty)} ${c.qty_basis === "product_legacy" ? "Product" : "Individual"} units`}
            <span style={{ margin: "0 6px" }}>·</span><span className={open && !c.reported_at && !emailed ? "amb" : ""} data-testid="claim-state">{c.sentence}</span>{c.days_open != null ? <> — open {c.days_open} days</> : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="claim-actions">
          {open && !emailed && <button type="button" className={c.reported_at ? "btn" : "btn p"} onClick={() => setSlot({ kind: "contact" })} data-testid="button-claim-contacted">Contacted supplier</button>}
          {open && <button type="button" className={c.reported_at && c.action.kind === "none" ? "btn p" : "btn"} onClick={() => setSlot({ kind: "reply" })} data-testid="button-claim-replied">Supplier replied</button>}
          {open && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="btn" data-testid="button-claim-set-outcome">Set outcome ▾</button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="cl" style={{ borderColor: "#2a2824", minHeight: 0 }}>
                {(["refund_card", "gift_card", "store_credit"] as const).map((o) => <DropdownMenuItem key={o} onClick={() => void call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: o })} data-testid={`menu-outcome-${o}`}>{CLAIM_OUTCOME_LABELS[o]}</DropdownMenuItem>)}
                <DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/outcome`, "POST", { outcome: "replacement" })} data-testid="menu-outcome-replacement">replacement</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSlot({ kind: "write_off" })} data-testid="menu-outcome-write_off">write-off…</DropdownMenuItem>
                {c.outcome && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/clear-outcome`, "POST", {})} data-testid="menu-outcome-clear">clear the outcome</DropdownMenuItem></>}
              </DropdownMenuContent>
            </DropdownMenu>)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" className="btn" data-testid="button-claim-more">More ▾</button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="cl" style={{ borderColor: "#2a2824", minHeight: 0 }}>
              {c.status !== "dismissed" && c.status !== "closed" && <DropdownMenuItem onClick={() => setSlot({ kind: "dismiss" })} data-testid="menu-more-dismiss">Dismiss this claim</DropdownMenuItem>}
              {(c.status === "closed" || c.status === "dismissed") && <DropdownMenuItem onClick={() => void call(`/api/pos/claims/${c.id}/reopen`, "POST", {})} data-testid="menu-more-reopen">Reopen</DropdownMenuItem>}
              <DropdownMenuItem disabled={!canMerge} onClick={() => setSlot({ kind: "merge" })} data-testid="menu-more-merge">Merge into another claim on this PO</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem style={{ color: "#c97b6a" }} onClick={() => setSlot({ kind: "remove" })} data-testid="menu-more-remove">Remove</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Three columns: 340 · the rest · 360, 16 px gaps (the mockup) */}
      <div style={{ display: "grid", gridTemplateColumns: "340px minmax(0, 1fr) 360px", gap: 16, padding: "16px 24px 24px", alignItems: "start" }} data-testid="claim-columns">
        {/* Left: facts, steps, linked */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div className="card" data-testid="claim-facts">
            {cardTitle("Claim", "· click a value to change it")}
            <div className="kv">
              <span className="mut">Kind</span>
              <span className="v"><select value={c.kind} disabled={!open && c.status !== "suggested"} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { kind: e.target.value })} className="f" data-testid="select-claim-kind">{CLAIM_KINDS.map((k) => <option key={k} value={k}>{CLAIM_KIND_LABELS[k]}</option>)}</select></span>
              <span className="mut">Qty</span>
              <span className="v num"><InlineEdit value={c.qty ?? ""} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { qty: v })} align="right" width="w-16" testId="claim-qty"><span className={c.qty == null ? "amb" : ""}>{c.qty == null ? "not known yet" : fmtQty(c.qty)}</span>{c.qty != null && c.qty_basis !== "product_legacy" ? <span className="mut"> {QTY_KIND.individual.replace(" units", "")} · {qtyEquivalents(c.qty, c.product_pack, c.asin_pack).replace(/ u\./g, "")}{c.ordered != null ? ` · of ${fmtQty(c.ordered)}` : ""}</span> : c.qty != null ? <span className="mut"> Product units</span> : null}</InlineEdit></span>
              <span className="mut">$ owed</span>
              <span className="v num"><InlineEdit money value={c.amount_owed == null ? null : String(c.amount_owed)} onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: v })} align="right" width="w-20" testId="claim-amount">{money(c.amount_owed)} <span className="mut">{c.amount_owed_source === "manual" ? "override" : "auto"}</span></InlineEdit>
                {c.amount_owed_source === "manual" && <button type="button" className="ed" onClick={() => void call(`/api/pos/claims/${c.id}`, "PATCH", { amount_owed: "" })} data-testid="button-claim-reset-auto">back to auto</button>}</span>
              <span className="mut">Received</span><span className="v num">{money(c.received)}</span>
              <span className="mut">Remaining</span><span className={`v num${c.remaining != null && c.remaining > 0 && open ? " amb" : ""}`} data-testid="claim-remaining">{money(c.remaining)}</span>
              <span className="mut">Outcome</span>
              <span className={`v${c.outcome ? "" : " mut"}`} data-testid="claim-outcome">{c.outcome ? <>{CLAIM_OUTCOME_LABELS[c.outcome]}{c.outcome_amount != null ? <span className="num"> {money(c.outcome_amount)}</span> : ""}{open && <button type="button" className="ed" onClick={() => void call(`/api/pos/claims/${c.id}/clear-outcome`, "POST", {})} data-testid="button-claim-clear-outcome">clear</button>}</> : "not known yet"}</span>
              <span className="mut">Return needed</span>
              <span className={`v${c.return_required ? "" : " mut"}`}><label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={c.return_required} disabled={!open} onChange={(e) => void call(`/api/pos/claims/${c.id}`, "PATCH", { return_required: e.target.checked })} data-testid="checkbox-claim-return" />{c.return_required ? "yes" : "no"}</label></span>
              <span className="mut">Found</span>
              <span className="v">{fmtMD(c.found_at)} · {c.found_by}<button type="button" className="ed" onClick={() => setSlot({ kind: "date", step: "found", label: "Found on", initial: c.found_at })} data-testid="button-claim-found">edit</button></span>
              <span className="mut">Reported</span>
              <span className={`v${c.reported_at ? "" : " mut"}`} data-testid="claim-reported">{c.reported_at ? <>{fmtMD(c.reported_at)}{c.reported_channel ? ` · ${c.reported_channel}` : ""}<button type="button" className="ed" onClick={() => setSlot({ kind: "contact" })}>edit</button></> : emailed ? "not needed (emailed cancellation)" : "— not yet"}</span>
              {c.status === "closed" && <><span className="mut">Closed</span><span className="v">{fmtMD(c.closed_at)}</span></>}
            </div>
            {c.conversion_flags.length > 0 && <div className="mut" style={{ marginTop: 8, fontSize: 11 }}>converted from the sheet era: {c.conversion_flags.join(", ")}</div>}
            <div style={{ ...sectionLine, color: "#a39f96" }}><InlineNoteBox value={c.note} label="note" testId="claim-note" onSave={async (v) => call(`/api/pos/claims/${c.id}`, "PATCH", { note: v })} /></div>
          </div>

          <div className="card" data-testid="claim-steps-card">
            {cardTitle("Steps", "· click any to set or change")}
            <div data-testid="claim-steps">
              {c.ui_steps.map((s) => (
                <div key={s.key} className={`step${s.done ? " ok" : s.current ? " on" : ""}`} data-testid={`step-${s.key}`} data-done={s.done} data-current={s.current} data-handler={s.handler.type}>
                  <span className="m">{s.done ? "✓" : s.current ? "›" : ""}</span>
                  <button type="button" disabled={s.handler.type === "none" || (!open && c.status !== "suggested")} onClick={() => openStep(s)} title={s.handler.type === "none" ? s.handler.why : "set or change"} data-testid={`button-step-${s.key}`}>{s.current && s.todo ? s.todo : s.label}{s.at ? <span className="mut"> {fmtMD(s.at)}</span> : null}</button>
                </div>))}
            </div>
            <div className="mut" style={{ marginTop: 8 }}>Steps change with the outcome: a return adds label → sent → shipped → delivered; a replacement adds promised → shipped → arrived.</div>
          </div>

          <div className="card" data-testid="claim-linked">
            {cardTitle("Linked")}
            <div className="kv" style={{ gridTemplateColumns: "90px 1fr" }}>
              <span className="mut">PO</span><span style={{ minWidth: 0, ...ell }}><Link href={`/purchase-orders/${c.po_id}`} className="num">{c.order_id}</Link> · {d.po.closed_at ? "closed" : "open"}{d.linked.po_received_individual != null ? ` · ${fmtQty(d.linked.po_received_individual)} received` : ""}</span>
              <span className="mut">Velocity</span><span className={d.linked.velocity.length ? "" : "mut"} style={{ minWidth: 0, ...ell }}>{d.linked.velocity.length ? d.linked.velocity.map((v) => `inbound #${v.velocity_order_id} (${v.asin})`).join(", ") : "no order linked"}</span>
              <span className="mut">Emails</span><span className="mut">none matched yet</span>
              <span className="mut">Tracking</span><span className={d.linked.po_tracking.length ? "" : "mut"} style={{ minWidth: 0 }}>{d.linked.po_tracking.length ? d.linked.po_tracking.map((t) => <div key={t.id} className="num" style={ell} title={`${t.carrier} ${t.tracking_number}`}>{t.carrier} {t.tracking_number} <span className="mut" style={{ fontFamily: "Inter,system-ui,sans-serif" }}>{t.delivered_at ? `delivered ${fmtMD(t.delivered_at)}` : t.carrier_status?.replace(/_/g, " ") ?? ""}</span></div>) : "none"}</span>
              <span className="mut">Documents</span><span className={d.linked.documents.length ? "" : "mut"} style={{ minWidth: 0, ...ell }}>{d.linked.documents.length ? d.linked.documents.map((x) => x.file_name).join(", ") : "none"}</span>
              {c.alt_order_ids && <><span className="mut">Alt order #s</span><span className="num" style={ell}>{c.alt_order_ids}</span></>}
            </div>
          </div>
        </div>

        {/* Middle: the timeline with the inline form band */}
        <div className="card" style={{ padding: 0, minWidth: 0 }} data-testid="claim-timeline-card">
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #2a2824", display: "flex", alignItems: "center", gap: 12 }}><span className="ct" style={{ marginBottom: 0 }}>Timeline</span><span className="mut">newest first · every entry editable</span></div>
          {slot && <div style={{ padding: "14px 16px", borderBottom: "1px solid #2a2824", background: "#1b1a18" }} data-testid="claim-slot"><SlotForm slot={slot} d={d} call={call} close={() => setSlot(null)} reload={() => void load()} /></div>}
          <div style={{ padding: 16 }} data-testid="claim-timeline">
            <div className="tl">
              {events.map((e, i) => <TimelineEntry key={e.id} e={e} call={call} current={i === 0 && open} />)}
              <div className="d num">{fmtMD(c.order_date)}</div><div className="dot" /><div className="e"><div className="t">PO placed <span className="mut" style={{ fontWeight: 400 }}>· {c.supplier}</span></div></div>
            </div>
          </div>
        </div>

        {/* Right: refunds, what happens next, more */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div className="card" data-testid="claim-refunds-card">
            {cardTitle("Refunds")}
            <div className="kv" style={{ gridTemplateColumns: "1fr auto auto" }} data-testid="claim-refunds">
              <span className="mut">Method</span><span className="mut">Applied</span><span className="mut">Date</span>
              {c.refunds.length === 0 && <span className="mut" style={{ gridColumn: "1 / 4", padding: "6px 0" }}>none yet</span>}
              {c.refunds.map((r) => <React.Fragment key={r.id}><span data-testid={`claim-refund-${r.id}`} style={ell}>{(r.method ?? "refund").replace("_", " ")}</span><span className="num">{money(r.amount_applied ?? r.amount)}</span><span className="num">{fmtMD(r.refunded_at)}</span></React.Fragment>)}
              <span style={{ borderTop: "1px solid #2a2824", paddingTop: 8 }}>Remaining</span><span className={`num${c.remaining != null && c.remaining > 0 && open ? " amb" : ""}`} style={{ borderTop: "1px solid #2a2824", paddingTop: 8 }}>{money(c.remaining)}</span><span style={{ borderTop: "1px solid #2a2824" }} />
            </div>
            {open && <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}><button type="button" className="btn" onClick={() => setSlot({ kind: "refund" })} data-testid="button-claim-refund-received">+ Refund received</button>
              {c.remaining != null && c.remaining > 0 && c.received > 0 && <button type="button" className="btn" onClick={() => setSlot({ kind: "remainder" })} data-testid="button-claim-write-off-remainder">Write off remainder</button>}</div>}
            <div className="mut" style={{ marginTop: 8 }}>Several refunds can land on one claim (two gift cards); one refund can cover several claims on the same PO.</div>
          </div>

          <div className="card" data-testid="claim-next">
            {cardTitle("What happens next")}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {c.next.map((n, i) => <div key={i}><span className={n.when === "Now" ? "amb" : "mut"}>{n.when}</span> · {n.text}</div>)}
              {open && c.due_at && <div className="mut">timer: {c.timed_out ? "ran out" : `runs out ${fmtDate(c.due_at)}`} (5 business days)</div>}
            </div>
          </div>

          <div className="card" data-testid="claim-more">
            {cardTitle("More")}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
              {c.status !== "dismissed" && c.status !== "closed" && <button type="button" className="lnk" onClick={() => setSlot({ kind: "dismiss" })} data-testid="link-more-dismiss">Dismiss this claim</button>}
              {(c.status === "closed" || c.status === "dismissed") && <button type="button" className="lnk" onClick={() => void call(`/api/pos/claims/${c.id}/reopen`, "POST", {})} data-testid="link-more-reopen">Reopen</button>}
              <button type="button" className="lnk" disabled={!canMerge} onClick={() => setSlot({ kind: "merge" })} title={canMerge ? "" : "no other open claim on this PO"} data-testid="link-more-merge">Merge into another claim on this PO</button>
              <button type="button" className="lnk red" onClick={() => setSlot({ kind: "remove" })} data-testid="link-more-remove">Remove</button>
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
