import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ============================================================================
// Shapes (mirror server/offer-add.ts OfferAddResult)
// ============================================================================
// Mirror of server SubmitOutcome.would_submit (via routes.ts mapper).
// brandCode/registry/proposedNnn/proposedTtl drive the editor: operator
// types NNN → client looks up in registry → TTL locks (existing product)
// or stays editable (new product).
export interface RegistryEntry {
  brandCode: string;
  nnn: number;
  ttl: string;
  deptCode: string;
  productName: string | null;
  firstAsin: string | null;
  registeredAt: string;
}
export type OfferAddOutcome =
  | {
      kind: "preview";
      asin: string;
      sku: string;
      reused: boolean;
      payload: any;
      // 18555-cap surfacing (SPEC §18 "Suppression cap")
      priceDetail?: string;
      // §18 max_order_quantity (2026-09-13): 6 at COGS <= $20, else 4;
      // 4 when COGS is unknown. Read from the assembled payload server-side.
      maxOrderQuantity?: number;
      capApplied?: boolean;
      noPriceReference?: boolean;
      lowRoiAfterCap?: boolean;
      brandCode?: string;
      registry?: RegistryEntry[];
      proposedNnn?: number;
      proposedTtl?: string;
    }
  | { kind: "created"; asin: string; sku: string; submissionId: string; warnings: any[] }
  | { kind: "putlistings_failed"; asin: string; sku: string; reason: string; originalCode: string | null; originalMessage: string; retryable: boolean; rawResponse?: unknown }
  | { kind: "gated"; asin: string; details: string }
  | { kind: "dead_asin"; asin: string; details: string }
  | { kind: "legend_pending"; asin: string; pending: {
        // Brandless ASINs never appear here (§18, 2026-09-24) — they take the
        // reserved code NUL automatically, so rawValue is always a real brand.
        brand?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend"; legendId?: string | null } | null;
        dept?:  { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend"; legendId?: string | null } | null;
      }; details: string }
  | { kind: "duplicate_warning"; asin: string; existingSku: string; statuses: string[] }
  | { kind: "already_in_catalog"; asin: string; items: Array<{ sku: string; statuses: string[] }>; details?: string }
  | { kind: "resurrection_error"; asin: string; reason: string; details: string };

export interface PreviewResponse {
  preFilter: {
    excluded: Array<{ asin: string; reason: "catalog_deleted" | "gated" | "not_checked" }>;
  };
  perAsin: Array<{ asin: string; outcome: OfferAddOutcome }>;
  notes: {
    priceSource: string;
    productNumber: string;
    liveWrites: string;
  };
}

// Result of /api/offer-add/submit — discriminated union of per-ASIN outcomes
// (mirrors server/offer-add-submit.ts SubmitOutcome).
export type SubmitOutcome =
  | { kind: "created"; asin: string; sku: string; submissionId: string; warnings: any[]; resolvedPrice: number; priceRule: string }
  | { kind: "putlistings_failed"; asin: string; sku: string; reason: string; originalCode: string | null; originalMessage: string; retryable: boolean; resolvedPrice: number }
  | { kind: "skipped"; asin: string; reason: string; details: string };

export interface SubmitResponse {
  preFilter: { excluded: Array<{ asin: string; reason: string }> };
  perAsin: Array<{ asin: string; outcome: SubmitOutcome }>;
  notes: { liveWrites: string; submittedCount: number; skippedCount: number; failedCount: number };
}

interface OfferAddPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  data: PreviewResponse | null;
  errorMessage: string | null;
  onReviewApprovals?: () => void; // launches the LegendApprovalDialog
  // Confirm button: only enabled when ready bucket non-empty AND parent provides handler.
  // skuOverrides: per-ASIN operator edits to SKU (TTL/NNN segments). Empty map = no edits.
  onSubmit?: (asins: string[], skuOverrides: Record<string, string>) => Promise<SubmitResponse>;
}

