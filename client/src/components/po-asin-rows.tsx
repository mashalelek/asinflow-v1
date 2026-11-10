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
import { ChevronRight, ChevronDown, AlertTriangle, Plus, X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtQty, individualUnits, PO_ASIN_DISPLAY_COLUMNS, VELOCITY_QTY_TITLE } from "@/lib/po-qty";
import { INDIV_SHORT, PER_ASIN_UNIT, PER_PRODUCT_UNIT, QTY_KIND, individualFrom } from "@shared/quantity-kinds";
import { bundleFromLines, type BundleComponent } from "@shared/bundle";
import { InlineEdit, poApi, ReassignShipment, shipmentBlockText } from "@/components/po-edit";
import { InlineNoteCell, NoteIcon } from "@/components/inline-note";
import { claimSummary, individualEquivalents } from "@shared/supplier-claim";
import { OpenClaimButton } from "@/components/po-claims";

/** The PO header money (subtotal / discount / tax) the rows may be handed; kept as a loose shape since the refund-proposal dialog left with migration 101. */
export interface PoHeaderMoney { id: string; subtotal?: string | number | null; discount?: string | number | null; tax?: string | number | null }
import { titlePackSuggestion } from "@shared/pack-parse";
import { asinPackSetNote } from "@shared/po-form";
import { useToast } from "@/hooks/use-toast";

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
  /** "stored 0.50, ×1 gives 1.00" — the line's stored yield and the row's pack disagree ("Pack size mismatch", 2026-11-06). */
  pack_mismatch_note?: string;
  supplier_sku: string | null;
  price: string | null;
  item_discount: string | null;
  /** Product units (the view, D17); the Individual twin beside it (NULL on a product_legacy line). */
  qty_ordered: number | null;
  qty_received: number | null;
  qty_ordered_individual?: number | null;
  qty_received_individual?: number | null;
  /** Σ canceled / returned claims on the line, Product units (D14); Expected = Ordered − Σ claims that count. */
  qty_canceled?: number | null;
  qty_returned?: number | null;
  qty_expected?: number | null;
  qty_expected_individual?: number | null;
  /** individual (default) | product_legacy — the pack was not known at migration 101. */
  qty_basis?: string | null;
  asin_qty_per_product: string | null;
  /** Exact yield (migration 080): retailer units / product ÷ ASIN units / pack; NULL on an unresolved sheet-imported line. */
  retailer_units_per_product?: number | null;
  asin_units_per_pack?: number | null;
  /** Bundle component (migration 100): units of this product in one bundle; NULL = not known (an even split is proposed, amber). */
  units_per_bundle?: number | null;
  adjusted_product_cost: string | null;
  notes: string | null;
  /** Row-level Status: this product's action items. */
  action_items?: string[];
}
export interface PoAsinRowData {
  id: string;
  /** Open supplier claims on this ASIN row's lines (SPEC §22 "Supplier claims", migration 101). */
  claims_open?: OpenClaimBrief[];
  open_claims?: number;
  /** individual (default) | asin_legacy — the pack was not known at migration 101; the Individual twins are NULL then. */
  qty_basis?: string | null;
  /** Σ Individual units ordered (NULL on a legacy row). */
  qty_individual?: number | null;
  qty_shipped_supplier_individual?: string | null;
  received_velocity_individual?: string | null;
  qty_at_prep_individual?: string | null;
  qty_at_warehouse_individual?: string | null;
  qty_lost_damaged_us_individual?: string | null;
  qty_shipped_fba_individual?: string | null;
  qty_received_amazon_individual?: string | null;
  qty_canceled_individual?: string | null;
  qty_returned_individual?: string | null;
  /** Ordered − Σ claims that count, ASIN units (po_asin_expected). */
  qty_expected_asin?: string | null;
  po_id: string;
  asin: string;
  asin_name: string | null;
  sku: string | null;
  qty: number;                       // Ordered (ASIN qty)
  cost_per_unit: string | null;
  total_cost: string | null;
  prep_cost: string | null;
  /** NULL = not known ("Pack size missing", 2026-11-06). */
  sold_as: string | null;
  units_per_pack: number | null;
  notes: string | null;
  thumbnail: string | null;
  // Σ canceled / returned claims on the lines, ASIN units (D14; a bundle by the bundle rule)
  qty_canceled_asin: string | null;
  qty_returned_asin: string | null;
  // stored ASIN quantities (NULL = not tracked)
  qty_shipped_supplier: string | null;
  /** Received by Velocity (2026-11-02): cumulative units Velocity ever checked in, ASIN units; NULL = never seen at Velocity. */
  received_velocity: string | null;
  qty_at_prep: string | null;
  qty_at_warehouse: string | null;
  qty_lost_damaged_us: string | null;
  qty_shipped_fba: string | null;
  qty_received_amazon: string | null;
  shipments: PoAsinShipment[];
  /** Union of the product lines' action items (row-level Status 2026-10-17). */
  action_items?: string[];
  /** "Extra units shipped" note — the picker's overshoot confirm or the manual clear (migration 073). */
  extra_units_note?: string | null;
  /** Each mismatched line's yield note, joined (the row's "Pack size mismatch" hover). */
  pack_mismatch_note?: string;
  lines?: PoAsinLine[];
}

