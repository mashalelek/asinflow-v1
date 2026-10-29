import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Patch docs/claude_spec-patch-shipment-reconciliation.md §5 — wiring pins
// (the two components have their own behavioural tests).
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("Sync Shipments route (§5.2, D3)", () => {
  const routes = read("server/routes.ts");
  const body = routes.slice(routes.indexOf('app.post("/api/pos/sync-shipments"'), routes.indexOf('app.get("/api/pos/unmatched"'));
  it("runs component A then B as a direct call, survives an A failure, dry run writes nothing, auto-close after a live run", () => {
    const a = body.indexOf("await syncVelocityShipments({ dryRun })");
    const b = body.indexOf("await syncScShipments({ dryRun })");
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(body).toMatch(/velocity = \{ error: err\?\.message \?\? String\(err\) \}/);
    expect(body).toMatch(/if \(!dryRun\) \{[\s\S]*evaluateAutoClose\(poId, poQuery\)/);
    expect(body).not.toMatch(/enqueueJob|enqueueOnboardingJob/);
    expect(body).toMatch(/return \{ dryRun, velocity, sc, autoClose \}/);
  });
  it("the unmatched panel reads only open lines + ambiguous shipments; the link route stamps resolved_po_asin_id and converts units to packs", () => {
    const un = routes.slice(routes.indexOf('app.get("/api/pos/unmatched"'), routes.indexOf('app.get("/api/pos/asin-rows/search"'));
    expect(un).toMatch(/WHERE u\.resolved_at IS NULL/);
    expect(un).toMatch(/WHERE v\.sc_match = 'ambiguous'/);
    expect(routes.slice(routes.indexOf('app.post("/api/pos/unmatched/:id/link"'), routes.indexOf("// === Bulk Profit Calculator"))).toMatch(/linkUnmatchedLine\(poQuery, /);
    const link = readFileSync(join(__dirname, "shipment-link.ts"), "utf8"); // the action itself (2026-10-29); run against the real schema in shipment-link.db.test.ts
    expect(link).toMatch(/UPDATE shipment_unmatched SET resolved_at = now\(\), resolved_po_asin_id = \$2/);
    expect(link).toMatch(/units \/ \(Number\(pa\.units_per_pack\) \|\| 1\)/);
    expect(link).toMatch(/evaluateAutoClose\(String\(pa\.po_id\), query\)/);
  });
  it("manual rows use manual:<uuid> and an FBA id array; only manual rows can be deleted", () => {
    const manual = routes.slice(routes.indexOf('app.post("/api/pos/asin-rows/:id/shipments"'), routes.indexOf('app.delete("/api/pos/shipments/:id"'));
    expect(manual).toMatch(/'manual:' \|\| uuid_generate_v4\(\)::text, \$2::text\[\]/);
    expect(manual).not.toMatch(/fba_shipment_id\b[^s]/);
    const del = routes.slice(routes.indexOf('app.delete("/api/pos/shipments/:id"'), routes.indexOf("// === Shipment reconciliation"));
    expect(del).toMatch(/cur\.source !== "manual"/);
  });
});

describe("POs page (§5.1 chip, §5.2 button + toast, §5.3 panel)", () => {
  it("the chip lists fba_shipment_ids per shipment grouped by date, warns when the SC match is not matched, shows received X of Y", () => {
    const c = read("client/src/components/po-asin-rows.tsx");
    expect(c).toMatch(/fba_shipment_ids: string\[\]/);
    expect(c).toMatch(/s\.source === "velocity" && s\.sc_match !== "matched"/);
    expect(c).toMatch(/received \$\{fmtQty\(received\)\} of \$\{fmtQty\(shipped\)\}/);
    expect(c).toMatch(/Group by Velocity ship date/);
    expect(c).toMatch(/editable && s\.source === "manual" && <button onClick=\{\(\) => remove\(s\.id\)\}/);
    expect(c).not.toMatch(/fba_shipment_id\b[^s]/);
  });
  it("Sync Shipments is a direct call with both outcomes in the toast; the Unmatched panel renders only when count > 0", () => {
    const page = read("client/src/pages/purchase-orders.tsx");
    expect(page).toMatch(/fetchLongSync\("\/api\/pos\/sync-shipments"\)/);
    expect(page).toMatch(/data-testid="button-sync-shipments"/);
    expect(page).toMatch(/if \(!data \|\| \(data\.count === 0 && \(data\.dismissed \?\? \[\]\)\.length === 0\)\) return null;/); // PO matching §6: a Dismissed list keeps it
    expect(page).toMatch(/\/api\/pos\/unmatched\/\$\{line\.id\}\/link/);
    expect(page).toMatch(/<UnmatchedPanel key=\{unmatchedKey\} onChanged=\{load\} suppliers=\{data\?\.suppliers \?\? \[\]\} \/>/);
  });
  it("syncShipmentsToast: counts for both components; destructive when either failed", async () => {
    const { syncShipmentsToast } = await import("../client/src/pages/purchase-orders");
    const ok = syncShipmentsToast({ dryRun: false, velocity: { counts: { shipments: 57, lines: 822, linesMatched: 752, linesNoOrder: 11, linesPoNotFound: 59 } }, sc: { counts: { matched: 50, ambiguous: 0, unmatched: 7, rowsReceivedUpdated: 700, overReceivedRows: 13 } }, autoClose: { evaluated: 10, closed: 3, reopened: 1 } });
    expect(ok).toEqual({ title: "Shipments synced", failed: false, description: "Velocity: 57 shipments, 752 of 822 lines matched, 70 unmatched. SC: 50 matched, 0 ambiguous, 7 unmatched, received updated on 700 rows, over-received 13. Auto-close: 3 closed, 1 reopened." });
    const bad = syncShipmentsToast({ dryRun: false, velocity: { error: "Velocity /shipments coverage incomplete" }, sc: { counts: { matched: 0, ambiguous: 0, unmatched: 0, rowsReceivedUpdated: 0 } }, autoClose: { evaluated: 0, closed: 0, reopened: 0 } });
    expect(bad.failed).toBe(true); expect(bad.title).toBe("Shipments synced with errors"); expect(bad.description).toMatch(/^Velocity: FAILED — Velocity \/shipments coverage incomplete\. SC: 0 matched/);
  });
});