// ============================================================================
// Helpers
// ============================================================================
function bucket(perAsin: PreviewResponse["perAsin"]) {
  const ready: typeof perAsin = [];
  const needsApproval: typeof perAsin = [];
  const alreadyInCatalog: typeof perAsin = [];
  const errors: typeof perAsin = [];
  for (const row of perAsin) {
    switch (row.outcome.kind) {
      case "preview":
        ready.push(row);
        break;
      case "legend_pending":
      case "duplicate_warning":
        needsApproval.push(row);
        break;
      case "already_in_catalog":
        alreadyInCatalog.push(row);
        break;
      case "gated":
      case "dead_asin":
      case "resurrection_error":
      case "putlistings_failed":
        errors.push(row);
        break;
    }
  }
  return { ready, needsApproval, alreadyInCatalog, errors };
}

function ReasonBadge({ kind }: { kind: string }) {
  const variant: any =
    kind === "preview" ? "default"
    : kind === "duplicate_warning" || kind === "legend_pending" || kind === "already_in_catalog" ? "secondary"
    : "destructive";
  const label =
    kind === "preview" ? "Ready"
    : kind === "legend_pending" ? "Needs legend approval"
    : kind === "duplicate_warning" ? "Already listed"
    : kind === "already_in_catalog" ? "Already in catalog"
    : kind === "gated" ? "Gated"
    : kind === "dead_asin" ? "Dead in catalog"
    : kind === "resurrection_error" ? "Error"
    : kind === "putlistings_failed" ? "Failed"
    : kind;
  return <Badge variant={variant} className="text-xs">{label}</Badge>;
}