// Widths (px) sized to what each column holds; header labels wrap to two or three lines inside them
// (2026-11-01: labels overlapped their neighbours). Product takes what is left (fixed layout, no width).
// 2026-11-05 (Maria: the right-hand columns clipped at 1440, 160 rem): 17 display columns, fixed px + lead / note + Product (min 84).
// 2026-11-09 (quantity names): each quantity header carries the muted "ASIN units" line, so a quantity column is at least 56 px
// (the kind line on one line) and wide enough for its label in two lines, never three; 1,052 px fixed + 60 + Product → 120 px for
// Product at 1280 (1,232 px box), 286 px at 1440.
const COL_WIDTHS: Record<Exclude<(typeof PO_ASIN_DISPLAY_COLUMNS)[number]["key"], "product">, number> = {
  ordered: 66, cost_per_unit: 60, total_cost: 72, prep: 44, sold_as: 80,
  canceled: 56, returned: 56, shipped_supplier: 66, received_velocity: 70, at_prep: 56, at_warehouse: 68, lost_damaged_us: 92,
  shipped_fba: 56, received_amazon: 70, shipments: 64, action_items: 76,
};
const LEAD_WIDTH = 32, NOTE_WIDTH = 28;
/** The fixed widths plus Product's minimum (84 px: the ASIN in full) — below it the table scrolls inside its own box, never the page. */
export const PO_ASIN_TABLE_MIN_WIDTH = `${Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + LEAD_WIDTH + NOTE_WIDTH + 84}px`;
/** Product, Ordered, Sold As show two model columns each (PO_ASIN_DISPLAY_COLUMNS). */
const MERGED_TITLES = {
  product: "ASIN · Amazon SKU, then the title",
  ordered: "Ordered in ASIN units; under it, the Individual units = ASIN units × Individual units per ASIN unit",
  sold_as: "Sold as; under it, Individual units per ASIN unit (the pack size)",
} as const;
/** Header tooltips (Maria 2026-11-02): the two Velocity quantities explain each other. */
const COL_TITLES: Partial<Record<(typeof PO_ASIN_DISPLAY_COLUMNS)[number]["key"], string>> = { ...MERGED_TITLES, received_velocity: VELOCITY_QTY_TITLE, at_prep: VELOCITY_QTY_TITLE };

function Money({ v }: { v: string | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const n = parseFloat(v);
  const text = `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <span className={`font-mono ${n === 0 ? "text-muted-foreground/50" : ""}`}>{text}</span>;
}
/**
 * The grey Individual-units line under a quantity (SPEC §22 "Quantity vocabulary",
 * 2026-11-09): stored × Individual units per ASIN unit; "—" when the pack size is
 * NULL, never 0; nothing when the quantity itself is not tracked.
 */
export function IndivLine({ v, perUnit, individual, testId }: { v: string | number | null | undefined; perUnit: number | string | null | undefined; /** The stored Individual units (D17) when the API carries them; else × the pack. */ individual?: string | number | null; testId?: string }) {
  if (v == null || v === "") return null;
  const n = individual != null && individual !== "" ? Number(individual) : individualFrom(v, perUnit);
  return (
    <div className="whitespace-nowrap text-[11px] text-muted-foreground" title={`${QTY_KIND.individual} = ${QTY_KIND.asin} × ${PER_ASIN_UNIT}`} data-testid={testId}>
      {n == null ? <span className="text-muted-foreground/50" data-testid={testId ? `${testId}-unknown` : undefined}>—</span> : fmtQty(n)} {INDIV_SHORT}
    </div>
  );
}

/**
 * A bundle component line's Ordered (Maria 2026-11-09): the line counts Product
 * units while the ASIN row above counts ASIN units, so the cell names its kind
 * in grey ("Product u.") and shows its own Individual count from the line's
 * Product pack (qty × Individual units per Product unit; "—" when that is NULL).
 */
export function ComponentQty({ l, a }: { l: { id: string; qty_ordered: number | null; qty_ordered_individual?: number | null; retailer_units_per_product?: number | null; units_per_bundle?: number | null }; a: Pick<PoAsinRowData, "sold_as" | "units_per_pack" | "lines"> }) {
  const n = l.qty_ordered_individual ?? individualFrom(l.qty_ordered, l.retailer_units_per_product);
  // The bundle rule (migration 100, Maria 2026-11-09): this component's units in one bundle (typed, else the even split proposed in amber) and what is left over after the bundles.
  const comp = bundleComponentOf(a, l.id);
  return (
    <>
      <QtyCell v={l.qty_ordered} />
      <div className="whitespace-nowrap text-[10px] text-muted-foreground/70" title={`${QTY_KIND.product} — items as sold on the supplier's site; the ASIN row above counts ${QTY_KIND.asin}`} data-testid={`component-kind-${l.id}`}>Product u.</div>
      {l.qty_ordered != null && (
        <div className="whitespace-nowrap text-[11px] text-muted-foreground" title={`${QTY_KIND.individual} = ${QTY_KIND.product} × ${PER_PRODUCT_UNIT}`} data-testid={`component-indiv-${l.id}`}>
          {n == null ? <span className="text-muted-foreground/50">—</span> : fmtQty(n)} {INDIV_SHORT}
        </div>
      )}
      {/* Compact: the Ordered column is 66 px — "1 / bundle", amber while the count is only proposed (the Products tab says so in words). */}
      {comp && <div className={`whitespace-nowrap text-[10px] ${comp.proposed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground/70"}`} title={comp.proposed ? `Units of this product in one bundle: ${comp.perBundle}, PROPOSED (an even split of ×N) — confirm or type it on the Products tab` : `Units of this product in one bundle: ${comp.perBundle}`} data-testid={`component-per-bundle-${l.id}`} data-proposed={comp.proposed ? "yes" : undefined}>{comp.perBundle} / bundle</div>}
      {comp && comp.leftover > 0.005 && <div className="whitespace-nowrap text-[10px] text-amber-700 dark:text-amber-400" title="Individual units of this product left over after the bundles — shown, never hidden" data-testid={`component-leftover-${l.id}`}>{fmtQty(comp.leftover)} left over</div>}
    </>
  );
}

