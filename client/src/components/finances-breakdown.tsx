/**
 * The profit breakdown panel (Finances API patch commit 7 / 8, SPEC §6):
 * "More" on a Dashboard tile opens it for the account and that tile's range;
 * an ASIN's Actual Profit cell opens it for that ASIN and the page's range.
 * Layout, wording and look are the approved mockup's
 * (docs/mockups/finances-breakdown-2026-11-19.html → finances-breakdown.css).
 * Groups collapse and expand with the chevron; a fee line with an estimated
 * part says so on hover only.
 */
import { useEffect, useState } from "react";
import type { FinancesBreakdown } from "@shared/finances";
import { panelRows } from "@/lib/finances-panel";
import "./finances-breakdown.css";

export interface FinancesPanelProps {
  title: string;
  /** "Aug 1 – 31" */
  subtitle: string;
  from: string;
  to: string;
  asin?: string | null;
  onClose: () => void;
}

export function FinancesBreakdownPanel({ title, subtitle, from, to, asin, onClose }: FinancesPanelProps) {
  const [data, setData] = useState<FinancesBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    const q = new URLSearchParams({ from, to }); if (asin) q.set("asin", asin);
    fetch(`/api/finances/breakdown?${q.toString()}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); return r.json(); })
      .then((b) => { if (alive) setData(b); })
      .catch((e) => { if (alive) setError(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [from, to, asin]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const toggle = (g: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const rows = data ? panelRows(data, collapsed) : [];
  return (
    <div className="finb" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="finances-panel-overlay">
      <div className="panel" role="dialog" aria-label={`${title} profit breakdown`} data-testid="finances-panel">
        <div className="ph">
          <div><div className="t" data-testid="finances-panel-title">{title}</div><div className="d">{subtitle}{data?.dataFrom ? ` · data from ${data.dataFrom}` : ""}</div></div>
          <button type="button" className="x" aria-label="Close" onClick={onClose} data-testid="finances-panel-close">×</button>
        </div>
        <div className="rows">
          {error && <div className="r p muted" data-testid="finances-panel-error"><span>{error}</span></div>}
          {!data && !error && <div className="r p muted"><span>Loading…</span></div>}
          {rows.map((r, i) => {
            if (r.kind === "hr") return <div key={i} className="hr" />;
            if (r.kind === "group") return (
              <div key={i} className={`r g${collapsed.has(r.group) ? " closed" : ""}`} onClick={() => toggle(r.group)} data-testid={`finances-group-${r.group}`} aria-expanded={!collapsed.has(r.group)}>
                <span>{r.label}</span><span>{r.value}</span>
              </div>
            );
            return (
              <div key={i} className={`r ${r.cls}${r.zero ? " z" : ""}`} title={r.title} data-testid={r.line ? `finances-line-${r.line}` : undefined}>
                <span>{r.label}</span><span>{r.value}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