// ============================================================================
// Component
// ============================================================================
export function OfferAddPreviewDialog({
  open,
  onClose,
  loading,
  data,
  errorMessage,
  onReviewApprovals,
  onSubmit,
}: OfferAddPreviewDialogProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResponse | null>(null);
  // Per-ASIN edit state. ONE NNN input (string-during-typing); TTL is
  // derived from the registry lookup at render time, NOT independently
  // editable for existing NNNs. For new (unused) NNNs, TTL is editable
  // and starts at proposedTtl.
  const [edits, setEdits] = useState<Record<string, { nnnInput: string; ttlForNew: string }>>({});
  // patched holds per-row re-fired preview outcomes, merged over data.perAsin
  // — no re-fetch, no dialog restart.
  // §18 same-product resolution (2026-09-04): in-batch (brand, NNN) claims by
  // multiple new-product rows are the documented same-product case, not an
  // error. Keyed `${brandCode}\u0000${nnn}`; true = operator confirmed SAME
  // PRODUCT (rows share the NNN; registry registers once via UNIQUE
  // (brand_code, nnn) + reuse_ok). "Different products" is an action, not
  // state — it bumps later rows to free NNNs, dissolving the group.
  const [sameProduct, setSameProduct] = useState<Record<string, boolean>>({});
  const [patched, setPatched] = useState<Record<string, PreviewResponse["perAsin"][number]>>({});

  useEffect(() => {
    if (open) {
      setExpanded(new Set());
      setSubmitting(false);
      setSubmitResult(null);
      setEdits({});
      setPatched({});
      setSameProduct({});
    }
  }, [open]);

  // Initialize edits from server proposals when a new preview lands.
  useEffect(() => {
    if (!data) return;
    const init: Record<string, { nnnInput: string; ttlForNew: string }> = {};
    for (const row of data.perAsin) {
      if (row.outcome.kind !== "preview" || row.outcome.reused) continue;
      const proposedNnn = row.outcome.proposedNnn ?? 1;
      const proposedTtl = row.outcome.proposedTtl ?? "";
      init[row.asin] = {
        nnnInput: String(proposedNnn).padStart(3, "0"),
        ttlForNew: proposedTtl,
      };
    }
    setEdits(init);
    setPatched({});
  }, [data]);

  const toggleExpand = (asin: string) => {
    const next = new Set(expanded);
    if (next.has(asin)) next.delete(asin);
    else next.add(asin);
    setExpanded(next);
  };

  const effectiveRows = data ? data.perAsin.map((r) => patched[r.asin] ?? r) : null;
  const buckets = effectiveRows ? bucket(effectiveRows) : null;

  // §18 missing-brand approve: optional legend commit (name provided →
  // approve_new via the single legend writer), then re-fire THIS row's
  // preview with the code as a per-ASIN override. The returned row replaces
  // the old one in place — READY on success, legend_pending with the error
  // in details (e.g. code collision) when correctable.
  // §18 same-product resolution: DIFFERENT PRODUCTS — keep the group's first
  // row (batch order) on the contested NNN and bump every later member to the
  // next free NNN (free = not in the brand's registry, not claimed by another
  // batch edit of the same brand). Rows re-render for review; the group
  // dissolves, so the prompt disappears without persisting state.
  function resolveDifferentProducts(groupKey: string) {
    if (!buckets) return;
    const [brand, nnnStr] = groupKey.split("\u0000");
    const nnn = parseInt(nnnStr, 10);
    const members = buckets.ready.filter((r) => {
      if (r.outcome.kind !== "preview" || r.outcome.reused || r.outcome.brandCode !== brand) return false;
      const e = edits[r.asin];
      return !!e && /^\d{1,3}$/.test(e.nnnInput) && parseInt(e.nnnInput, 10) === nnn
        && !(r.outcome.registry ?? []).some((reg) => reg.nnn === nnn);
    });
    if (members.length < 2) return;
    const claimed = new Set<number>();
    for (const r of buckets.ready) {
      if (r.outcome.kind !== "preview" || r.outcome.reused || r.outcome.brandCode !== brand) continue;
      for (const reg of r.outcome.registry ?? []) claimed.add(reg.nnn);
      const e = edits[r.asin];
      if (e && /^\d{1,3}$/.test(e.nnnInput)) claimed.add(parseInt(e.nnnInput, 10));
    }
    const bumps = planDifferentProducts(members.map((m) => m.asin), claimed);
    setEdits((prev) => {
      const out = { ...prev };
      for (const [asin, nnn] of Object.entries(bumps)) {
        out[asin] = { ...out[asin], nnnInput: String(nnn).padStart(3, "0") };
      }
      return out;
    });
    setSameProduct((m) => { const n = { ...m }; delete n[groupKey]; return n; });
  }

  const totalReady = buckets?.ready.length ?? 0;
  const totalExcluded = data?.preFilter.excluded.length ?? 0;
  const totalApproval = buckets?.needsApproval.length ?? 0;
  const totalAlreadyIn = buckets?.alreadyInCatalog.length ?? 0;
  const totalErrors = buckets?.errors.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add to Seller Central — Preview</DialogTitle>
          <DialogDescription>
            {loading
              ? "Resolving SKUs and assembling payloads…"
              : errorMessage
                ? `Error: ${errorMessage}`
                : data
                  ? `${totalReady} ready · ${totalAlreadyIn} already in catalog · ${totalApproval} need approval · ${totalErrors} errors · ${totalExcluded} excluded (pre-filter)`
                  : "—"}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Calling SP-API catalog + listings checks per ASIN…
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4 text-sm">
            {/* Pre-filter exclusions */}
            {data.preFilter.excluded.length > 0 && (
              <Section title="Excluded (pre-filter)" count={data.preFilter.excluded.length}>
                {data.preFilter.excluded.map((e) => (
                  <Row key={e.asin}>
                    <code className="font-mono text-xs">{e.asin}</code>
                    <Badge variant="destructive" className="text-xs">
                      {e.reason === "catalog_deleted" ? "Catalog deleted" : e.reason === "gated" ? "Gated" : "Not analyzed yet"}
                    </Badge>
                  </Row>
                ))}
              </Section>
            )}

            {/* Errors from orchestrator */}
            {buckets && buckets.errors.length > 0 && (
              <Section title="Errors" count={buckets.errors.length}>
                {buckets.errors.map((row) => (
                  <Row key={row.asin}>
                    <code className="font-mono text-xs">{row.asin}</code>
                    <ReasonBadge kind={row.outcome.kind} />
                    <span className="text-xs text-muted-foreground flex-1 truncate">
                      {"details" in row.outcome ? row.outcome.details : ""}
                      {"originalMessage" in row.outcome ? row.outcome.originalMessage : ""}
                    </span>
                  </Row>
                ))}
              </Section>
            )}

            {/* Already in catalog — skipped (NEVER create a duplicate offer) */}
            {buckets && buckets.alreadyInCatalog.length > 0 && (
              <Section title="Already in catalog — skipped" count={buckets.alreadyInCatalog.length}>
                {buckets.alreadyInCatalog.map((row) => (
                  <Row key={row.asin}>
                    <code className="font-mono text-xs">{row.asin}</code>
                    <ReasonBadge kind={row.outcome.kind} />
                    <span className="text-xs text-muted-foreground flex-1 truncate">
                      {row.outcome.kind === "already_in_catalog"
                        ? (row.outcome.items?.length
                          ? row.outcome.items.map((it) => `${it.sku}${it.statuses.length ? ` [${it.statuses.join(",")}]` : ""}`).join("; ")
                          : (row.outcome as any).details ?? "Already listed under your seller in SC")
                        : ""}
                    </span>
                  </Row>
                ))}
                <p className="text-xs text-muted-foreground italic mt-2">
                  Existing listings under your seller — any status (discoverable, buyable, closed). Never adding a second offer to these.
                </p>
              </Section>
            )}

            {/* Need approval */}
            {buckets && buckets.needsApproval.length > 0 && (
              <Section title="Need approval" count={buckets.needsApproval.length}>
                {buckets.needsApproval.map((row) => {
                  return (
                    <div key={row.asin}>
                      <Row>
                        <code className="font-mono text-xs">{row.asin}</code>
                        <ReasonBadge kind={row.outcome.kind} />
                        <span className="text-xs text-muted-foreground flex-1 truncate">
                          {row.outcome.kind === "legend_pending" && row.outcome.pending
                            ? renderLegendPending(row.outcome.pending)
                            : row.outcome.kind === "duplicate_warning"
                              ? `Existing SKU ${row.outcome.existingSku} (${row.outcome.statuses.join(", ")})`
                              : ""}
                        </span>
                      </Row>
                    </div>
                  );
                })}
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground italic">
                    Brand/dept codes need approval before these ASINs can submit.
                  </p>
                  {onReviewApprovals && (
                    <Button size="sm" variant="default" onClick={onReviewApprovals}>
                      Review approvals →
                    </Button>
                  )}
                </div>
              </Section>
            )}

            {/* Ready to create — registry-aware NNN editor (TTL locks for existing NNNs) */}
            {buckets && buckets.ready.length > 0 && (
              <Section title="Ready to create" count={buckets.ready.length}>
                {/* §18 born-closed: every creation carries a past end_at */}
                <p className="text-[11px] text-muted-foreground">Offers are created closed.</p>
                {buckets.ready.map((row) => {
                  if (row.outcome.kind !== "preview") return null;
                  const isExpanded = expanded.has(row.asin);
                  const o = row.outcome;
                  const price = o.payload?.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? 0;
                  const editable = !o.reused;
                  const parts = o.sku.split("-");
                  const edit = edits[row.asin] ?? { nnnInput: String(o.proposedNnn ?? 1).padStart(3, "0"), ttlForNew: o.proposedTtl ?? "" };
                  const v = editable ? validateRow(edit, parts, o, buckets.ready, edits, sameProduct) : null;
                  return (
                    <div key={row.asin} className={`border rounded p-2 space-y-1 ${v?.error ? "border-destructive" : v?.resolution ? "border-amber-500" : ""}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="font-mono text-xs">{row.asin}</code>
                        <Badge variant={o.reused ? "secondary" : (v?.classification === "existing" ? "secondary" : "default")} className="text-xs">
                          {o.reused ? "Reusing SKU" : v?.classification === "existing" ? "Reusing product" : "New product"}
                        </Badge>
                        {editable ? (
                          <span className="font-mono text-xs flex items-center gap-0.5">
                            <span className="text-muted-foreground">{parts[0]}-{parts[1]}-{parts[2]}-</span>
                            <input
                              aria-label="TTL"
                              className="font-mono text-xs font-bold rounded px-1 py-0 w-[3.5em] uppercase border border-input bg-background text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                              value={v?.ttl ?? edit.ttlForNew}
                              maxLength={3}
                              disabled={v?.classification === "existing"}
                              readOnly={v?.classification === "existing"}
                              title={v?.classification === "existing" ? "TTL is locked — bound to existing NNN" : "TTL for new product (3 uppercase letters)"}
                              onChange={(e) => {
                                const val = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                                setEdits((prev) => ({ ...prev, [row.asin]: { ...edit, ttlForNew: val } }));
                              }}
                              spellCheck={false}
                            />
                            <span className="text-muted-foreground">-</span>
                            <input
                              aria-label="NNN"
                              className="font-mono text-xs font-bold rounded px-1 py-0 w-[3.5em] border border-input bg-background text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                              value={edit.nnnInput}
                              maxLength={3}
                              onChange={(e) => {
                                const val = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
                                setEdits((prev) => ({ ...prev, [row.asin]: { ...edit, nnnInput: val } }));
                              }}
                              spellCheck={false}
                            />
                            {parts[5] ? <span className="text-muted-foreground">-{parts[5]}</span> : null}
                          </span>
                        ) : (
                          <code className="font-mono text-xs font-bold">{o.sku}</code>
                        )}
                        <span className="text-xs text-muted-foreground ml-auto" title={o.priceDetail}>${Number(price).toFixed(2)}</span>
                        {/* §18 per-order cap (2026-09-13) — eyeball which cap
                            each ASIN got before firing. 6 = COGS <= $20. */}
                        {o.maxOrderQuantity != null && (
                          <Badge
                            variant="outline"
                            className="text-[10px]"
                            title={`Max order quantity ${o.maxOrderQuantity} — ${o.maxOrderQuantity === 6 ? "COGS ≤ $20" : "COGS > $20 or unknown"}`}
                            data-testid={`badge-max-order-qty-${row.asin}`}
                          >
                            max {o.maxOrderQuantity}
                          </Badge>
                        )}
                        {/* 18555-cap indicators (SPEC §18 "Suppression cap") */}
                        {o.capApplied && (
                          <Badge variant="secondary" className="text-[10px]" title={o.priceDetail}>capped</Badge>
                        )}
                        {o.noPriceReference && (
                          <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600" title="No CPT / buy box reference — price is uncapped; 18555 suppression risk">
                            18555 risk
                          </Badge>
                        )}
                        {o.lowRoiAfterCap && (
                          <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600" title={o.priceDetail}>
                            low ROI
                          </Badge>
                        )}
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => toggleExpand(row.asin)}>
                          {isExpanded ? "Hide payload" : "View payload"}
                        </Button>
                      </div>
                      {editable && v && (
                        <div className="text-[10px] flex items-center gap-3 pl-2 flex-wrap">
                          {v.error ? (
                            <span className="text-destructive">⚠ {v.error}</span>
                          ) : v.resolution ? (
                            <span className="flex items-center gap-2 flex-wrap text-amber-600 dark:text-amber-500" data-testid={`same-product-${row.asin}`}>
                              Same product listed under {v.resolution.count} ASINs?
                              <Button size="sm" variant="outline" className="h-5 text-[10px] px-1.5"
                                onClick={() => setSameProduct((m) => ({ ...m, [v.resolution!.groupKey]: true }))}>
                                Same product
                              </Button>
                              <Button size="sm" variant="outline" className="h-5 text-[10px] px-1.5"
                                onClick={() => resolveDifferentProducts(v.resolution!.groupKey)}>
                                Different products
                              </Button>
                            </span>
                          ) : (
                            <>
                              <span className="text-muted-foreground">
                                Final SKU: <code className="font-mono font-bold text-foreground">{v.finalSku}</code>
                                {v.changed ? <span className="text-blue-600 dark:text-blue-400 ml-1">(edited)</span> : null}
                              </span>
                              {v.classification === "existing" && v.existingRow && (
                                <span className="text-emerald-700 dark:text-emerald-400">
                                  Reusing: {v.existingRow.productName ?? "(unnamed product)"}
                                </span>
                              )}
                              {v.classification === "new" && (
                                <span className="text-blue-700 dark:text-blue-400">
                                  New product — registers on submit
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {isExpanded && (
                        <pre className="text-[10px] bg-muted/50 rounded p-2 overflow-x-auto max-h-64">
                          {JSON.stringify(o.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </Section>
            )}
          </div>
        )}

        {/* Submission results — shown after Confirm fires */}
        {submitResult && (
          <div className="space-y-2 mt-4 border-t pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide">
              Submission results · {submitResult.notes.submittedCount} accepted (verification pending) · {submitResult.notes.failedCount} failed · {submitResult.notes.skippedCount} skipped
            </div>
            {submitResult.perAsin.map((row) => (
              <div key={row.asin} className="flex items-center gap-2 text-xs py-1 px-1 border rounded">
                <code className="font-mono">{row.asin}</code>
                {row.outcome.kind === "created" && (
                  <>
                    <Badge variant="secondary" className="text-xs">ACCEPTED</Badge>
                    <code className="font-mono">{row.outcome.sku}</code>
                    <span className="text-muted-foreground">@ ${row.outcome.resolvedPrice.toFixed(2)} · {row.outcome.priceRule}</span>
                    <span className="text-muted-foreground ml-auto">verification pending · sub: {row.outcome.submissionId}</span>
                  </>
                )}
                {row.outcome.kind === "putlistings_failed" && (
                  <>
                    <Badge variant="destructive" className="text-xs">FAILED</Badge>
                    <span className="text-destructive">{row.outcome.reason}</span>
                    <span className="text-muted-foreground truncate flex-1">{row.outcome.originalMessage}</span>
                  </>
                )}
                {row.outcome.kind === "skipped" && (
                  <>
                    <Badge variant="secondary" className="text-xs">SKIPPED</Badge>
                    <span className="text-muted-foreground">{row.outcome.reason}</span>
                    <span className="text-muted-foreground truncate flex-1">{row.outcome.details}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {submitResult ? "Done" : "Close"}
          </Button>
          {!submitResult && (
            <SubmitButton
              ready={totalReady}
              submitting={submitting}
              disabled={!onSubmit || totalReady === 0 || submitting || hasAnyValidationError(buckets, edits, sameProduct)}
              onClick={async () => {
                if (!buckets || !onSubmit) return;
                setSubmitting(true);
                const asinsToSubmit = buckets.ready.map((r) => r.asin);
                // Build skuOverrides from operator NNN/TTL edits. For each
                // generate-path Ready row, the FINAL SKU is BRD-DEP-AS3 +
                // (locked-TTL OR new-product-TTL) + padded-NNN [+variant].
                // The server's registry validation in offerAddForAsin is the
                // backstop — even if we somehow build a ttl_mismatch SKU,
                // submit rejects it pre-PUT.
                const overrides: Record<string, string> = {};
                for (const row of buckets.ready) {
                  if (row.outcome.kind !== "preview" || row.outcome.reused) continue;
                  const parts = row.outcome.sku.split("-");
                  const e = edits[row.asin];
                  if (!e) continue;
                  const v = validateRow(e, parts, row.outcome, buckets.ready, edits, sameProduct);
                  if (v.error || v.resolution || !v.finalSku) continue; // skip — gate should have blocked
                  if (v.finalSku !== row.outcome.sku) overrides[row.asin] = v.finalSku;
                }
                try {
                  const result = await onSubmit(asinsToSubmit, overrides);
                  setSubmitResult(result);
                } catch (err: any) {
                  setSubmitResult({
                    preFilter: { excluded: [] },
                    perAsin: asinsToSubmit.map((asin) => ({
                      asin,
                      outcome: { kind: "skipped", asin, reason: "request_failed", details: err.message },
                    })),
                    notes: { liveWrites: "ERRORED", submittedCount: 0, skippedCount: asinsToSubmit.length, failedCount: 0 },
                  });
                } finally {
                  setSubmitting(false);
                }
              }}
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Small UI helpers
// ============================================================================
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        {title} ({count})
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent/30">{children}</div>;
}

// Two-stage confirm: first click → "really submit?", second click → actually fires.
// Defensive against accidental clicks on this high-stakes button.
// One-click submit. Single button whose label shows the count; clicking fires
// the live PUT(s) immediately (no arming step). While in flight, shows
// "Submitting…" and stays disabled. If externally disabled (no ASINs, or a
// validation error on a row), shows the static label inside a tooltip
// explaining why.
function SubmitButton({
  ready,
  submitting,
  disabled,
  onClick,
}: {
  ready: number;
  submitting: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = `Submit ${ready} offer${ready === 1 ? "" : "s"} to Seller Central`;
  if (submitting) {
    return <Button disabled>Submitting…</Button>;
  }
  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button disabled>{label}</Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {ready === 0
              ? "No ASINs in 'Ready' bucket — resolve blockers first."
              : "Resolve validation errors on the rows above before submitting."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return <Button onClick={onClick}>{label}</Button>;
}

// ============================================================================
// Registry-aware SKU edit validation
// ============================================================================

interface RowValidation {
  classification: "existing" | "new"; // existing = NNN in registry; new = unused NNN
  ttl: string;                         // the effective TTL (locked-from-registry OR ttlForNew)
  finalSku: string;
  changed: boolean;
  existingRow?: RegistryEntry;         // present when classification === "existing"
  error?: string;
  // §18 same-product resolution pending: N same-brand new-product rows claim
  // this NNN. Gates submit like an error until resolved; never set when the
  // group is marked same-product.
  resolution?: { groupKey: string; count: number };
}

function padNnn(s: string): string { return s.padStart(3, "0"); }

// §18 different-products bump (pure, exported for tests): keep the group's
// first member on the contested NNN; every later member gets the next free
// NNN not in `claimed` (registry ∪ batch claims for the brand).
export function planDifferentProducts(memberAsins: string[], claimed: Set<number>): Record<string, number> {
  const taken = new Set(claimed);
  const out: Record<string, number> = {};
  for (const asin of memberAsins.slice(1)) {
    let n = 1;
    while (taken.has(n)) n++;
    taken.add(n);
    out[asin] = n;
  }
  return out;
}

function assembleFinalSku(parts: string[], ttl: string, nnn: string): string {
  const tail = parts[5] ? `-${parts[5]}` : "";
  return `${parts[0]}-${parts[1]}-${parts[2]}-${ttl}-${padNnn(nnn)}${tail}`;
}

// Validate one Ready row's edit against the brand registry + sibling rows.
// Returns classification, effective TTL, final SKU, error (if any).
export function validateRow(
  edit: { nnnInput: string; ttlForNew: string },
  canonicalParts: string[],
  outcome: Extract<OfferAddOutcome, { kind: "preview" }>,
  readyRows: Array<{ asin: string; outcome: OfferAddOutcome }>,
  allEdits: Record<string, { nnnInput: string; ttlForNew: string }>,
  sameProduct: Record<string, boolean> = {},
): RowValidation {
  // 1. NNN format/range
  if (!/^\d{1,3}$/.test(edit.nnnInput)) {
    return { classification: "new", ttl: edit.ttlForNew, finalSku: "", changed: false, error: "NNN must be 1–3 digits" };
  }
  const nnnNum = parseInt(edit.nnnInput, 10);
  if (nnnNum < 1 || nnnNum > 999) {
    return { classification: "new", ttl: edit.ttlForNew, finalSku: "", changed: false, error: "NNN must be 1..999" };
  }

  // 2. Registry lookup — existing or new product
  const registry = outcome.registry ?? [];
  const existing = registry.find((r) => r.nnn === nnnNum);
  const classification: "existing" | "new" = existing ? "existing" : "new";
  const ttl = existing ? existing.ttl : edit.ttlForNew;

  // 3. TTL must be a valid 3-letter code (for new product path; existing is registry-supplied)
  if (!/^[A-Z]{3}$/.test(ttl)) {
    return { classification, ttl, finalSku: "", changed: false, existingRow: existing,
      error: "TTL must be exactly 3 uppercase letters [A-Z]" };
  }

  const finalSku = assembleFinalSku(canonicalParts, ttl, edit.nnnInput);
  const changed = finalSku !== outcome.sku;

  // 4. Batch-internal collision: no two ready rows in the SAME brand may resolve
  // to the same (NNN, TTL) pair when both are NEW products. (Reuse against the
  // same existing NNN is fine across batch rows — both end up with the same
  // SKU prefix BRD-?-?-TTL-NNN, but the DEP/AS3 segments are per-ASIN, so the
  // full SKUs are distinct.)
  //
  // Actually the real risk: two NEW products both claiming the same unused NNN.
  // Catches the operator typing "use NNN 5" on two different ASINs in one batch.
  if (classification === "new") {
    // §18 (2026-09-04): same-brand new-product rows claiming one NNN is the
    // documented same-product case ("AS3 … auto-disambiguates the 'same
    // product, different ASIN' case"), resolved per GROUP — never pairwise.
    const groupSibs: Array<{ asin: string; ttl: string; finalSku: string }> = [];
    let existingSib: string | null = null;
    for (const sib of readyRows) {
      if (sib.asin === outcome.asin) continue;
      if (sib.outcome.kind !== "preview" || sib.outcome.reused) continue;
      if (sib.outcome.brandCode !== outcome.brandCode) continue;
      const sibEdit = allEdits[sib.asin];
      if (!sibEdit || !/^\d{1,3}$/.test(sibEdit.nnnInput)) continue;
      const sibNnn = parseInt(sibEdit.nnnInput, 10);
      if (sibNnn !== nnnNum) continue;
      const sibRegistry = sib.outcome.registry ?? [];
      if (sibRegistry.some((r) => r.nnn === sibNnn)) { existingSib = sib.asin; continue; }
      const sibParts = sib.outcome.sku.split("-");
      const sibTtl = sibEdit.ttlForNew;
      groupSibs.push({ asin: sib.asin, ttl: sibTtl, finalSku: assembleFinalSku(sibParts, sibTtl, sibEdit.nnnInput) });
    }
    if (existingSib) {
      // Inconsistent registry views (sibling reuses this NNN as existing while
      // our registry lacks it) — unchanged hard error.
      return { classification, ttl, finalSku, changed, existingRow: existing,
        error: `Cannot create a new product at NNN ${padNnn(edit.nnnInput)}; ${existingSib} in this batch is reusing it as existing product` };
    }
    if (groupSibs.length > 0) {
      // Byte-identical final SKU (same AS3 too) — X-suffix territory, ALWAYS a
      // hard error, never auto-resolved.
      const twin = groupSibs.find((s) => s.finalSku === finalSku);
      if (twin) {
        return { classification, ttl, finalSku, changed, existingRow: existing,
          error: `Final SKU '${finalSku}' is byte-identical to ${twin.asin}'s — a duplicate offer on one SKU needs the X variant suffix, never auto-resolved` };
      }
      const groupKey = `${outcome.brandCode}\u0000${nnnNum}`;
      if (sameProduct[groupKey]) {
        // Same product confirmed: shared NNN requires an identical TTL group-wide.
        const odd = groupSibs.find((s) => s.ttl !== ttl);
        if (odd) {
          return { classification, ttl, finalSku, changed, existingRow: existing,
            error: `Same product must share one TTL — this row is '${ttl}' but ${odd.asin} is '${odd.ttl}'` };
        }
        // Proceeds sharing (brand, NNN). Registration on submit records ONE
        // product: UNIQUE (brand_code, nnn) — first row reserves, later
        // same-TTL rows take reuse_ok.
      } else {
        return { classification, ttl, finalSku, changed, existingRow: existing,
          resolution: { groupKey, count: groupSibs.length + 1 } };
      }
    }
  }

  return { classification, ttl, finalSku, changed, existingRow: existing };
}

// True if any ready row has a validation error. Gates the confirm button.
function hasAnyValidationError(
  buckets: ReturnType<typeof bucket> | null,
  edits: Record<string, { nnnInput: string; ttlForNew: string }>,
  sameProduct: Record<string, boolean> = {},
): boolean {
  if (!buckets) return false;
  for (const row of buckets.ready) {
    if (row.outcome.kind !== "preview" || row.outcome.reused) continue;
    const parts = row.outcome.sku.split("-");
    const edit = edits[row.asin] ?? {
      nnnInput: String(row.outcome.proposedNnn ?? 1).padStart(3, "0"),
      ttlForNew: row.outcome.proposedTtl ?? "",
    };
    const v = validateRow(edit, parts, row.outcome, buckets.ready, edits, sameProduct);
    if (v.error || v.resolution) return true; // unresolved same-product prompt gates like an error
  }
  return false;
}

function renderLegendPending(pending: any): string {
  const parts: string[] = [];
  if (pending.brand) parts.push(`brand "${pending.brand.rawValue}" → ${pending.brand.proposedCode} (${pending.brand.status})`);
  if (pending.dept) parts.push(`dept "${pending.dept.rawValue}" → ${pending.dept.proposedCode} (${pending.dept.status})`);
  return parts.join("; ");
}
