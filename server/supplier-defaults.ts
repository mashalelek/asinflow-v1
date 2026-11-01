// Supplier defaults (Maria 2026-11-01, PO form polish; migration 077; SPEC
// §22 "Suppliers"). `suppliers.supplier_defaults` is a JSON object per AF
// supplier; its one key today is `email_used` — the Email used the New PO
// form and Capture PO fill in for that supplier. The rule:
//   1. the supplier's own default (walmart.com → orders@coastalqualitygoods.com, seeded);
//   2. else the email on the supplier's most recent PO that has one;
//   3. else settings.po_email_unknown_supplier (mpeters.cqg@gmail.com) — a
//      supplier AF has no PO for, or none of whose POs recorded an email.
// Edited with SQL for now (there is no Settings → Suppliers page): a
// future page writes the same column.
import type { QueryLike } from "./scheduler/types";

export interface SupplierDefaults { email_used?: string }
export type EmailDefaultReason = "supplier_default" | "last_po" | "unknown_supplier" | "none";
export interface EmailDefault { email: string | null; reason: EmailDefaultReason }

export const supplierKey = (s: string): string => s.trim().toLowerCase();

/** Pure: the rule above over what the queries found. */
export function pickDefaultEmail(input: { defaults: SupplierDefaults | null; lastPoEmail: string | null; unknownDefault: string | null }): EmailDefault {
  const d = String(input.defaults?.email_used ?? "").trim();
  if (d) return { email: d, reason: "supplier_default" };
  const last = String(input.lastPoEmail ?? "").trim();
  if (last) return { email: last, reason: "last_po" };
  const u = String(input.unknownDefault ?? "").trim();
  return u ? { email: u, reason: "unknown_supplier" } : { email: null, reason: "none" };
}

export async function loadSupplierDefaults(query: QueryLike, supplier: string): Promise<SupplierDefaults | null> {
  const key = supplierKey(supplier);
  if (!key) return null;
  const row = (await query(`SELECT supplier_defaults FROM suppliers WHERE supplier = $1`, [key])).rows[0];
  return row ? ((row.supplier_defaults ?? {}) as SupplierDefaults) : null;
}

/** The Email used to fill in for a supplier (blank supplier → the unknown-supplier default). */
export async function defaultEmailForSupplier(query: QueryLike, supplier: string): Promise<EmailDefault> {
  const key = supplierKey(supplier);
  const defaults = await loadSupplierDefaults(query, key);
  const last = key
    ? (await query(
        `SELECT email_used FROM purchase_orders WHERE lower(btrim(supplier)) = $1 AND email_used IS NOT NULL AND btrim(email_used) <> ''
         ORDER BY order_date DESC, entry_seq DESC NULLS LAST, id DESC LIMIT 1`, [key])).rows[0]?.email_used ?? null
    : null;
  const unknown = (await query(`SELECT value FROM settings WHERE key = 'po_email_unknown_supplier'`)).rows[0]?.value;
  return pickDefaultEmail({ defaults, lastPoEmail: last == null ? null : String(last), unknownDefault: typeof unknown === "string" ? unknown : null });
}
