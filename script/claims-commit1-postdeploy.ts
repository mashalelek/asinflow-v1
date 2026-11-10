// Post-deploy checks for claims commit 1 (migration 101) — READ-ONLY.
//   npm run claims:postdeploy -- [--prod] [--order <id>]...
// Prints: migration 101's ledger row, the basis counts, the claim counts, each named PO's rows through
// po_asin_expected (ASIN / Individual units, Expected, closed), Refunds due as the POs list sums it and as the
// Dashboard grid's cells show it (the same loadGrid the /api/dashboard route runs).
import "./env";
import { Pool } from "pg";
import { loadGrid, parseGridQuery } from "../server/dashboard";
import { REFUNDS_DUE_PO_SQL } from "../server/supplier-claim-sql";

async function main() {
  const args = process.argv.slice(2);
  const orders: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--order" && args[i + 1]) orders.push(args[++i]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined, max: 1 });
  const q = (text: string, params?: unknown[]) => pool.query(text, params as any[]);
  try {
    console.log(/render\.com/.test(process.env.DATABASE_URL ?? "") ? "PRODUCTION (read-only)" : "local");
    const m = (await q(`SELECT version, filename, applied_at FROM schema_migrations WHERE version = 101`)).rows[0];
    console.log("migration 101:", m ? `${m.filename} applied ${new Date(m.applied_at).toISOString()}` : "NOT APPLIED");
    const basis = (await q(`SELECT 'asin rows' AS t, qty_basis, COUNT(*)::int AS n FROM po_asins GROUP BY 1, 2 UNION ALL SELECT 'lines', qty_basis, COUNT(*)::int FROM po_line_items GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
    console.log("basis:", basis.map((b) => `${b.t} ${b.qty_basis} ${b.n}`).join(", "));
    const cl = (await q(`SELECT status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE qty IS NULL)::int AS no_qty FROM supplier_claims GROUP BY 1 ORDER BY 1`)).rows;
    console.log("claims:", cl.map((c) => `${c.status} ${c.n} (${c.no_qty} without qty)`).join(", "), "| open enter_quantity tasks:", (await q(`SELECT COUNT(*)::int AS n FROM supplier_claim_tasks WHERE kind = 'enter_quantity' AND done_at IS NULL`)).rows[0].n);
    for (const o of orders) {
      const rows = (await q(
        `SELECT p.order_id, p.supplier, p.closed_at IS NOT NULL AS closed, p.closed_by, pa.asin, pa.sold_as, pa.units_per_pack, pa.qty_basis,
                e.ordered_asin, e.ordered_individual, e.ordered_product, e.canceled_asin, e.claimed_asin, e.expected_asin, e.expected_individual, e.shipped_fba_asin, e.shipped_fba_individual, e.open_claims
           FROM purchase_orders p JOIN po_asins pa ON pa.po_id = p.id JOIN po_asin_expected e ON e.id = pa.id
          WHERE p.order_id = $1 ORDER BY pa.asin`, [o])).rows;
      if (rows.length === 0) { console.log(`PO ${o}: not found`); continue; }
      for (const r of rows) console.log(`PO ${r.order_id} (${r.supplier}, ${r.closed ? `closed by ${r.closed_by}` : "open"}) ${r.asin} ${r.sold_as ?? "pack?"} ×${r.units_per_pack ?? "—"} basis=${r.qty_basis}: Ordered ${r.ordered_asin} ASIN u. / ${r.ordered_individual ?? "—"} Individual u. / ${r.ordered_product ?? "—"} Product u.; canceled ${r.canceled_asin}, claimed ${r.claimed_asin}, Expected ${r.expected_asin} ASIN u. (${r.expected_individual ?? "—"} Individual); Shipped FBA ${r.shipped_fba_asin ?? "—"} (${r.shipped_fba_individual ?? "—"}); open claims ${r.open_claims}`);
      const lines = (await q(`SELECT le.position, le.ordered_product, le.ordered_individual, le.ordered_asin, le.expected_asin, le.product_pack, le.per_bundle, le.fully_canceled FROM po_line_expected le JOIN purchase_orders p ON p.id = le.po_id WHERE p.order_id = $1 ORDER BY le.po_asin_id, le.position`, [o])).rows;
      for (const l of lines) console.log(`   line ${l.position}: ${l.ordered_product} Product u. × pack ${l.product_pack ?? "—"} = ${l.ordered_individual ?? "—"} Individual u. = ${l.ordered_asin} ASIN u.; Expected ${l.expected_asin} ASIN u.${l.per_bundle != null ? `; per bundle ${l.per_bundle}` : ""}${l.fully_canceled ? "; CANCELED" : ""}`);
    }
    const due = (await q(`SELECT COALESCE(SUM(${REFUNDS_DUE_PO_SQL("p")}), 0)::float8 AS due, COUNT(*) FILTER (WHERE ${REFUNDS_DUE_PO_SQL("p")} > 0)::int AS pos FROM purchase_orders p`)).rows[0];
    console.log(`Refunds due, all POs (the POs list's column summed): $${Number(due.due).toFixed(2)} on ${due.pos} PO(s)`);
    for (const set of ["1", "2"]) {
      const parsed = parseGridQuery({ set });
      if ("error" in parsed) { console.log(`grid set ${set}: ${parsed.error}`); continue; }
      const grid = await loadGrid(q as any, parsed.set, parsed.custom);
      console.log(`Dashboard grid set ${set} refunds_due:`, grid.columns.map((c: any) => `${c.label ?? c.key}: $${Number(c.cells?.refunds_due?.value ?? 0).toFixed(2)}`).join(" · "));
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
