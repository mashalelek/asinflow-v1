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
import { StickyNote, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtQty, individualUnits, PO_ASIN_COLUMNS } from "@/lib/po-qty";

export interface PoAsinShipment {
  id: number;
  fba_shipment_id: string;
  velocity_shipment_id: string | null;
  qty_shipped: string;
  qty_received: string | null;
  shipped_at: string | null;
  source: string;
}
export interface PoAsinLine {
  id: string;
  position: number | null;
  product_name: string | null;
  supplier_sku: string | null;
  price: string | null;
  item_discount: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  qty_canceled: number | null;
  qty_returned: number | null;
  final_qty: number | null;
  asin_qty_per_product: string | null;
  adjusted_product_cost: string | null;
  notes: string | null;
}
export interface PoAsinRowData {
  id: string;
  po_id: string;
  asin: string;
  asin_name: string | null;
  sku: string | null;
  qty: number;                       // Ordered (ASIN qty)
  cost_per_unit: string | null;
  total_cost: string | null;
  prep_cost: string | null;
  sold_as: string;
  units_per_pack: number;
  notes: string | null;
  thumbnail: string | null;
  // derived from the lines (NULL = some line untracked)
  qty_canceled_asin: string | null;
  qty_returned_asin: string | null;
  // stored ASIN quantities (NULL = not tracked)
  qty_shipped_supplier: string | null;
  qty_at_prep: string | null;
  qty_at_warehouse: string | null;
  qty_lost_damaged_us: string | null;
  qty_shipped_fba: string | null;
  qty_received_amazon: string | null;
  shipments: PoAsinShipment[];
  lines?: PoAsinLine[];
}

const COL_WIDTHS: Record<(typeof PO_ASIN_COLUMNS)[number]["key"], string> = {
  asin: "7rem", title: "18rem", sku: "11rem", ordered: "4.5rem", cost_per_unit: "5.5rem", total_cost: "6rem", prep: "4.5rem",
  sold_as: "6rem", units_per_pack: "5rem", individual_units: "7rem", canceled: "5rem", returned: "5rem", shipped_supplier: "6.5rem",
  at_prep: "6rem", at_warehouse: "6.5rem", lost_damaged_us: "6.5rem", shipped_fba: "5.5rem", received_amazon: "6.5rem", shipments: "11rem",
};
const LEAD_WIDTH = "2.75rem";

function Money({ v }: { v: string | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const n = parseFloat(v);
  const text = `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <span className={`font-mono ${n === 0 ? "text-muted-foreground/50" : ""}`}>{text}</span>;
}
/** A quantity cell: NULL → muted em-dash; 0 muted; fractional 2 dp. */
export function QtyCell({ v }: { v: string | number | null | undefined }) {
  const t = fmtQty(v);
  if (t === "—") return <span className="text-muted-foreground/50">—</span>;
  return <span className={t === "0" ? "text-muted-foreground/50" : ""}>{t}</span>;
}

function ShipmentChips({ shipments }: { shipments: PoAsinShipment[] }) {
  if (shipments.length === 0) return <span className="text-muted-foreground/50">—</span>;
  const total = shipments.reduce((t, s) => t + (parseFloat(s.qty_shipped) || 0), 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70" data-testid="po-shipments-chip">
          {shipments.length} shipment{shipments.length === 1 ? "" : "s"} · {fmtQty(total)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 text-xs space-y-1" align="start">
        {shipments.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2">
            <span className="font-mono">{s.fba_shipment_id}</span>
            <span>({fmtQty(s.qty_shipped)}{s.qty_received != null ? ` · rcvd ${fmtQty(s.qty_received)}` : ""})</span>
            <span className="text-muted-foreground">{s.source}</span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function PoAsinColGroup() {
  return (
    <colgroup>
      <col style={{ width: LEAD_WIDTH }} />
      {PO_ASIN_COLUMNS.map((c) => <col key={c.key} style={{ width: COL_WIDTHS[c.key] }} />)}
      <col style={{ width: "2rem" }} />
    </colgroup>
  );
}

export function PoAsinHeaderRow({ sub = false }: { sub?: boolean }) {
  const base = `px-3 py-2 text-xs font-medium whitespace-nowrap ${sub ? "text-muted-foreground" : ""}`;
  return (
    <tr className={sub ? "bg-muted/40" : "table-header-stone"} data-testid="po-asin-header">
      <th className={base}></th>
      {PO_ASIN_COLUMNS.map((c) => (
        <th key={c.key} className={`${base} ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
      ))}
      <th className={base}></th>
    </tr>
  );
}

