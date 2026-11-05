// SQL fragments of the supplier defects (SPEC §22 "Supplier defects",
// migration 094). No imports beyond the shared label, so the action-item
// unions (po-action-items.ts) can use them without an import cycle.
import { DEFECT_ACTION_ITEM } from "@shared/po-defect";

/** Open defects of an ASIN row (alias pa) / a PO (alias p) / a line (alias l) — for the derived action item. */
export const OPEN_DEFECT_ASIN_SQL = (pa: string) => `EXISTS (SELECT 1 FROM po_line_defects d JOIN po_line_items dl ON dl.id = d.po_line_item_id WHERE dl.po_asin_id = ${pa}.id AND d.status = 'open')`;
export const OPEN_DEFECT_PO_SQL = (p: string) => `EXISTS (SELECT 1 FROM po_line_defects d WHERE d.po_id = ${p}.id AND d.status = 'open')`;
export const OPEN_DEFECT_LINE_SQL = (lineIdExpr: string) => `EXISTS (SELECT 1 FROM po_line_defects d WHERE d.po_line_item_id = ${lineIdExpr} AND d.status = 'open')`;
/** UNION branches adding the derived item. */
export const defectItemSql = (cond: string) => `UNION SELECT '${DEFECT_ACTION_ITEM}' WHERE ${cond}`;

/** Per open defect: amount − Σ linked refunds of any status (≥ 0) — what Refunds due adds for it. `d` = po_line_defects alias. */
const UNCOVERED_SQL = (d: string) => `GREATEST(0, COALESCE(${d}.amount, 0) - COALESCE((SELECT SUM(r.amount) FROM po_line_defect_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.defect_id = ${d}.id), 0))`;
/** Σ uncovered $ of a PO's open defects (alias p). */
export const DEFECT_UNCOVERED_PO_SQL = (p: string) => `(SELECT COALESCE(SUM(${UNCOVERED_SQL("d")}), 0) FROM po_line_defects d WHERE d.po_id = ${p}.id AND d.status = 'open')`;
/** A PO with an open defect not yet carried by a refund row. */
export const DEFECT_UNCOVERED_EXISTS_SQL = (p: string) => `EXISTS (SELECT 1 FROM po_line_defects d WHERE d.po_id = ${p}.id AND d.status = 'open' AND ${UNCOVERED_SQL("d")} > 0)`;
