/**
 * The ASINs table's Sold as / Pack size cells (Maria 2026-11-06, migration 098). A confirmed pack shows plainly; one
 * that needs review shows its suggestion in amber with the source and reason on hover, and ✓ confirms it; a missing
 * one shows "—". The pencil sets the pack (both fields in one popover) — saved as Maria's, with History, and every PO
 * line for the ASIN with no pack filled (open lines directly, closed ones only where it reproduces their quantities).
 * Pack size = manufactured retail packages in one ASIN unit, never the items inside a package.
 */
import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { packStatus, PACK_REASON_LABEL, PACK_SOURCE_LABEL, type AsinPack, type AsinResult } from "@shared/schema";

type Gaps = { openRows: number; closedRows: number; closedSkipped: number; lines: number; openSkipped?: number; skipped?: Array<{ order_id?: string; closed: boolean; qty: number; at_pack: number | null; asin?: string }> };

/** Pure: the hover text — the status, where the value came from, why it waits for review, the evidence. */
export function packTitle(p: AsinPack | undefined): string {
  const s = packStatus(p);
  if (!p) return "";
  if (s === "confirmed") return `Confirmed — ${PACK_SOURCE_LABEL[p.source ?? ""] ?? p.source ?? "on record"}${p.note ? `\n${p.note}` : ""}`;
  const why = PACK_REASON_LABEL[p.reason ?? ""] ?? "";
  if (s === "needs_review") return `Needs review — ${why}${p.suggestionSource ? `; suggested by ${PACK_SOURCE_LABEL[p.suggestionSource] ?? p.suggestionSource}` : ""}${p.note ? `\n${p.note}` : ""}`;
  return p.note ? `Missing — ${why || "nothing found"}\n${p.note}` : "Missing";
}

/** Pure: what the cell shows — the confirmed value, else the suggestion; null when there is neither. */
export function packShown(p: AsinPack | undefined): { soldAs: string; units: number } | null {
  if (p?.soldAs) return { soldAs: p.soldAs, units: p.soldAs === "individual" ? 1 : p.units ?? 1 };
  if (p?.suggestedSoldAs) return { soldAs: p.suggestedSoldAs, units: p.suggestedSoldAs === "individual" ? 1 : p.suggestedUnits ?? 1 };
  return null;
}

/** Pure: the toast text — rows filled, and each row left because the pack does not reproduce its ASIN qty (strict, 2026-11-06). */
export function gapsNote(g: Gaps): string {
  const filled = g.openRows + g.closedRows === 0 ? "" : `filled ${g.openRows} open and ${g.closedRows} closed PO row${g.openRows + g.closedRows === 1 ? "" : "s"}`;
  const left = (g.skipped ?? []).map((s) => `${s.asin ? `${s.asin} ` : ""}${s.order_id ?? "a PO"}${s.closed ? "" : " (open)"}: ASIN units ${s.qty}, this pack gives ${s.at_pack ?? "no whole number"}`);
  const leftTxt = left.length ? `not written — the pack doesn't reproduce the stored ASIN units: ${left.slice(0, 5).join("; ")}${left.length > 5 ? ` +${left.length - 5} more` : ""}` : "";
  return [filled, leftTxt].filter(Boolean).join(" · ");
}

export async function savePack(asin: string, soldAs: string, units: number): Promise<{ gaps: Gaps }> {
  const res = await fetch(`/api/asins/${encodeURIComponent(asin)}/pack-size`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sold_as: soldAs, units_per_pack: units }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

export const confirmedPack = (p: AsinPack | undefined, soldAs: string, units: number): AsinPack => ({
  ...(p ?? { hasPo: false } as AsinPack), soldAs, units: soldAs === "individual" ? 1 : units, source: "manual",
  suggestedSoldAs: null, suggestedUnits: null, suggestionSource: null, reason: null, note: null,
});

export function PackCell({ result, col, onResultUpdate }: { result: AsinResult; col: "soldAs" | "packSize"; onResultUpdate: (asin: string, updates: Partial<AsinResult>) => void }) {
  const { toast } = useToast();
  const p = result.pack;
  const status = packStatus(p);
  const shown = packShown(p);
  const [open, setOpen] = useState(false);
  const [soldAs, setSoldAs] = useState("individual");
  const [units, setUnits] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(sa: string, u: number) {
    setBusy(true); setError(null);
    try {
      const r = await savePack(result.asin, sa, u);
      onResultUpdate(result.asin, { pack: confirmedPack(p, sa, u) });
      const note = gapsNote(r.gaps);
      if (note) toast({ title: `${result.asin}: pack set`, description: note });
      setOpen(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const text = shown == null ? "—" : col === "soldAs" ? shown.soldAs : String(shown.units);
  const tone = status === "needs_review" ? "text-amber-700 dark:text-amber-400" : status === "missing" ? "text-muted-foreground" : "";
  return (
    <span className="inline-flex max-w-full items-center gap-1" data-testid={`pack-${col}-${result.asin}`} data-pack-status={status}>
      <span className={`truncate text-sm ${tone}`} title={packTitle(p)}>{text}</span>
      {col === "soldAs" && status === "needs_review" && shown && (
        <button className="shrink-0 p-0 text-amber-700 hover:text-foreground dark:text-amber-400" title={`Confirm ${shown.soldAs === "individual" ? "individual" : `${shown.soldAs} ×${shown.units}`}`} disabled={busy}
          onClick={(e) => { e.stopPropagation(); void save(shown.soldAs, shown.units); }} data-testid={`pack-confirm-${result.asin}`}>
          <Check className="h-3 w-3" />
        </button>
      )}
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setSoldAs(shown?.soldAs ?? "individual"); setUnits(String(shown?.units ?? 1)); setError(null); } }}>
        <PopoverTrigger asChild>
          <button className="shrink-0 p-0 text-muted-foreground/40 hover:text-muted-foreground" onClick={(e) => e.stopPropagation()} title="Set the pack size — Individual units per ASIN unit" data-testid={`pack-edit-${col}-${result.asin}`}>
            <Pencil className="h-2.5 w-2.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Individual units per ASIN unit (the pack size) = retail packages in one ASIN unit; an Individual unit is one retail package, not the items inside it.</p>
            <div className="flex items-center gap-2">
              <select value={soldAs} onChange={(e) => { setSoldAs(e.target.value); if (e.target.value === "individual") setUnits("1"); else if (units === "1") setUnits("2"); }}
                className="h-8 w-28 rounded border border-border bg-background px-1 text-sm" data-testid={`pack-select-${result.asin}`}>
                <option value="individual">individual</option><option value="multi-pack">multi-pack</option><option value="bundle">bundle</option>
              </select>
              <span className="text-sm text-muted-foreground">×</span>
              <input value={units} disabled={soldAs === "individual"} inputMode="numeric" onChange={(e) => setUnits(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(soldAs, Number(units)); }}
                className="h-8 w-14 rounded border border-border bg-background px-2 text-right text-sm" data-testid={`pack-units-${result.asin}`} />
            </div>
            {status !== "confirmed" && p?.note && <p className="text-[11px] text-amber-700 dark:text-amber-400">{packTitle(p)}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Cancel</button>
              <button className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={busy} onClick={() => void save(soldAs, Number(units))} data-testid={`pack-save-${result.asin}`}>{busy ? "..." : "Save"}</button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