const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;

/** One ASIN row (plus its bundle component lines when expanded). */
export function PoAsinRow({ a, indent = false }: { a: PoAsinRowData; indent?: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = a.lines ?? [];
  const multi = lines.length >= 2;
  const pad = indent ? "pl-6" : "";
  return (
    <>
      <tr className={`table-zebra-stone ${indent ? "text-[13px]" : ""}`} style={hairline} data-testid={`row-po-asin-${a.asin}`}>
        <td className={`px-2 py-1.5 ${pad}`}>
          <span className="inline-flex items-center gap-1">
            {multi && (
              <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground" data-testid={`button-expand-${a.asin}`}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {a.thumbnail && <img src={a.thumbnail} alt="" className="h-7 w-7 object-contain rounded-sm" />}
          </span>
        </td>
        <td className="px-3 py-1.5">
          <Link href={`/asins?q=${a.asin}`} className="font-mono text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{a.asin}</Link>
        </td>
        <td className="px-3 py-1.5 truncate" title={a.asin_name ?? ""}>{a.asin_name ?? <span className="text-muted-foreground/50">—</span>}</td>
        <td className="px-3 py-1.5">
          {a.sku ? <span className="font-mono text-xs">{a.sku}</span> : (
            <Tooltip>
              <TooltipTrigger asChild><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">No SKU — create offer first</p></TooltipContent>
            </Tooltip>
          )}
        </td>
        <td className="px-3 py-1.5 text-right">{a.qty}</td>
        <td className="px-3 py-1.5 text-right"><Money v={a.cost_per_unit} /></td>
        <td className="px-3 py-1.5 text-right"><Money v={a.total_cost} /></td>
        <td className="px-3 py-1.5 text-right"><Money v={a.prep_cost} /></td>
        <td className="px-3 py-1.5">{a.sold_as}</td>
        <td className="px-3 py-1.5 text-right">{a.units_per_pack}</td>
        <td className="px-3 py-1.5 text-right">{individualUnits(a.qty, a.units_per_pack)}</td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_canceled_asin} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_returned_asin} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_shipped_supplier} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_at_prep} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_at_warehouse} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_lost_damaged_us} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_shipped_fba} /></td>
        <td className="px-3 py-1.5 text-right"><QtyCell v={a.qty_received_amazon} /></td>
        <td className="px-3 py-1.5"><ShipmentChips shipments={a.shipments ?? []} /></td>
        <td className="px-2 py-1.5">{a.notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
      </tr>
      {multi && open && lines.map((l) => (
        <tr key={l.id} style={hairline} data-testid={`row-component-${a.asin}-${l.position}`}>
          <td className="px-2 py-1" />
          <td className="px-3 py-1 pl-8 text-xs text-muted-foreground" colSpan={2}>{l.product_name ?? "—"}</td>
          <td className="px-3 py-1 text-muted-foreground/50">—</td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><QtyCell v={l.qty_ordered} /></td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.price} /></td>
          <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.adjusted_product_cost} /></td>
          <td className="px-3 py-1" colSpan={PO_ASIN_COLUMNS.length - 6 + 1} />
        </tr>
      ))}
    </>
  );
}

/** A complete ASINs table (the detail tab). */
export function PoAsinTable({ asins, testId = "po-asins-table" }: { asins: PoAsinRowData[]; testId?: string }) {
  return (
    <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: "140rem" }} data-testid={testId}>
        <PoAsinColGroup />
        <thead><PoAsinHeaderRow /></thead>
        <tbody>{asins.map((a) => <PoAsinRow key={a.id} a={a} />)}</tbody>
      </table>
    </div>
  );
}
