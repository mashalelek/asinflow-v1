// Monthly AI spend (Maria 2026-11-05; SPEC §11 / §22 "AI config"): every AI
// call is a po_prefill_log row with its cost estimate; Settings shows the
// total per calendar month (Eastern) by kind, and warns past the threshold
// in server/config/ai.ts (AI.monthlyWarnUsd, $20).
export const AI_SPEND_KINDS = ["capture_preview", "capture", "tracking_fallback", "doc_classify", "promo_classify", "backfill", "supplier_check"] as const;
export type AiSpendKind = (typeof AI_SPEND_KINDS)[number];
export const AI_SPEND_LABELS: Record<AiSpendKind, string> = {
  capture_preview: "Capture preview", capture: "Open in AF prefill", tracking_fallback: "Tracking fallback", doc_classify: "Document type",
  promo_classify: "Promo classify", backfill: "Prefill backfill", supplier_check: "Supplier check",
};
export interface AiSpendMonth { month: string; total: number; calls: number; byKind: Record<AiSpendKind, { calls: number; cost: number }>; over: boolean }
export interface AiSpend { months: AiSpendMonth[]; warnUsd: number }

/** Pure: rows (month YYYY-MM, kind, calls = model calls, cost) → one entry per month, newest first, every kind present. */
export function shapeAiSpend(rows: ReadonlyArray<{ month: string; kind: string; calls: number | string; cost: number | string }>, warnUsd: number): AiSpend {
  const by = new Map<string, AiSpendMonth>();
  for (const r of rows) {
    if (!(AI_SPEND_KINDS as readonly string[]).includes(r.kind)) continue;
    let m = by.get(r.month);
    if (!m) { m = { month: r.month, total: 0, calls: 0, byKind: Object.fromEntries(AI_SPEND_KINDS.map((k) => [k, { calls: 0, cost: 0 }])) as AiSpendMonth["byKind"], over: false }; by.set(r.month, m); }
    const cost = Number(r.cost) || 0, calls = Number(r.calls) || 0;
    m.byKind[r.kind as AiSpendKind] = { calls, cost: Math.round(cost * 100) / 100 };
    m.total += cost; m.calls += calls;
  }
  const months = Array.from(by.values()).sort((a, b) => b.month.localeCompare(a.month)).map((m) => ({ ...m, total: Math.round(m.total * 100) / 100, over: m.total > warnUsd }));
  return { months, warnUsd };
}