/** A bundle row's rule result for one of its lines (null on a non-bundle row or a row with one line). */
export function bundleComponentOf(a: Pick<PoAsinRowData, "sold_as" | "units_per_pack" | "lines">, lineId: string): BundleComponent | null {
  const lines = a.lines ?? [];
  if (a.sold_as !== "bundle" || lines.length < 2) return null;
  const k = lines.findIndex((x) => x.id === lineId);
  return k < 0 ? null : bundleFromLines(lines, a.units_per_pack).components[k] ?? null;
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
// Sentence case (Maria 2026-10-29) — the server stores these exact labels (po_line_action_items, migration 074).
// "Missing / damaged from supplier" and "Confirm refund / replacement" left with claims commit 1 (migration 101): those are claims now.
export const ACTION_ITEM_OPTIONS = ["Need to return", "ATTN: Velocity", "See comments", "SHIP", "Received - FBM",
  // Capture PO patch (2026-10-31): set by the system (confirmation-email reconcile, subscriptions), cleared by hand.
  "Confirm order details", "Subscription renews", "Review renewal PO", "Subscription may be active"];
// §7: tinted chips only. SHIP indigo; Received - FBM green; Need to return orange; the attention items amber.
export const EXTRA_UNITS_SHIPPED = "Extra units shipped";
export const PACK_SIZE_MISMATCH = "Pack size mismatch";
/** Derived (2026-10-29; named so 2026-11-07, was "Receiving mismatch"): Received by Amazon ≠ Shipped FBA. Information only. */
export const FBA_RECEIVING_MISMATCH = "FBA receiving mismatch";
export const FBA_RECEIVING_MISMATCH_MEANING = "Received by Amazon ≠ Shipped FBA, in ASIN units (information only; never blocks auto-close)";
export function actionChipClass(item: string): string {
  const t = item.toLowerCase();
  // Red so it stands out (Maria 2026-10-29).
  if (item === EXTRA_UNITS_SHIPPED) return "bg-red-500/15 text-red-600 dark:text-red-400 font-medium";
  if (t === "ship") return "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
  if (t === "received - fbm") return "bg-green-500/10 text-green-700 dark:text-green-400";
  if (t === "need to return") return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
  if (t === "subscription renews") return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}
export const chipBase = "inline-block rounded-sm px-1.5 py-0.5 text-[11px] whitespace-nowrap";
/** Shown (never editable): the auto-managed "Review Velocity" (SPEC §26) and the pack-size items (derived from the ASIN row) after the manual items. */
export const DISPLAY_ACTION_ITEMS = [...ACTION_ITEM_OPTIONS, EXTRA_UNITS_SHIPPED, "Review Velocity", "Pack size missing", "Pack size mismatch", FBA_RECEIVING_MISMATCH,
  // One-off (2026-11-05, server/tracking-replacement-pair.ts): derived, resolves when the tracking is added.
  "Tracking also goes to 200015557295492 (1 replacement single)",
  // A PO with no document from the day after its order date (2026-11-05); the hover names the reason.
  "No invoice saved"];
const ordered = (items: readonly string[] | undefined) => DISPLAY_ACTION_ITEMS.filter((o) => (items ?? []).includes(o));

/** Read-only chips (the POs-page column: union over all lines). */
/** `reasons`: the open "Review Velocity" reasons (SPEC §26) — shown on that chip's hover. `titles`: hover text per item (Extra units shipped). */
/** Per item: how many of the PO's lines carry it (PO table v2 §4 `action_item_lines`). */
export interface ActionItemLines { lines: number; of: number; asins: string[]; reasons: string[] }
/** An open supplier claim as the list rows carry it (server/supplier-claims.ts briefOf, SPEC §22 "Supplier claims"). qty in Individual units. */
export interface OpenClaimBrief { id: number; po_line_item_id: string | null; asin: string | null; line_no: number; kind: string; qty: number; amount_owed: number | null; remaining: number | null; note: string | null; status: string; outcome: string | null; open_tasks: number }
/**
 * Claims are NOT action items (SPEC §22 "Supplier claims" §5, commit 2): the ASIN row / line shows a small "N open" link to the
 * Claims page beside its Open claim control (LineClaims), never a chip in the Action Items cell.
 */
export function ClaimsNote({ claims, orderId, testId }: { claims: readonly OpenClaimBrief[] | undefined; /** The PO's order # or id — the Claims page filters on either. */ orderId?: string; testId?: string }) {
  if (!claims?.length) return null;
  const each = claims.map((d) => `${d.asin ?? "whole PO"}${d.po_line_item_id ? ` line ${d.line_no}` : ""}: ${claimSummary([d])}${d.outcome ? ` · ${d.outcome.replace("_", " ")}` : ""}${d.note ? ` — ${d.note}` : ""}`);
  const text = `${claims.length} open claim${claims.length === 1 ? "" : "s"}`;
  const title = `Open supplier claims (${QTY_KIND.individual}):\n${each.join("\n")}`;
  return orderId
    ? <Link href={`/claims?po=${encodeURIComponent(orderId)}`} className="text-[10px] text-amber-700 dark:text-amber-400 whitespace-nowrap hover:underline underline-offset-2" title={title} data-testid={testId ?? "claims-note"} onClick={(e) => e.stopPropagation()}>{text}</Link>
    : <span className="text-[10px] text-amber-700 dark:text-amber-400 whitespace-nowrap" title={title} data-testid={testId ?? "claims-note"}>{text}</span>;
}
/** Hover for a PO-row chip: which lines carry it, and the auto reasons. */
export function lineDetailTitle(item: string, d: ActionItemLines | undefined): string | undefined {
  if (!d) return undefined;
  const where = d.lines === d.of ? `all ${d.of} line${d.of === 1 ? "" : "s"}` : `${d.lines} of ${d.of} lines`;
  return `${item}: ${where} — ${d.asins.join(", ")}${d.reasons.length ? ` · ${d.reasons.join(" · ")}` : ""}`;
}
/** The item's meaning first where it has one (FBA receiving mismatch), then the line detail. */
function withMeaning(item: string, detail: string | undefined): string | undefined {
  if (item !== FBA_RECEIVING_MISMATCH) return detail;
  return detail ? `${FBA_RECEIVING_MISMATCH_MEANING}\n${detail}` : FBA_RECEIVING_MISMATCH_MEANING;
}
/** At most this many chips show; the rest collapse into "+N" (PO table v2 §5). */
export const MAX_CHIPS = 2;
/**
 * `reasons`: the open "Review Velocity" reasons (SPEC §26) — shown on that chip's hover. `titles`: hover text per item (Extra units shipped).
 * `lines`: per-item line counts — a "·N" badge when fewer than all lines carry it, the lines on hover.
 */
export function ActionItemChips({ items, testId, reasons, titles, lines }: { items: readonly string[] | undefined; testId?: string; reasons?: readonly string[] | null; titles?: Readonly<Record<string, string>>; lines?: Readonly<Record<string, ActionItemLines>> }) {
  const list = ordered(items);
  const shown = list.length > MAX_CHIPS ? list.slice(0, MAX_CHIPS) : list;
  const rest = list.slice(shown.length);
  return (
    <span className="flex flex-wrap items-start gap-0.5" data-testid={testId}>
      {list.length === 0 ? <span className="text-muted-foreground/40 text-[11px]">—</span> : shown.map((it) => {
        const d = lines?.[it];
        return (
          <span key={it} className={`${chipBase} ${actionChipClass(it)} max-w-full truncate`} title={titles?.[it] ?? withMeaning(it, lineDetailTitle(it, d)) ?? (it === "Review Velocity" && reasons?.length ? reasons.join(" · ") : it)}>
            {it}{d && d.lines < d.of ? <span className="ml-1 opacity-70" data-testid={`chip-count-${it}`}>·{d.lines}</span> : null}
          </span>
        );
      })}
      {rest.length > 0 && <span className={`${chipBase} bg-muted text-muted-foreground`} title={rest.join(" · ")} data-testid="chip-more">+{rest.length}</span>}
    </span>
  );
}

/**
 * Chips + multi-select editor. `url` is the PO route (every line), the ASIN
 * route (every line of the ASIN) or the product-line route. `lineCount` > 1 →
 * each change asks "Apply to all N lines" before it is saved (PO table v2 §5).
 */
export function ActionItemsEditor({ items, url, onSaved, testId, titles, lines, lineCount = 1, reasons }: {
  items: readonly string[] | undefined; url: string; onSaved?: () => void; testId: string; titles?: Readonly<Record<string, string>>;
  lines?: Readonly<Record<string, ActionItemLines>>; lineCount?: number; reasons?: readonly string[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(items ?? []));
  const [pending, setPending] = useState<{ next: Set<string>; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: Set<string>) => {
    setDraft(next); setErr(null); setPending(null);
    try { await patchJson(url, "PATCH", { action_items: Array.from(next) }); onSaved?.(); } catch (e: any) { setErr(e.message); }
  };
  const toggle = (opt: string) => {
    const next = new Set(draft); const adding = !next.has(opt);
    if (adding) next.add(opt); else next.delete(opt);
    if (lineCount > 1) setPending({ next, label: `${adding ? "Add" : "Remove"} "${opt}" ${adding ? "to" : "from"} all ${lineCount} lines?` });
    else void save(next);
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); setPending(null); if (v) setDraft(new Set(items ?? [])); }}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="min-h-[1.25rem] min-w-[3rem] max-w-full text-left" data-testid={testId} title="Edit action items">
          <ActionItemChips items={items} titles={titles} lines={lines} reasons={reasons} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 space-y-1" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1">Action items</div>
        {ACTION_ITEM_OPTIONS.map((opt) => (
          <label key={opt} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
            <input type="checkbox" checked={pending ? pending.next.has(opt) : draft.has(opt)} disabled={pending != null} onChange={() => toggle(opt)} className="h-3 w-3 accent-blue-500" />
            <span className={`${chipBase} ${actionChipClass(opt)}`}>{opt}</span>
          </label>
        ))}
        {pending && (
          <div className="rounded border border-border bg-muted/50 p-2 text-xs space-y-1" data-testid={`${testId}-confirm`}>
            <div>{pending.label}</div>
            <div className="flex gap-1">
              <button type="button" onClick={() => void save(pending.next)} className="rounded bg-primary px-2 py-0.5 text-primary-foreground" data-testid={`${testId}-confirm-apply`}>Apply to all {lineCount} lines</button>
              <button type="button" onClick={() => setPending(null)} className="rounded px-2 py-0.5 hover:bg-muted">Cancel</button>
            </div>
          </div>
        )}
        {err && <div className="px-2 text-xs text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** Hover for "Extra units shipped": shipped vs ordered, then the note. */
export function extraUnitsTitle(a: Pick<PoAsinRowData, "qty" | "qty_shipped_fba" | "extra_units_note">): string {
  return `Shipped FBA ${fmtQty(a.qty_shipped_fba ?? 0)} of ${fmtQty(a.qty)} ordered, in ASIN units${a.extra_units_note ? ` — ${a.extra_units_note}` : ""}`;
}
/** Hover for "FBA receiving mismatch" on an ASIN row: the two numbers. */
export const fbaReceivingTitle = (a: Pick<PoAsinRowData, "qty_shipped_fba" | "qty_received_amazon">): string =>
  `Received by Amazon ${fmtQty(a.qty_received_amazon ?? 0)} ≠ Shipped FBA ${fmtQty(a.qty_shipped_fba ?? 0)}, in ASIN units (information only; never blocks auto-close)`;
const extraTitles = (a: PoAsinRowData): Record<string, string> => ({ [EXTRA_UNITS_SHIPPED]: extraUnitsTitle(a), [FBA_RECEIVING_MISMATCH]: fbaReceivingTitle(a), ...(a.pack_mismatch_note ? { [PACK_SIZE_MISMATCH]: a.pack_mismatch_note } : {}) });
/** A PO's hover titles plus "Pack size mismatch" from its rows' yield notes (each row's lines, one per row). */
export function poActionTitles(titles: Readonly<Record<string, string>> | undefined, asins: readonly { pack_mismatch_note?: string }[] | undefined): Record<string, string> {
  const notes = (asins ?? []).map((a) => a.pack_mismatch_note).filter(Boolean);
  return notes.length ? { ...titles, [PACK_SIZE_MISMATCH]: notes.join("\n") } : { ...titles };
}
const lineTitles = (l: PoAsinLine): Record<string, string> | undefined => l.pack_mismatch_note ? { [PACK_SIZE_MISMATCH]: l.pack_mismatch_note } : undefined;

/** Clear "Extra units shipped" by hand — the note is required (stored on the row, logged in History). */
function ClearExtraUnits({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await patchJson(`/api/pos/asin-rows/${a.id}/extra-units/clear`, "POST", { note }); setOpen(false); setNote(""); onChanged?.(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="mt-0.5 block text-[10px] text-muted-foreground hover:text-foreground" data-testid={`button-clear-extra-units-${a.asin}`}>clear…</button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2 space-y-1 text-xs" align="end" onClick={(e) => e.stopPropagation()}>
        <div>{extraUnitsTitle(a)}</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the extra ASIN units shipped are OK (required)" rows={3}
          className="w-full rounded border border-input bg-background p-1 text-xs" data-testid={`input-clear-extra-units-${a.asin}`} />
        <button type="button" disabled={!note.trim()} onClick={() => void save()} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid={`button-confirm-clear-extra-units-${a.asin}`}>Clear with note</button>
        {err && <div className="text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** "Mark canceled" (§2.2; D14 since migration 101): every line of the ASIN gets an OPEN canceled claim for its units still expected — the claim carries the $ owed, nothing edits Ordered. */
function MarkCanceled({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void; po?: PoHeaderMoney }) {
  const [err, setErr] = useState<string | null>(null);
  // §5.1: no cancel while this ASIN row has units shipped to FBA.
  const blocked = shipmentBlockText(a.shipments ?? []);
  if (blocked) return <span className="ml-1 text-[10px] text-muted-foreground/40 cursor-not-allowed" title={blocked} data-testid={`button-cancel-asin-${a.asin}-blocked`}>cancel</span>;
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation(); setErr(null);
    if (!window.confirm(`Mark ${a.asin} canceled? Every product line of this ASIN gets an open canceled claim for its units still expected (the $ owed is on the claim; tick "Refund received" when it posts).`)) return;
    try { await patchJson(`/api/pos/asin-rows/${a.id}/cancel`, "POST"); onChanged?.(); }
    catch (er: any) { setErr(er.message); }
  };
  return <button onClick={go} className="ml-1 text-[10px] text-muted-foreground hover:text-destructive" title={err ?? "Mark this ASIN canceled (an open canceled claim per line)"} data-testid={`button-cancel-asin-${a.asin}`}>cancel</button>;
}

/**
 * A hand-entered quantity cell (At CQG Warehouse, Lost/damaged by us, Shipped
 * by Supplier): click to edit, Enter/blur saves, Escape cancels, empty = not
 * tracked (NULL). Typed and stored in INDIVIDUAL units (D16 / D17, migration
 * 101) — the field is labelled, the Product / ASIN equivalents show beside it
 * as you type — while the cell keeps showing the ASIN units. A legacy row (pack
 * not known) still takes ASIN units and says so. The server re-runs auto-close.
 */
function EditableQty({ rowId, col, v, individual, a, onChanged }: { rowId: string; col: "qty_at_warehouse" | "qty_lost_damaged_us" | "qty_shipped_supplier"; v: string | null; individual?: string | number | null; a: Pick<PoAsinRowData, "qty_basis" | "units_per_pack" | "lines">; onChanged?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const legacy = a.qty_basis === "asin_legacy";
  const stored = legacy ? v : individual ?? (v == null ? null : individualFrom(v, a.units_per_pack));
  const productPack = (a.lines ?? []).length === 1 ? a.lines![0].retailer_units_per_product : null;
  const start = () => { setDraft(stored == null ? "" : fmtQty(stored)); setErr(null); setEditing(true); };
  const save = async () => {
    setEditing(false);
    const next = draft.trim() === "" ? null : draft.trim();
    if ((next ?? "") === (stored == null ? "" : fmtQty(stored))) return;
    try { await patchJson(`/api/pos/asin-rows/${rowId}/quantities`, "PATCH", { [col]: next }); onChanged?.(); }
    catch (e: any) { setErr(e.message); }
  };
  if (editing) {
    const n = Number(draft);
    const eq = legacy || !(n >= 0) || draft.trim() === "" ? null : individualEquivalents(n, productPack, a.units_per_pack);
    return (
      <span className="block text-right" data-testid={`editing-${col}-${rowId}`}>
        <span className="block text-[9px] leading-tight text-muted-foreground" data-testid={`kind-${col}-${rowId}`}>{legacy ? `${QTY_KIND.asin} (pack not known)` : QTY_KIND.individual}</span>
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          onClick={(e) => e.stopPropagation()}
          className="h-6 w-full max-w-16 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-${col}-${rowId}`} />
        {eq && (eq.product != null || eq.asin != null) && <span className="block text-[10px] text-muted-foreground whitespace-nowrap" data-testid={`equiv-${col}-${rowId}`}>{[eq.product != null ? `${fmtQty(eq.product)} Product u.` : null, eq.asin != null ? `${fmtQty(eq.asin)} ASIN u.` : null].filter(Boolean).join(" · ")}</span>}
      </span>
    );
  }
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); start(); }} className="w-full text-right hover:underline decoration-dotted" title={err ?? (legacy ? "Click to edit (ASIN units — the pack size is not known)" : `Click to edit — typed in ${QTY_KIND.individual}`)} data-testid={`button-edit-${col}-${rowId}`}>
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
  // "+ add" (2026-11-05): the column is a narrow fixed one; the chip truncates with its full text on hover.
  const chipText = shipments.length === 0 ? "+ add"
    : shipments.length === 1 ? `${shipmentLabel(shipments[0])} · ${fmtQty(total)} ASIN u.`
    : `${shipments.length} shipments · ${fmtQty(total)} ASIN u.`;
  // Group by Velocity ship date (D1), newest first.
  const groups = new Map<string, PoAsinShipment[]>();
  for (const s of [...shipments].sort((a, b) => String(b.shipped_at ?? "").localeCompare(String(a.shipped_at ?? "")))) { const k = s.shipped_at ?? "no date"; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70" data-testid="po-shipments-chip"
          title={shipments.length === 0 ? "Add a shipment ID" : chipText}>
          {unmatched && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" data-testid="po-shipments-unmatched-glyph" />}
          <span className="truncate">{chipText}</span>
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
                    <div className="text-muted-foreground" title={received == null ? "not yet matched to Seller Central" : `received ${fmtQty(received)} of ${fmtQty(shipped)} ASIN units`}>
                      {fmtQty(shipped)} ASIN u. shipped{received == null ? "" : ` · received ${fmtQty(received)} of ${fmtQty(shipped)}`} · {s.source}{s.assigned_by === "manual" ? " · assigned by hand" : ""}
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
            <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="ASIN u." title="ASIN units" className="h-6 w-14 rounded border border-input bg-background px-1 text-right text-xs" data-testid={`input-shipment-qty-${rowId}`} />
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
      {PO_ASIN_DISPLAY_COLUMNS.map((c) => <col key={c.key} style={c.key === "product" ? undefined : { width: COL_WIDTHS[c.key] }} />)}
      <col style={{ width: NOTE_WIDTH }} />
    </colgroup>
  );
}

export function PoAsinHeaderRow({ sub = false }: { sub?: boolean }) {
  // Header labels wrap to two lines inside their fixed column (never nowrap: the labels overlapped at every width).
  // Words never split (2026-11-05): each column is at least its longest label word at 10.5 px.
  const base = `px-1 py-2 text-[10.5px] font-medium leading-tight align-bottom whitespace-normal ${sub ? "text-muted-foreground" : ""}`;
  return (
    <tr className={sub ? "bg-muted/40" : "table-header-stone"} data-testid="po-asin-header">
      <th className={base}></th>
      {PO_ASIN_DISPLAY_COLUMNS.map((c) => (
        <th key={c.key} className={`${base} ${c.align === "right" ? "text-right" : "text-left"}`} title={COL_TITLES[c.key]}>
          {"kind" in c && c.kind ? <span className="block text-[9px] font-normal opacity-60" data-testid={`po-asin-kind-${c.key}`}>{c.kind}</span> : null}
          {c.label}
        </th>
      ))}
      <th className={base}></th>
    </tr>
  );
}

/**
 * Sold as + units / pack on the ASINs tab (2026-11-06). A pack not known shows "— choose —" in amber (never a real
 * option), or the title's pack as an unconfirmed amber suggestion; individual saves at once (×1), multi-pack opens a
 * units field and saves both together; the server keeps the lines' yield and logs History.
 */
function PackEdit({ a, onChanged }: { a: PoAsinRowData; onChanged?: () => void }) {
  const unknown = a.sold_as == null;
  const sug = unknown ? titlePackSuggestion(a.asin_name) : null;
  const [draft, setDraft] = useState<{ sold_as: string; units: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();
  const save = async (sold_as: string, units?: number) => {
    setErr(null);
    try {
      const r = await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", sold_as === "individual" ? { sold_as, units_per_pack: 1 } : units != null ? { sold_as, units_per_pack: units } : { sold_as });
      if (r?.asinPackSet) toast({ title: "Pack size set in AF", description: asinPackSetNote(r.asinPackSet) });
      setDraft(null); onChanged?.();
    } catch (e: any) { setErr(e.message); }
  };
  const choose = (v: string) => {
    if (v === "individual" || v === "bundle") return void save(v);
    if (v === "multi-pack") setDraft({ sold_as: v, units: a.sold_as === "multi-pack" && a.units_per_pack ? String(a.units_per_pack) : sug?.sold_as === "multi-pack" ? String(sug.units_per_pack) : "" });
  };
  const shown = draft?.sold_as ?? a.sold_as ?? sug?.sold_as ?? "";
  const amber = unknown && !draft;
  return (
    <div className="space-y-0.5" data-testid={`pack-${a.id}`} data-pack-missing={unknown ? (sug ? "suggested" : "yes") : undefined}>
      <select value={shown} onClick={(e) => e.stopPropagation()} onChange={(e) => choose(e.target.value)}
        className={`h-6 w-full min-w-0 rounded border bg-background px-0.5 text-[11px] ${amber ? "border-amber-500 text-amber-700 dark:text-amber-400" : "border-input"}`} data-testid={`select-sold_as-${a.id}`} title={err ?? undefined}>
        {unknown && !sug && <option value="">— choose —</option>}
        {["individual", "multi-pack", "bundle"].map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {draft ? (
        <div className="flex items-center gap-0.5 text-[11px]">
          <span>×</span>
          <input autoFocus value={draft.units} inputMode="numeric" onChange={(e) => setDraft({ ...draft, units: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void save(draft.sold_as, Number(draft.units)); if (e.key === "Escape") setDraft(null); }}
            className="h-5 w-10 rounded border border-input bg-background px-1 text-right" data-testid={`input-units_per_pack-${a.id}`} />
          <button type="button" className="text-primary hover:underline" onClick={() => void save(draft.sold_as, Number(draft.units))} data-testid={`button-pack-save-${a.id}`}>save</button>
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setDraft(null); setErr(null); }}>cancel</button>
        </div>
      ) : unknown ? (
        <div className="text-[11px] text-amber-700 dark:text-amber-400" data-testid={`pack-missing-${a.id}`}>
          {sug ? <>title says {sug.text} · <button type="button" className="underline" onClick={() => void save(sug.sold_as, sug.sold_as === "individual" ? undefined : sug.units_per_pack)} data-testid={`button-pack-confirm-${a.id}`}>confirm</button></> : "pack size missing"}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground" title={PER_ASIN_UNIT}><span>×</span>{a.sold_as === "multi-pack" ? <InlineEdit value={a.units_per_pack} onSave={async (v) => { await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", { units_per_pack: v }); onChanged?.(); }} width="w-12" testId={`units_per_pack-${a.id}`}>{a.units_per_pack}</InlineEdit> : a.units_per_pack}</div>
      )}
      {err && <div className="text-[11px] text-destructive" data-testid={`pack-error-${a.id}`}>{err}</div>}
    </div>
  );
}

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;

/**
 * Supplier claims on a line (SPEC §22 §5): the "N open" link to the Claims page (filtered to the PO) and, when editable, Open
 * claim — kind, qty in Individual units prefilled from the gap when AF knows it (a one-line row: Expected − Received by
 * Velocity), note. Never in the Action Items cell.
 */
function LineClaims({ a, line, editable, onChanged }: { a: PoAsinRowData; line: PoAsinLine | null; editable: boolean; onChanged?: () => void }) {
  const claims = line ? (a.claims_open ?? []).filter((d) => d.po_line_item_id === line.id) : a.claims_open ?? [];
  if (!editable && !claims.length) return null;
  // The gap in Individual units: a one-line row's Expected − Received by Velocity (when Velocity has checked in fewer).
  const expected = line?.qty_expected_individual != null ? Number(line.qty_expected_individual) : null;
  const received = a.received_velocity_individual != null && (a.lines ?? []).length === 1 ? Number(a.received_velocity_individual) : null;
  const gap = expected != null && received != null && received < expected ? Math.round((expected - received) * 100) / 100 : null;
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <ClaimsNote claims={claims} orderId={a.po_id} testId={line ? `claims-note-${line.id}` : `claims-note-${a.asin}`} />
      {editable && line && <OpenClaimButton poId={a.po_id} line={{ id: line.id, product_name: line.product_name, retailer_units_per_product: line.retailer_units_per_product ?? null, qty_basis: line.qty_basis ?? null, price: line.price, adjusted_product_cost: line.adjusted_product_cost }} asinPack={a.units_per_pack} gap={gap} onOpened={onChanged} />}
    </span>
  );
}

