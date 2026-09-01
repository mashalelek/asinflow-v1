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
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLongSync } from "@/lib/long-sync";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
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
interface SkipRow {
  reason: string; orderNumber: string | null; asin: string; itemName: string | null;
  row?: { date: string | null; retailer: string | null; quantity: string | null; soldAs: string | null; unitsPerPack: string | null };
}
interface ReviewData {
  from: string; to: string; effectiveFrom: string; clamped: boolean;
  creates: VelocityRecord[]; updates: PlanUpdate[];
  deleteCandidates: Array<{ order_id: string; order_number: string; asin: string; item_name: string | null; sheet_status: string }>;
  unchanged: number; closedInVelocity: number; unmatchedVelocity: number;
  selfPrepExcluded: number; skips: SkipRow[];
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
function todayYmd(): string {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
const recKey = (r: { order_number: string; asin: string }) => `${r.order_number.trim()}\u0000${r.asin.trim().toUpperCase()}`;

const SKIP_REASON_LABEL: Record<string, string> = {
  no_live_sku: "no live SKU",
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
      brandCode: string; deptCode: string; approving: boolean; error?: string;
      // §18 missing-brand manual entry (2026-08-29): optional name — non-blank
      // commits approve_new to the legend; blank = one-off code, no legend write.
      brandName: string };

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
  const [countsOpen, setCountsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<ExecResult[] | null>(null);

  const fetchReview = useCallback(async (fYmd: string, tYmd: string) => {
    setLoading(true); setError(null); setResults(null); setConfirming(false);
    setPromoted([]); setSkuCreate({});
    try {
      const res = await fetch(`/api/velocity/plan?from=${encodeURIComponent(ymdToMdy(fYmd))}&to=${encodeURIComponent(ymdToMdy(tYmd))}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setData(body as ReviewData);
      // NEW ORDERS pre-ticked; QTY MISMATCHES opt-in (unticked).
      setSelCreates(new Set((body.creates as VelocityRecord[]).map(recKey)));
      setSelUpdates(new Set());
    } catch (e: any) {
      setData(null); setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) fetchReview(fromYmd, toYmd); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const allCreates = useMemo(() => [...(data?.creates ?? []), ...promoted], [data, promoted]);
  const actionableUpdates = useMemo(() => (data?.updates ?? []).filter((u) => u.actionable), [data]);
  const flagOnlyUpdates = useMemo(() => (data?.updates ?? []).filter((u) => !u.actionable), [data]);
  const nCreates = allCreates.filter((r) => selCreates.has(recKey(r))).length;
  const nUpdates = actionableUpdates.filter((u) => selUpdates.has(u.order_id)).length;
  const nTotal = nCreates + nUpdates;

  const toggleCreate = (key: string) =>
    setSelCreates((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleUpdate = (id: string) =>
    setSelUpdates((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // "Create SKU & include" — §18 offer-add via the existing batch flow for
  // ONE asin. On ACCEPTED (kind "created"), promote the row into NEW ORDERS
  // pre-ticked. No nested modal; the row shows its result inline.
  async function createSkuAndInclude(skip: SkipRow, brandCode?: string) {
    setSkuCreate((m) => ({ ...m, [skip.asin]: { state: "running" } }));
    try {
      const res = await fetch("/api/offer-add/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // §18 missing-brand: the manually-entered BRD rides as a per-ASIN
        // override so the re-fired build can assemble without a catalog brand.
        body: JSON.stringify({ asins: [skip.asin], ...(brandCode ? { brandCodes: { [skip.asin]: brandCode } } : {}) }),
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
          // "missing" brand has no proposal — the code input starts empty.
          brandCode: brand?.status === "missing" ? "" : brand?.proposedCode ?? "",
          deptCode: dept?.proposedCode ?? "",
          approving: false, brandName: "",
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
    const brandMissing = st.brand?.status === "missing";
    for (const [type, pending, code] of [
      ["brand", st.brand, st.brandCode],
      ["dept", st.dept, st.deptCode],
    ] as const) {
      if (!pending) continue;
      if (type === "brand" && brandMissing) {
        // §18 missing-brand: A-Z/0-9 allowed; legend commit ONLY when a name
        // was entered (blank = one-off, no legend write — the code rides the
        // re-fire as a per-ASIN override instead).
        if (!/^[A-Z0-9]{3}$/.test(code)) {
          setSkuCreate((m) => ({ ...m, [skip.asin]: { ...st, error: "brand code must be exactly 3 characters A-Z/0-9" } }));
          return;
        }
        const name = st.brandName.trim();
        if (name !== "") items.push({ type: "brand", rawValue: name, action: "approve_new", code });
        continue;
      }
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
        // One-off missing-brand code with nothing else pending: no legend
        // write at all — straight to the re-fire with the override.
        await createSkuAndInclude(skip, brandMissing ? st.brandCode : undefined);
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
      // Legend committed — continue the existing flow automatically. The
      // missing-brand code still rides as an override: the catalog has no
      // brand rawValue, so the legend row alone cannot resolve THIS ASIN.
      await createSkuAndInclude(skip, brandMissing ? st.brandCode : undefined);
    } catch (e: any) {
      setSkuCreate((m) => ({ ...m, [skip.asin]: { ...st, approving: false, error: e?.message ?? String(e) } }));
    }
  }

  async function sendToVelocity() {
    if (!SEND_ENABLED) return;
    setSending(true);
    try {
      const creates = allCreates.filter((r) => selCreates.has(recKey(r)));
      const updates = actionableUpdates.filter((u) => selUpdates.has(u.order_id));
      const body = await fetchLongSync("/api/velocity/execute", { creates, updates });
      setResults(body.results as ExecResult[]);
    } catch (e: any) {
      setResults([{ action: "send", outcome: "failed", error: e?.message ?? String(e) }]);
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  const resultFor = (kind: "create" | "update", idOrKey: string): ExecResult | undefined =>
    results?.find((r) =>
      kind === "create"
        ? r.action === "create" && `${(r.order_number ?? "").trim()}\u0000${(r.asin ?? "").trim().toUpperCase()}` === idOrKey
        : r.action === "update" && r.order_id === idOrKey,
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
      <DialogContent className="max-w-6xl w-[95vw] h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" /> Upload to Velocity
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span>Order date range:</span>
            <Input type="date" className="h-8 w-40" value={fromYmd}
              onChange={(e) => { setFromYmd(e.target.value); if (isCompleteYmd(e.target.value) && isCompleteYmd(toYmd)) fetchReview(e.target.value, toYmd); }} />
            <span>–</span>
            <Input type="date" className="h-8 w-40" value={toYmd}
              onChange={(e) => { setToYmd(e.target.value); if (isCompleteYmd(fromYmd) && isCompleteYmd(e.target.value)) fetchReview(fromYmd, e.target.value); }} />
            {data?.clamped && (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-400/50">
                clamped to {data.effectiveFrom} by order-date floor
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 pr-1">
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
                  <table className="w-full text-sm">
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
                  </table>
                )}
              </section>

              {/* b. QTY MISMATCHES */}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  Qty mismatches <span className="text-muted-foreground font-normal">({(data.updates ?? []).length})</span>
                </h3>
                {(data.updates ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">Sheet and Velocity agree on every matched order.</div>
                ) : (
                  <table className="w-full text-sm">
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
                  </table>
                )}
              </section>

              {/* c. SKIPPED */}
              {data.skips.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold mb-2">
                    Skipped <span className="text-muted-foreground font-normal">({data.skips.length})</span>
                  </h3>
                  <table className="w-full text-sm">
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
                                      <span className="text-muted-foreground max-w-[160px] truncate" title={st.brand.status === "missing" ? "brand missing from catalog" : st.brand.rawValue}>
                                        {st.brand.status === "missing" ? "brand missing — code" : `brand “${st.brand.rawValue}”`} →
                                      </span>
                                      <input
                                        aria-label="Brand code"
                                        className="font-mono text-xs font-bold rounded px-1 py-0.5 w-[3.5em] uppercase border border-input bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        value={st.brandCode}
                                        maxLength={3}
                                        disabled={st.approving}
                                        onChange={(e) => {
                                          const allowed = st.brand?.status === "missing" ? /[^A-Z0-9]/g : /[^A-Z]/g;
                                          const val = e.target.value.toUpperCase().replace(allowed, "").slice(0, 3);
                                          setSkuCreate((m) => ({ ...m, [s.asin]: { ...st, brandCode: val } }));
                                        }}
                                        spellCheck={false}
                                      />
                                    </label>
                                  )}
                                  {st.brand?.status === "missing" && (
                                    <label className="flex items-center gap-2">
                                      <span className="text-muted-foreground">name (optional)</span>
                                      <input
                                        aria-label="Brand name (optional)"
                                        className="text-xs rounded px-1 py-0.5 w-[12em] border border-input bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        value={st.brandName}
                                        disabled={st.approving}
                                        placeholder="blank = one-off, no legend write"
                                        onChange={(e) => setSkuCreate((m) => ({ ...m, [s.asin]: { ...st, brandName: e.target.value } }))}
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
                  </table>
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
                    {data.selfPrepExcluded > 0 && <div><span className="font-medium">Self-prep</span> — prep cost 0 on the sheet; these never go to Velocity.</div>}
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
