import { describe, it, expect } from "vitest";
import { pickDefaultEmail, defaultEmailForSupplier, supplierKey } from "./supplier-defaults";

// Maria 2026-11-01: Email used defaults — walmart.com → orders@…, unknown supplier → mpeters.cqg@…, otherwise the most recent PO's email.
describe("Email used default", () => {
  it("the rule: the supplier's default, else the last PO's email, else the unknown-supplier default, else none", () => {
    expect(pickDefaultEmail({ defaults: { email_used: "orders@coastalqualitygoods.com" }, lastPoEmail: "mpeters.cqg@gmail.com", unknownDefault: "x@y.z" })).toEqual({ email: "orders@coastalqualitygoods.com", reason: "supplier_default" });
    expect(pickDefaultEmail({ defaults: {}, lastPoEmail: "mpeters.cqg@gmail.com", unknownDefault: "x@y.z" })).toEqual({ email: "mpeters.cqg@gmail.com", reason: "last_po" });
    expect(pickDefaultEmail({ defaults: null, lastPoEmail: null, unknownDefault: "mpeters.cqg@gmail.com" })).toEqual({ email: "mpeters.cqg@gmail.com", reason: "unknown_supplier" });
    expect(pickDefaultEmail({ defaults: null, lastPoEmail: "  ", unknownDefault: null })).toEqual({ email: null, reason: "none" });
    expect(supplierKey("  Walmart.com ")).toBe("walmart.com");
  });
  it("reads suppliers.supplier_defaults, then the newest PO with an email, then the setting", async () => {
    const calls: string[] = [];
    const q = async (sql: string, params: any[] = []) => {
      calls.push(sql);
      if (/FROM suppliers WHERE supplier = \$1/.test(sql)) return { rows: params[0] === "walmart.com" ? [{ supplier_defaults: { email_used: "orders@coastalqualitygoods.com" } }] : params[0] === "target.com" ? [{ supplier_defaults: {} }] : [], rowCount: 1 };
      if (/SELECT email_used FROM purchase_orders/.test(sql)) return { rows: params[0] === "target.com" ? [{ email_used: "mpeters.cqg@gmail.com" }] : [], rowCount: 1 };
      if (/po_email_unknown_supplier/.test(sql)) return { rows: [{ value: "mpeters.cqg@gmail.com" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    expect(await defaultEmailForSupplier(q, "Walmart.com")).toEqual({ email: "orders@coastalqualitygoods.com", reason: "supplier_default" });
    expect(await defaultEmailForSupplier(q, "target.com")).toEqual({ email: "mpeters.cqg@gmail.com", reason: "last_po" });
    expect(await defaultEmailForSupplier(q, "newstore.com")).toEqual({ email: "mpeters.cqg@gmail.com", reason: "unknown_supplier" });
    expect(await defaultEmailForSupplier(q, "")).toEqual({ email: "mpeters.cqg@gmail.com", reason: "unknown_supplier" });
    expect(calls.some((s) => /ORDER BY order_date DESC, entry_seq DESC NULLS LAST, id DESC LIMIT 1/.test(s))).toBe(true);
  });
});