/** One ASIN row (plus its bundle component lines when expanded). `editable` enables the hand-entered quantities and manual shipments. */
export function PoAsinRow({ a, indent = false, editable = false, onChanged, po }: { a: PoAsinRowData; indent?: boolean; editable?: boolean; onChanged?: () => void; /** The PO header money for the due-refund proposal after "cancel". */ po?: PoHeaderMoney }) {
  const [open, setOpen] = useState(false);
  const lines = a.lines ?? [];
  const multi = lines.length >= 2;
  const pad = indent ? "pl-6" : "";
  // AF-owned editing (po-af-owned §3): logged server-side, auto-close re-runs.
  const saveAsin = (field: string) => async (v: string | null) => { await poApi(`/api/pos/asin-rows/${a.id}`, "PATCH", { [field]: v }); onChanged?.(); };
  return (
    <>
      <tr className={`table-zebra-stone ${indent ? "text-[13px]" : ""}`} style={hairline} data-testid={`row-po-asin-${a.asin}`}>
        <td className={`px-1 py-1.5 ${pad}`}>
          <span className="inline-flex items-center gap-1">
            {multi && (
              <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground" data-testid={`button-expand-${a.asin}`}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {a.thumbnail && <img src={a.thumbnail} alt="" className="h-6 w-6 object-contain rounded-sm" />}
          </span>
        </td>
        {/* Product: ASIN · Amazon SKU over the title (2026-11-05); each truncates with its full text on hover. */}
        <td className="px-1.5 py-1.5 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link href={`/asins?q=${a.asin}`} className="shrink-0 font-mono text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{a.asin}</Link>
            {a.sku ? <span className="truncate font-mono text-[11px] text-muted-foreground" title={a.sku}>{a.sku}</span> : (
              <Tooltip>
                <TooltipTrigger asChild><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /></TooltipTrigger>
                <TooltipContent side="top"><p className="text-xs">No SKU — create offer first</p></TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="truncate text-xs" title={a.asin_name ?? ""}>{a.asin_name ?? <span className="text-muted-foreground/50">—</span>}</div>
          {/* Supplier claims (SPEC §22 §5): Open claim on the row's only line (a multi-line row has it per line below); "N open" → the Claims page. */}
          <LineClaims a={a} line={!multi && lines.length === 1 ? lines[0] : null} editable={editable} onChanged={onChanged} />
        </td>
        <td className="px-1.5 py-1.5 text-right">
          <div><QtyCell v={a.qty} /></div>
          <div className="whitespace-nowrap text-[11px] text-muted-foreground" title={`${QTY_KIND.individual} = ${QTY_KIND.asin} × ${PER_ASIN_UNIT}`}>{a.qty_individual == null && a.units_per_pack == null ? <span className="text-muted-foreground/50" data-testid={`indiv-unknown-${a.id}`}>—</span> : <QtyCell v={a.qty_individual ?? individualUnits(Number(a.qty), a.units_per_pack ?? 1)} />} {INDIV_SHORT}</div>
        </td>
        <td className="px-1.5 py-1.5 text-right text-xs">{editable ? <InlineEdit money value={a.cost_per_unit} onSave={saveAsin("cost_per_unit")} align="right" width="w-12" testId={`cost_per_unit-${a.id}`}><Money v={a.cost_per_unit} /></InlineEdit> : <Money v={a.cost_per_unit} />}</td>
        <td className="px-1.5 py-1.5 text-right text-xs"><Money v={a.total_cost} /></td>
        <td className="px-1.5 py-1.5 text-right text-xs">{editable ? <InlineEdit money value={a.prep_cost} onSave={saveAsin("prep_cost")} align="right" width="w-10" testId={`prep_cost-${a.id}`}><Money v={a.prep_cost} /></InlineEdit> : <Money v={a.prep_cost} />}</td>
        <td className="px-1.5 py-1.5">
          {editable ? <PackEdit a={a} onChanged={onChanged} /> : <>
            <div className={a.sold_as == null ? "text-amber-700 dark:text-amber-400" : ""}>{a.sold_as ?? "—"}</div>
            <div className="text-[11px] text-muted-foreground" title={PER_ASIN_UNIT}>×{a.units_per_pack ?? "?"}</div>
          </>}
        </td>
        {/* Every quantity: the ASIN units as the main number, the Individual units in grey under it (2026-11-09). */}
        {/* The grey Individual line reads the stored Individual units straight from the API (D17) where the row has them. */}
        <td className="px-1.5 py-1.5 text-right"><div><QtyCell v={a.qty_canceled_asin} /></div><IndivLine v={a.qty_canceled_asin} perUnit={a.units_per_pack} individual={a.qty_canceled_individual} />{editable && (a.lines ?? []).length > 0 && <MarkCanceled a={a} onChanged={onChanged} po={po} />}</td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_returned_asin} /><IndivLine v={a.qty_returned_asin} perUnit={a.units_per_pack} individual={a.qty_returned_individual} /></td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_shipped_supplier" v={a.qty_shipped_supplier} individual={a.qty_shipped_supplier_individual} a={a} onChanged={onChanged} /> : <QtyCell v={a.qty_shipped_supplier} />}<IndivLine v={a.qty_shipped_supplier} perUnit={a.units_per_pack} individual={a.qty_shipped_supplier_individual} /></td>
        <td className="px-1.5 py-1.5 text-right" title={VELOCITY_QTY_TITLE}><QtyCell v={a.received_velocity} /><IndivLine v={a.received_velocity} perUnit={a.units_per_pack} individual={a.received_velocity_individual} testId={`indiv-received-velocity-${a.id}`} /></td>
        <td className="px-1.5 py-1.5 text-right" title={VELOCITY_QTY_TITLE}><QtyCell v={a.qty_at_prep} /><IndivLine v={a.qty_at_prep} perUnit={a.units_per_pack} individual={a.qty_at_prep_individual} /></td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_at_warehouse" v={a.qty_at_warehouse} individual={a.qty_at_warehouse_individual} a={a} onChanged={onChanged} /> : <QtyCell v={a.qty_at_warehouse} />}<IndivLine v={a.qty_at_warehouse} perUnit={a.units_per_pack} individual={a.qty_at_warehouse_individual} /></td>
        <td className="px-1.5 py-1.5 text-right">{editable ? <EditableQty rowId={a.id} col="qty_lost_damaged_us" v={a.qty_lost_damaged_us} individual={a.qty_lost_damaged_us_individual} a={a} onChanged={onChanged} /> : <QtyCell v={a.qty_lost_damaged_us} />}<IndivLine v={a.qty_lost_damaged_us} perUnit={a.units_per_pack} individual={a.qty_lost_damaged_us_individual} /></td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_shipped_fba} /><IndivLine v={a.qty_shipped_fba} perUnit={a.units_per_pack} individual={a.qty_shipped_fba_individual} /></td>
        <td className="px-1.5 py-1.5 text-right"><QtyCell v={a.qty_received_amazon} /><IndivLine v={a.qty_received_amazon} perUnit={a.units_per_pack} individual={a.qty_received_amazon_individual} /></td>
        <td className="px-1.5 py-1.5"><ShipmentChips rowId={a.id} asin={a.asin} shipments={a.shipments ?? []} editable={editable} onChanged={onChanged} /></td>
        <td className="px-1.5 py-1.5">{editable && lines.length > 0
          ? <ActionItemsEditor items={a.action_items} titles={extraTitles(a)} url={`/api/pos/asin-rows/${a.id}/action-items`} onSaved={onChanged} testId={`button-action-items-asin-${a.asin}`} lineCount={lines.length} />
          : <ActionItemChips items={a.action_items} titles={extraTitles(a)} />}
          {editable && (a.action_items ?? []).includes(EXTRA_UNITS_SHIPPED) && <ClearExtraUnits a={a} onChanged={onChanged} />}</td>
        {/* ASIN-row note, inline (2026-11-04); read-only tables show the icon with the note on hover. */}
        <td className={editable ? "p-0" : "px-2 py-1.5"}>{editable
          ? <InlineNoteCell value={a.notes} label="ASIN note" className="px-2 py-1.5" testId={`asin-${a.id}`} onSave={saveAsin("notes")} />
          : a.notes ? <span title={a.notes}><NoteIcon has /></span> : null}</td>
      </tr>
      {multi && open && lines.map((l) => (
        <tr key={l.id} style={hairline} data-testid={`row-component-${a.asin}-${l.position}`}>
          <td className="px-2 py-1" />
          <td className="px-1.5 py-1 pl-6 text-xs text-muted-foreground truncate" title={l.product_name ?? ""}>{l.product_name ?? "—"}</td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><ComponentQty l={l} a={a} /></td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><Money v={l.price} /></td>
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground"><Money v={l.adjusted_product_cost} /></td>
          {/* Product, Ordered, Cost/Unit, Total Cost above; Action Items after. */}
          <td className="px-1.5 py-1 text-right text-xs text-muted-foreground" colSpan={PO_ASIN_DISPLAY_COLUMNS.length - 4 - 1}>
            <span className="inline-flex items-center gap-2">{l.qty_canceled != null && l.qty_canceled > 0 ? `canceled ${l.qty_canceled}` : ""}
              <LineClaims a={a} line={l} editable={editable} onChanged={onChanged} /></span></td>
          <td className="px-1.5 py-1">{editable
            ? <ActionItemsEditor items={l.action_items} titles={lineTitles(l)} url={`/api/pos/lines/${l.id}/action-items`} onSaved={onChanged} testId={`button-action-items-line-${a.asin}-${l.position}`} />
            : <ActionItemChips items={l.action_items} titles={lineTitles(l)} />}</td>
          {/* Product-line note, inline (2026-11-04). */}
          <td className={editable ? "p-0" : "px-2 py-1"}>{editable
            ? <InlineNoteCell value={l.notes} label="line note" className="px-2 py-1" testId={`line-${l.id}`} onSave={async (v) => { await poApi(`/api/pos/lines/${l.id}`, "PATCH", { notes: v }); onChanged?.(); }} />
            : l.notes ? <span title={l.notes}><NoteIcon has /></span> : null}</td>
        </tr>
      ))}
    </>
  );
}

/** A complete ASINs table (the detail tab). */
export function PoAsinTable({ asins, testId = "po-asins-table", editable = false, onChanged, po }: { asins: PoAsinRowData[]; testId?: string; editable?: boolean; onChanged?: () => void; po?: PoHeaderMoney }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: PO_ASIN_TABLE_MIN_WIDTH }} data-testid={testId}>
        <PoAsinColGroup />
        <thead><PoAsinHeaderRow /></thead>
        <tbody>{asins.map((a) => <PoAsinRow key={a.id} a={a} editable={editable} onChanged={onChanged} po={po} />)}</tbody>
      </table>
    </div>
  );
}
