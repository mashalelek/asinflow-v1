/**
 * Upload to Velocity — full-screen review dialog (SPEC §11).
 *
 * Opened from the POs shell toolbar. Fetches the reconciliation for a date
 * range and renders: NEW ORDERS (pre-ticked), QTY MISMATCHES (opt-in;
 * shipped rows amber + not actionable), SKIPPED (no_live_sku rows get an
 * inline "Create SKU & include" that runs the §18 offer-add and promotes the
 * row into NEW ORDERS without a re-fetch), and collapsed display-only counts.
 *
 * Vocabulary rule: the word "plan" appears NOWHERE in this UI — internal
 * endpoint names (/api/velocity/plan) are not user-visible.
 *
 * SEND GATE: SEND_ENABLED=false keeps the send path dark until Maria has
 * eyeballed the review screen once (SPEC hold). Flipping it to true is the
 * only change needed to go live.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLongSync } from "@/lib/long-sync";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTable,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Loader2, ChevronDown, ChevronRight, Upload } from "lucide-react";

const SEND_ENABLED = true; // review-screen walkthrough approved 2026-07-30

// ── Shapes (mirror server/velocity-reconcile.ts + velocity-export.ts) ────────
interface VelocityRecord {
  fulfillment_type: string; date: string; retailer: string; order_number: string;
  item_name: string; quantity: string; asin: string; amazon_sku: string;
  sold_as: string; units_per_pack: string;
  color: string; brand_sku: string; size: string; unit_cost: string;
  list_price: string; client_notes: string; trackings: string;
}
interface FieldDiff { field: string; sheet_value: number | null; velocity_value: number | null }
interface PlanUpdate {
  order_id: string; order_number: string; asin: string; status: string;
  item_name: string | null; actionable: boolean; diffs: FieldDiff[];
}
interface UnplacedBundle {
  velocity_order_id: string; date: string; quantity: number | null;
  units_per_pack: any; amazon_sku: string | null; item_name: string | null; created_at: string | null;
}
interface SkipRow {
  reason: string; orderNumber: string | null; asin: string; itemName: string | null;
  row?: { date: string | null; retailer: string | null; quantity: string | null; soldAs: string | null; unitsPerPack: string | null };
  // §11 Part D: only on bundle_unplaced_candidate — the parent(s) holding it.
  unplaced?: UnplacedBundle[];
}
interface VelocityBundleItem { item_name: string; quantity: number; order_number: string; retailer: string; date: string }
interface VelocityBundleRecord {
  asin: string; amazon_sku: string; item_name: string; sold_as: "bundle";
  units_per_pack: number; quantity: number; date: string; fulfillment_type: "fba";
  bundle_items: VelocityBundleItem[]; orderNumbers: string[];
}
interface BundleFlag { orderNumber: string; asin: string; field: string; sheet: string; derived: number }

interface ReviewData {
  from: string; to: string; effectiveFrom: string; clamped: boolean;
  creates: VelocityRecord[]; bundleCreates?: VelocityBundleRecord[]; bundleFlags?: BundleFlag[]; updates: PlanUpdate[];
  deleteCandidates: Array<{ order_id: string; order_number: string; asin: string; item_name: string | null; sheet_status: string }>;
  unchanged: number; closedInVelocity: number; unmatchedVelocity: number;
  selfPrepExcluded: number; skips: SkipRow[];
  homeCreates?: VelocityRecord[]; homeBundleCreates?: VelocityBundleRecord[]; homeSkipped?: number;
}
type ExecResult = { action: string; order_number?: string; order_id?: string; asin?: string; outcome: string; error?: string };

// input[type=date] gives YYYY-MM-DD; the API takes M/D/YYYY (unpadded).
function ymdToMdy(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}/${y}`;
}
// Mid-typing, a date input emits partial/garbled values — never fetch on
// those (each keystroke would 400 against the API).
const isCompleteYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number(s.slice(0, 4)) > 2000;
// Typing a date passes through complete-but-wrong values (10/4 → 1/4/2026
// on the way to 11/4/2026): wait for the typing to pause before fetching.
export const DATE_DEBOUNCE_MS = 400;
function todayYmd(): string {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
const recKey = (r: { order_number: string; asin: string }) => `${r.order_number.trim()}\u0000${r.asin.trim().toUpperCase()}`;
// Bundle rows key on first child order number × parent asin (child-derived
// identity, SPEC §11 Bundles).
const bundleKey = (b: VelocityBundleRecord) => `${(b.orderNumbers[0] ?? "").trim()}\u0000${b.asin.trim().toUpperCase()}`;

const SKIP_REASON_LABEL: Record<string, string> = {
  no_live_sku: "no live SKU",
  bundle_unplaced_candidate: "may be an already-shipped bundle",
  missing_quantity: "quantity missing on sheet",
  unparseable_date: "order date does not parse",
  bundle_unsupported: "bundles not supported",
  invalid_pack_math: "quantity not divisible by units/pack",
};

// §11 legend_pending expansion: what the offer-add says needs approval.
type PendingLegend = { rawValue: string; proposedCode: string; status: string; legendId?: string | null } | null;

type SkuCreateState =
  | { state: "running" }
  | { state: "done"; sku: string }
  | { state: "failed"; reason: string }
  | { state: "legend_pending"; brand: PendingLegend; dept: PendingLegend;
      brandCode: string; deptCode: string; approving: boolean; error?: string };

export function UploadToVelocityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [fromYmd, setFromYmd] = useState(todayYmd());
  const [toYmd, setToYmd] = useState(todayYmd());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReviewData | null>(null);
  // Promoted rows (Create SKU & include) live alongside data.creates.
  const [promoted, setPromoted] = useState<VelocityRecord[]>([]);
  const [selCreates, setSelCreates] = useState<Set<string>>(new Set());
  const [selUpdates, setSelUpdates] = useState<Set<string>>(new Set());
  const [skuCreate, setSkuCreate] = useState<Record<string, SkuCreateState>>({});
  // §11 Part D (2026-09-21): inline bundle mapping. Keyed by
  // "<orderNumber>|<asin>" — the identity of one held group. Same
  // no-nested-modal pattern as no_live_sku / legend_pending.
  const [bundleMap, setBundleMap] = useState<Record<string, {
    open: boolean; busy?: boolean; mappedTo?: string; error?: string; otherNumber?: string;
  }>>({});
  // Groups released by a mapping (their holder is now identified) and the
  // groups that MOVED to shipped — applied locally, no full re-fetch.
  const [bundleReleased, setBundleReleased] = useState<Set<string>>(new Set());
  const [bundleMappedKeys, setBundleMappedKeys] = useState<Set<string>>(new Set());

  const mapBundle = useCallback(async (s: SkipRow, velocityOrderId: string, orderNumber: string) => {
    const key = `${s.orderNumber ?? ""}|${s.asin}`;
    setBundleMap((m) => ({ ...m, [key]: { ...(m[key] ?? { open: true }), busy: true, error: undefined } }));
    try {
      const res = await fetch("/api/velocity/bundle-identity/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ velocityOrderId, asin: s.asin, orderNumber }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `Mapping failed (${res.status})`);
      setBundleMap((m) => ({ ...m, [key]: { open: false, busy: false, mappedTo: orderNumber } }));
      // The mapped group moves to the shipped count; every OTHER group held
      // by this same parent is released into NEW ORDERS, pre-ticked. Groups
      // held by a DIFFERENT parent stay held (Part D).
      setBundleMappedKeys((prev) => new Set(prev).add(key));
      const released = new Set(bundleReleased);
      for (const other of data?.skips ?? []) {
        if (other.reason !== "bundle_unplaced_candidate") continue;
        const ok = `${other.orderNumber ?? ""}|${other.asin}`;
        if (ok === key) continue;
        if ((other.unplaced ?? []).some((u: UnplacedBundle) => u.velocity_order_id === velocityOrderId)) {
          released.add(ok);
        }
      }
      setBundleReleased(released);
    } catch (e: any) {
      setBundleMap((m) => ({ ...m, [key]: { ...(m[key] ?? { open: true }), busy: false, error: e.message } }));
    }
  }, [bundleReleased, data]);
  const [countsOpen, setCountsOpen] = useState(false);
  // Home POs (ships_to = 'home'): listed apart, collapsed and unticked (SPEC §11).
  const [homeOpen, setHomeOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<ExecResult[] | null>(null);

  // Only the newest plan request may update the dialog: every request (and
  // every date change that schedules one) bumps reqSeq, and a response whose
  // seq is no longer current is dropped — otherwise a late answer for a
  // superseded range overwrote the list and reset the ticks.
  const reqSeq = useRef(0);
  const reqAbort = useRef<AbortController | null>(null);
  const dateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchReview = useCallback(async (fYmd: string, tYmd: string) => {
    const seq = ++reqSeq.current;
    reqAbort.current?.abort();
    const ctrl = new AbortController();
    reqAbort.current = ctrl;
    setLoading(true); setError(null); setResults(null); setConfirming(false);
    setPromoted([]); setSkuCreate({});
    try {
      const res = await fetch(`/api/velocity/plan?from=${encodeURIComponent(ymdToMdy(fYmd))}&to=${encodeURIComponent(ymdToMdy(tYmd))}`, { signal: ctrl.signal });
      const body = await res.json();
      if (seq !== reqSeq.current) return;
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setData(body as ReviewData);
      // NEW ORDERS pre-ticked; QTY MISMATCHES opt-in (unticked).
      // NEW ORDERS pre-ticked — bundles included (SPEC §11 Bundles).
      setSelCreates(new Set([
        ...(body.creates as VelocityRecord[]).map(recKey),
        ...(((body.bundleCreates ?? []) as VelocityBundleRecord[])).map(bundleKey),
      ]));
      setSelUpdates(new Set());
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      setData(null); setError(e?.message ?? String(e));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  // A date edit: invalidate whatever is in flight at once, then fetch once
  // the typing pauses (DATE_DEBOUNCE_MS) and both dates are complete.
  const scheduleReview = useCallback((fYmd: string, tYmd: string) => {
    if (dateTimer.current) clearTimeout(dateTimer.current);
    reqSeq.current++;
    reqAbort.current?.abort();
    if (!isCompleteYmd(fYmd) || !isCompleteYmd(tYmd)) { setLoading(false); return; }
    setLoading(true);
    dateTimer.current = setTimeout(() => { dateTimer.current = null; void fetchReview(fYmd, tYmd); }, DATE_DEBOUNCE_MS);
  }, [fetchReview]);

  useEffect(() => {
    if (open) fetchReview(fromYmd, toYmd);
    // Closing (or unmounting) drops a pending fetch and any late response.
    return () => {
      if (dateTimer.current) clearTimeout(dateTimer.current);
      dateTimer.current = null;
      reqSeq.current++;
      reqAbort.current?.abort();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const allCreates = useMemo(() => [...(data?.creates ?? []), ...promoted], [data, promoted]);
  const actionableUpdates = useMemo(() => (data?.updates ?? []).filter((u) => u.actionable), [data]);
  const flagOnlyUpdates = useMemo(() => (data?.updates ?? []).filter((u) => !u.actionable), [data]);
  const homeCreates = data?.homeCreates ?? [];
  const homeBundleCreates = data?.homeBundleCreates ?? [];
  const nCreates = allCreates.filter((r) => selCreates.has(recKey(r))).length
    + (data?.bundleCreates ?? []).filter((b) => selCreates.has(bundleKey(b))).length
    + homeCreates.filter((r) => selCreates.has(recKey(r))).length
    + homeBundleCreates.filter((b) => selCreates.has(bundleKey(b))).length;
  const nUpdates = actionableUpdates.filter((u) => selUpdates.has(u.order_id)).length;
  const nTotal = nCreates + nUpdates;

  const toggleCreate = (key: string) =>
    setSelCreates((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleUpdate = (id: string) =>
    setSelUpdates((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // "Create SKU & include" — §18 offer-add via the existing batch flow for
  // ONE asin. On ACCEPTED (kind "created"), promote the row into NEW ORDERS
  // pre-ticked. No nested modal; the row shows its result inline.
  async function createSkuAndInclude(skip: SkipRow) {
    setSkuCreate((m) => ({ ...m, [skip.asin]: { state: "running" } }));
    try {
      const res = await fetch("/api/offer-add/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: [skip.asin] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      const outcome = body?.perAsin?.find((p: any) => p.asin === skip.asin)?.outcome
        ?? (body?.preFilter?.excluded?.some((e: any) => e.asin === skip.asin)
          ? { kind: "skipped", details: `pre-filtered: ${body.preFilter.excluded.find((e: any) => e.asin === skip.asin).reason}` }
          : null);
      if (outcome?.kind === "created") {
        const sku = String(outcome.sku);
        setSkuCreate((m) => ({ ...m, [skip.asin]: { state: "done", sku } }));
        const rec: VelocityRecord = {
          fulfillment_type: "fba",
          date: skip.row?.date ?? "",
          retailer: skip.row?.retailer ?? "",
          order_number: skip.orderNumber ?? "",
          item_name: skip.itemName ?? "",
          quantity: skip.row?.quantity ?? "",
          asin: skip.asin,
          amazon_sku: sku,
          sold_as: skip.row?.soldAs ?? "",
          units_per_pack: skip.row?.unitsPerPack ?? "",
          color: "", brand_sku: "", size: "", unit_cost: "", list_price: "", client_notes: "", trackings: "",
        };
        setPromoted((p) => [...p, rec]);
        setSelCreates((s) => new Set(s).add(recKey(rec)));
      } else if (outcome?.kind === "skipped" && outcome.reason === "legend_pending" && outcome.pending) {
        // §11: not a dead end — expand the row inline for legend approval
        // (same path the Add-to-SC preview uses; one legend writer, §18).
        const brand: PendingLegend = outcome.pending.brand ?? null;
        const dept: PendingLegend = outcome.pending.dept ?? null;
        setSkuCreate((m) => ({ ...m, [skip.asin]: {
          state: "legend_pending", brand, dept,
          brandCode: brand?.proposedCode ?? "",
          deptCode: dept?.proposedCode ?? "",
          approving: false,
        } }));
      } else {
        const reason = outcome
          ? `${outcome.kind}${outcome.details ? ` — ${outcome.details}` : outcome.reason ? ` — ${outcome.reason}` : ""}`
          : "no outcome returned";
        setSkuCreate((m) => ({ ...m, [skip.asin]: { state: "failed", reason } }));
      }
    } catch (e: any) {
      setSkuCreate((m) => ({ ...m, [skip.asin]: { state: "failed", reason: e?.message ?? String(e) } }));
    }
  }

  // §11 legend_pending → Approve: commits via POST /api/sku-legend/approve
  // (the SAME single legend writer as the Add-to-SC preview approval —
  // approve_in_place when a proposed legendId exists, approve_new otherwise),
  // then automatically re-fires the offer-add — the existing success path
  // takes over (SKU inline, row promoted, no re-fetch).
  async function approveLegendAndContinue(skip: SkipRow) {
    const st = skuCreate[skip.asin];
    if (!st || st.state !== "legend_pending" || st.approving) return;
    const items: any[] = [];
    for (const [type, pending, code] of [
      ["brand", st.brand, st.brandCode],
      ["dept", st.dept, st.deptCode],
    ] as const) {
      if (!pending) continue;
      if (!/^[A-Z]{3}$/.test(code)) {
        setSkuCreate((m) => ({ ...m, [skip.asin]: { ...st, error: `${type} code must be exactly 3 letters` } }));
        return;
      }
      items.push(pending.legendId
        ? { type, rawValue: pending.rawValue, action: "approve_in_place", legendId: pending.legendId, code }
        : { type, rawValue: pending.rawValue, action: "approve_new", code });
    }
    setSkuCreate((m) => ({ ...m, [skip.asin]: { ...st, approving: true, error: undefined } }));
    try {
      if (items.length === 0) {
        await createSkuAndInclude(skip);
        return;
      }
      const res = await fetch("/api/sku-legend/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      const errs = (body.results ?? []).filter((r: any) => r.outcome === "error");
      if (errs.length > 0) {
        setSkuCreate((m) => ({ ...m, [skip.asin]: {
          ...st, approving: false,
          error: errs.map((e: any) => `${e.rawValue}: ${e.message ?? e.reason}`).join(" · "),
        } }));
        return;
      }
      // Legend committed — continue the existing flow automatically.
      await createSkuAndInclude(skip);
    } catch (e: any) {
      setSkuCreate((m) => ({ ...m, [skip.asin]: { ...st, approving: false, error: e?.message ?? String(e) } }));
    }
  }

  async function sendToVelocity() {
    if (!SEND_ENABLED) return;
    setSending(true);
    try {
      // A Home PO row goes only when ticked by hand (never pre-ticked).
      const creates = [...allCreates, ...homeCreates].filter((r) => selCreates.has(recKey(r)));
      const bundles = [...(data?.bundleCreates ?? []), ...homeBundleCreates].filter((b) => selCreates.has(bundleKey(b)));
      const updates = actionableUpdates.filter((u) => selUpdates.has(u.order_id));
      const body = await fetchLongSync("/api/velocity/execute", { creates, updates, bundles });
      setResults(body.results as ExecResult[]);
    } catch (e: any) {
      setResults([{ action: "send", outcome: "failed", error: e?.message ?? String(e) }]);
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  const resultFor = (kind: "create" | "update" | "create_bundle", idOrKey: string): ExecResult | undefined =>
    results?.find((r) =>
      kind === "update"
        ? r.action === "update" && r.order_id === idOrKey
        : r.action === kind && `${(r.order_number ?? "").trim()}\u0000${(r.asin ?? "").trim().toUpperCase()}` === idOrKey,
    );

  const resultBadge = (r: ExecResult | undefined) => {
    if (!r) return null;
    const ok = r.outcome === "created" || r.outcome === "updated";
    return (
      <span className={`text-xs ${ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
        {ok ? (r.outcome === "created" ? "✓ created" : "✓ updated") : `✗ ${r.outcome}${r.error ? ` — ${r.error}` : ""}`}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogId="upload-to-velocity" className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" /> Upload to Velocity
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span>Order date range:</span>
            <Input type="date" className="h-8 w-40" value={fromYmd}
              onChange={(e) => { setFromYmd(e.target.value); scheduleReview(e.target.value, toYmd); }} />
            <span>–</span>
            <Input type="date" className="h-8 w-40" value={toYmd}
              onChange={(e) => { setToYmd(e.target.value); scheduleReview(fromYmd, e.target.value); }} />
            {data?.clamped && (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-400/50">
                clamped to {data.effectiveFrom} by order-date floor
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking sheet against Velocity…
            </div>
          )}
          {error && <div className="text-sm text-red-600 dark:text-red-400 py-4">{error}</div>}

          {!loading && !error && data && (
            <>
              {/* a. NEW ORDERS */}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  New orders <span className="text-muted-foreground font-normal">({allCreates.length})</span>
                </h3>
                {allCreates.length === 0 ? (
                  <div className="text-sm text-muted-foreground">None in range.</div>
                ) : (
                  <DialogTable><table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground text-left border-b border-border">
                        <th className="py-1 pr-2 w-8"></th>
                        <th className="py-1 pr-3">Date</th>
                        <th className="py-1 pr-3">Retailer</th>
                        <th className="py-1 pr-3">Order #</th>
                        <th className="py-1 pr-3">Item</th>
                        <th className="py-1 pr-3 text-right">Qty</th>
                        <th className="py-1 pr-3">Sold as</th>
                        <th className="py-1 pr-3">ASIN</th>
                        <th className="py-1 pr-3">SKU</th>
                        <th className="py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {allCreates.map((r) => {
                        const key = recKey(r);
                        return (
                          <tr key={key} className="border-b border-border/50">
                            <td className="py-1.5 pr-2">
                              <Checkbox checked={selCreates.has(key)} onCheckedChange={() => toggleCreate(key)} disabled={!!results} />
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">{r.date}</td>
                            <td className="py-1.5 pr-3 max-w-[140px] truncate">{r.retailer}</td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">{r.order_number}</td>
                            <td className="py-1.5 pr-3 max-w-[280px] truncate" title={r.item_name}>{r.item_name}</td>
                            <td className="py-1.5 pr-3 text-right">{r.quantity}</td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              {r.sold_as}{r.sold_as === "multi-pack" && r.units_per_pack ? ` ×${r.units_per_pack}` : ""}
                            </td>
                            <td className="py-1.5 pr-3 font-mono text-xs">{r.asin}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs">{r.amazon_sku}</td>
                            <td className="py-1.5">{resultBadge(resultFor("create", key))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></DialogTable>
                )}
                {/* Bundles (SPEC §11 Bundles, 2026-08-31): parent row +
                    nested component sub-rows (PO-module ASINs-tab pattern),
                    pre-ticked, per-row results inline. */}
                {(data.bundleCreates ?? []).length > 0 && (
                  <div className="mt-3">
                    <h4 className="text-xs font-semibold text-muted-foreground mb-1">
                      Bundles ({(data.bundleCreates ?? []).length})
                    </h4>
                    <DialogTable><table className="w-full text-sm">
                      <tbody>
                        {(data.bundleCreates ?? []).map((b) => {
                          const key = bundleKey(b);
                          return (
                            <Fragment key={key}>
                              <tr className="border-b border-border/50">
                                <td className="py-1.5 pr-2 w-8">
                                  <Checkbox checked={selCreates.has(key)} onCheckedChange={() => toggleCreate(key)} disabled={!!results} />
                                </td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{b.date}</td>
                                <td className="py-1.5 pr-3 max-w-[280px] truncate" title={b.item_name}>{b.item_name}</td>
                                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{b.quantity} units</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">bundle ×{b.units_per_pack}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs">{b.asin}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs">{b.amazon_sku}</td>
                                <td className="py-1.5">{resultBadge(resultFor("create_bundle", key))}</td>
                              </tr>
                              {b.bundle_items.map((c, i) => (
                                <tr key={`${key}-c${i}`} className="border-b border-border/30 text-xs text-muted-foreground">
                                  <td></td>
                                  <td className="py-1 pr-3 whitespace-nowrap pl-4">↳ {c.date}</td>
                                  <td className="py-1 pr-3 max-w-[280px] truncate" title={c.item_name}>{c.item_name}</td>
                                  <td className="py-1 pr-3 text-right">{c.quantity}</td>
                                  <td className="py-1 pr-3 whitespace-nowrap" colSpan={3}>
                                    {c.retailer} · #{c.order_number}
                                  </td>
                                  <td></td>
                                </tr>
                              ))}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table></DialogTable>
                  </div>
                )}
                {(data.bundleFlags ?? []).length > 0 && (
                  <div className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                    {(data.bundleFlags ?? []).map((f, i) => (
                      <div key={i}>
                        AY/AZ cross-check: {f.asin} #{f.orderNumber} — sheet {f.field} "{f.sheet}" vs derived {f.derived}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* a2. HOME POs — ships_to = 'home': self-prep, not uploaded unless ticked by hand */}
              {(homeCreates.length > 0 || homeBundleCreates.length > 0) && (
                <section data-testid="velocity-home-group">
                  <button className="flex items-center gap-1 text-sm font-semibold" onClick={() => setHomeOpen((v) => !v)} data-testid="button-velocity-home-toggle">
                    {homeOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    Self-prep — not uploaded <span className="text-muted-foreground font-normal">({homeCreates.length + homeBundleCreates.length})</span>
                  </button>
                  {homeOpen && (
                    <div className="mt-2 pl-5">
                      <div className="text-xs text-muted-foreground mb-2">
                        Ships to Home on the PO — prepped in-house, so these are skipped. Tick one only if it really goes to Velocity (and fix Ships to on the PO).
                        {(data.homeSkipped ?? 0) > 0 ? ` ${data.homeSkipped} more could not be built (no SKU / pack math).` : ""}
                      </div>
                      <DialogTable><table className="w-full text-sm">
                        <tbody>
                          {homeCreates.map((r) => {
                            const key = recKey(r);
                            return (
                              <tr key={key} className="border-b border-border/50 text-muted-foreground">
                                <td className="py-1.5 pr-2 w-8">
                                  <Checkbox checked={selCreates.has(key)} onCheckedChange={() => toggleCreate(key)} disabled={!!results} data-testid={`checkbox-velocity-home-${r.order_number}-${r.asin}`} />
                                </td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{r.date}</td>
                                <td className="py-1.5 pr-3 max-w-[140px] truncate">{r.retailer}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{r.order_number}</td>
                                <td className="py-1.5 pr-3 max-w-[280px] truncate" title={r.item_name}>{r.item_name}</td>
                                <td className="py-1.5 pr-3 text-right">{r.quantity}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs">{r.asin}</td>
                                <td className="py-1.5 pr-3 text-xs">Ships to Home</td>
                                <td className="py-1.5">{resultBadge(resultFor("create", key))}</td>
                              </tr>
                            );
                          })}
                          {homeBundleCreates.map((b) => {
                            const key = bundleKey(b);
                            return (
                              <tr key={key} className="border-b border-border/50 text-muted-foreground">
                                <td className="py-1.5 pr-2 w-8">
                                  <Checkbox checked={selCreates.has(key)} onCheckedChange={() => toggleCreate(key)} disabled={!!results} />
                                </td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{b.date}</td>
                                <td className="py-1.5 pr-3 max-w-[140px] truncate">{b.bundle_items[0]?.retailer}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{b.orderNumbers[0]}</td>
                                <td className="py-1.5 pr-3 max-w-[280px] truncate" title={b.item_name}>{b.item_name}</td>
                                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{b.quantity} units · bundle ×{b.units_per_pack}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs">{b.asin}</td>
                                <td className="py-1.5 pr-3 text-xs">Ships to Home</td>
                                <td className="py-1.5">{resultBadge(resultFor("create_bundle", key))}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table></DialogTable>
                    </div>
                  )}
                </section>
              )}

              {/* b. QTY MISMATCHES */}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  Qty mismatches <span className="text-muted-foreground font-normal">({(data.updates ?? []).length})</span>
                </h3>
                {(data.updates ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">Sheet and Velocity agree on every matched order.</div>
                ) : (
                  <DialogTable><table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground text-left border-b border-border">
                        <th className="py-1 pr-2 w-8"></th>
                        <th className="py-1 pr-3">Order #</th>
                        <th className="py-1 pr-3">Item</th>
                        <th className="py-1 pr-3">ASIN</th>
                        <th className="py-1 pr-3 text-right">Sheet qty</th>
                        <th className="py-1 pr-3 text-right">Velocity qty</th>
                        <th className="py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...actionableUpdates, ...flagOnlyUpdates].map((u) => {
                        const qty = u.diffs.find((d) => d.field === "quantity");
                        return (
                          <tr key={u.order_id} className={`border-b border-border/50 ${u.actionable ? "" : "text-amber-600 dark:text-amber-400"}`}>
                            <td className="py-1.5 pr-2">
                              {u.actionable
                                ? <Checkbox checked={selUpdates.has(u.order_id)} onCheckedChange={() => toggleUpdate(u.order_id)} disabled={!!results} />
                                : null}
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">{u.order_number}</td>
                            <td className="py-1.5 pr-3 max-w-[280px] truncate" title={u.item_name ?? ""}>{u.item_name}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs">{u.asin}</td>
                            <td className="py-1.5 pr-3 text-right font-medium">{qty?.sheet_value ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-right">{qty?.velocity_value ?? "—"}</td>
                            <td className="py-1.5 text-xs">
                              {u.actionable
                                ? resultBadge(resultFor("update", u.order_id))
                                : "not editable — order already shipped"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></DialogTable>
                )}
              </section>

              {/* c. SKIPPED */}
              {data.skips.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold mb-2">
                    Skipped <span className="text-muted-foreground font-normal">({data.skips.length})</span>
                  </h3>
                  <DialogTable><table className="w-full text-sm">
                    <tbody>
                      {data.skips.map((s, i) => {
                        const st = skuCreate[s.asin];
                        const promotedRow = st?.state === "done";
                        return (
                          <tr key={`${s.orderNumber}-${s.asin}-${i}`} className="border-b border-border/50">
                            <td className="py-1.5 pr-3 whitespace-nowrap">{s.orderNumber ?? "—"}</td>
                            <td className="py-1.5 pr-3 max-w-[280px] truncate" title={s.itemName ?? ""}>{s.itemName}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs">{s.asin}</td>
                            <td className="py-1.5 pr-3 text-muted-foreground">{SKIP_REASON_LABEL[s.reason] ?? s.reason}</td>
                            <td className="py-1.5 text-xs">
                              {/* §11 Part D (2026-09-21): a held bundle group
                                  expands INLINE with its holder(s) — never a
                                  nested modal. Mapping it identifies the
                                  shipped parent and releases the parent's
                                  other candidates. */}
                              {s.reason === "bundle_unplaced_candidate" && (() => {
                                const key = `${s.orderNumber ?? ""}|${s.asin}`;
                                const ms = bundleMap[key];
                                if (bundleMappedKeys.has(key)) {
                                  return <span className="text-green-600 dark:text-green-400">✓ mapped to the shipped bundle — counted under shipped</span>;
                                }
                                if (bundleReleased.has(key)) {
                                  return <span className="text-green-600 dark:text-green-400">✓ released — moved to New orders</span>;
                                }
                                return (
                                  <div className="space-y-1.5 py-1">
                                    {!ms?.open && (
                                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBundleMap((m) => ({ ...m, [key]: { open: true } }))}>
                                        Resolve ({(s.unplaced ?? []).length} shipped bundle{(s.unplaced ?? []).length === 1 ? "" : "s"})
                                      </Button>
                                    )}
                                    {ms?.open && (
                                      <div className="space-y-2">
                                        <p className="text-muted-foreground">
                                          An already-shipped Velocity bundle for this ASIN has no recorded order number. If it is THIS order, map it — otherwise give the real order number.
                                        </p>
                                        {(s.unplaced ?? []).map((u) => (
                                          <div key={u.velocity_order_id} className="border border-border/60 rounded p-2 space-y-1">
                                            <div className="text-[11px] text-muted-foreground">
                                              ordered <strong>{u.date}</strong> · {u.quantity} units
                                              {u.units_per_pack ? ` (packs of ${u.units_per_pack})` : ""}
                                              {u.amazon_sku ? <> · <span className="font-mono">{u.amazon_sku}</span></> : null}
                                              {u.created_at ? ` · entered ${u.created_at}` : ""}
                                            </div>
                                            <div className="max-w-[420px] truncate" title={u.item_name ?? ""}>{u.item_name}</div>
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <Button size="sm" className="h-7 text-xs" disabled={ms.busy}
                                                onClick={() => mapBundle(s, u.velocity_order_id, s.orderNumber ?? "")}>
                                                This order is that bundle
                                              </Button>
                                              <input
                                                aria-label="Map to a different order number"
                                                placeholder="or a different order #"
                                                className="text-xs rounded px-2 py-1 w-[12em] border border-input bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                value={ms.otherNumber ?? ""}
                                                disabled={ms.busy}
                                                onChange={(e) => setBundleMap((m) => ({ ...m, [key]: { ...(m[key] ?? { open: true }), otherNumber: e.target.value } }))}
                                                spellCheck={false}
                                              />
                                              <Button size="sm" variant="outline" className="h-7 text-xs"
                                                disabled={ms.busy || !(ms.otherNumber ?? "").trim()}
                                                onClick={() => mapBundle(s, u.velocity_order_id, (ms.otherNumber ?? "").trim())}>
                                                Map to that #
                                              </Button>
                                            </div>
                                          </div>
                                        ))}
                                        {ms.busy && <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> mapping…</span>}
                                        {ms.error && <span className="text-red-600 dark:text-red-400">✗ {ms.error}</span>}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {s.reason === "no_live_sku" && !st && (
                                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => createSkuAndInclude(s)}>
                                  Create SKU &amp; include
                                </Button>
                              )}
                              {st?.state === "running" && (
                                <span className="flex items-center gap-1 text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" /> creating SKU…
                                </span>
                              )}
                              {promotedRow && (
                                <span className="text-green-600 dark:text-green-400">
                                  ✓ SKU <span className="font-mono">{(st as any).sku}</span> — moved to New orders
                                </span>
                              )}
                              {st?.state === "failed" && (
                                <span className="text-red-600 dark:text-red-400">✗ {(st as any).reason}</span>
                              )}
                              {st?.state === "legend_pending" && (
                                <div className="space-y-1.5 py-1">
                                  <p className="font-medium text-amber-600 dark:text-amber-500">Needs legend approval:</p>
                                  {st.brand && (
                                    <label className="flex items-center gap-2">
                                      <span className="text-muted-foreground max-w-[160px] truncate" title={st.brand.rawValue}>
                                        brand “{st.brand.rawValue}” →
                                      </span>
                                      <input
                                        aria-label="Brand code"
                                        className="font-mono text-xs font-bold rounded px-1 py-0.5 w-[3.5em] uppercase border border-input bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        value={st.brandCode}
                                        maxLength={3}
                                        disabled={st.approving}
                                        onChange={(e) => {
                                          const val = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                                          setSkuCreate((m) => ({ ...m, [s.asin]: { ...st, brandCode: val } }));
                                        }}
                                        spellCheck={false}
                                      />
                                    </label>
                                  )}
                                  {st.dept && (
                                    <label className="flex items-center gap-2">
                                      <span className="text-muted-foreground max-w-[160px] truncate" title={st.dept.rawValue}>
                                        dept “{st.dept.rawValue}” →
                                      </span>
                                      <input
                                        aria-label="Dept code"
                                        className="font-mono text-xs font-bold rounded px-1 py-0.5 w-[3.5em] uppercase border border-input bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        value={st.deptCode}
                                        maxLength={3}
                                        disabled={st.approving}
                                        onChange={(e) => {
                                          const val = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                                          setSkuCreate((m) => ({ ...m, [s.asin]: { ...st, deptCode: val } }));
                                        }}
                                        spellCheck={false}
                                      />
                                    </label>
                                  )}
                                  {st.error && <p className="text-red-600 dark:text-red-400">{st.error}</p>}
                                  <div className="flex gap-1">
                                    <Button size="sm" className="h-6 text-xs" disabled={st.approving} onClick={() => approveLegendAndContinue(s)}>
                                      {st.approving ? "Approving…" : "Approve"}
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={st.approving}
                                      onClick={() => setSkuCreate((m) => { const n = { ...m }; delete n[s.asin]; return n; })}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></DialogTable>
                </section>
              )}

              {/* Delete-candidates: manual dashboard action (no API DELETE). */}
              {data.deleteCandidates.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold mb-2 text-amber-600 dark:text-amber-400">
                    Canceled on sheet — delete in the Velocity dashboard ({data.deleteCandidates.length})
                  </h3>
                  <ul className="text-sm space-y-1">
                    {data.deleteCandidates.map((d) => (
                      <li key={d.order_id}>
                        {d.order_number} · <span className="font-mono text-xs">{d.asin}</span> · {d.item_name}
                        <span className="text-muted-foreground"> (sheet: {d.sheet_status})</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* d. collapsed counts */}
              <section>
                <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setCountsOpen((v) => !v)}>
                  {countsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {/* UI says "shipped" — "closed" collides with the Orders-sheet
                      status vocabulary (internal key stays closedInVelocity). */}
                  {data.unchanged} unchanged · {data.closedInVelocity} shipped · {data.unmatchedVelocity} unmatched
                  {data.selfPrepExcluded > 0 ? ` · ${data.selfPrepExcluded} self-prep` : ""}
                </button>
                {countsOpen && (
                  <div className="text-xs text-muted-foreground mt-2 space-y-1 pl-5">
                    <div><span className="font-medium">Unchanged</span> — matched orders where sheet and Velocity agree; nothing to do.</div>
                    <div><span className="font-medium">Shipped</span> — matched orders already shipped/received with no quantity mismatch; not editable.</div>
                    <div><span className="font-medium">Unmatched</span> — orders in Velocity with no sheet row (order # + ASIN); never touched.</div>
                    {data.selfPrepExcluded > 0 && <div><span className="font-medium">Self-prep</span> — prep cost 0 on a Velocity PO's ASIN row; these never go to Velocity. Home POs are listed above under "Self-prep — not uploaded".</div>}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border pt-3">
          {confirming && !results ? (
            <div className="flex items-center gap-3 w-full justify-end">
              <span className="text-sm">
                This will send <span className="font-semibold">{nCreates} new order{nCreates === 1 ? "" : "s"}</span>
                {" and "}
                <span className="font-semibold">{nUpdates} quantity update{nUpdates === 1 ? "" : "s"}</span> to Velocity.
              </span>
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={sending}>Back</Button>
              <Button size="sm" onClick={sendToVelocity} disabled={sending || !SEND_ENABLED}
                title={SEND_ENABLED ? undefined : "Send path pending review — not yet enabled"}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {SEND_ENABLED ? "Confirm — send now" : "Send disabled (pending review)"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3 w-full justify-end">
              {results && (
                <span className="text-sm text-muted-foreground">
                  Done — results shown per row above. Re-open to run another range.
                </span>
              )}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
              {!results && (
                <Button size="sm" disabled={nTotal === 0 || loading || !!error} onClick={() => setConfirming(true)}>
                  Send to Velocity ({nTotal})
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
