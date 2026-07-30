/**
 * POs shell page (/purchase-orders) — heading + toolbar only, no content.
 *
 * The prior PO scaffold (list/new/detail pages, po-routes, po-cogs, PO tables)
 * was removed 2026-07-30 (SPEC §8) — functional but unused; its tables held
 * only seed data. The real PO module arrives later and will be built fresh.
 * The toolbar hosts the "Upload to Velocity" action (SPEC §11); Velocity
 * upload is a toolbar ACTION, not page content.
 */
export default function PurchaseOrders() {
  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        <div className="flex items-center gap-2">
          {/* Toolbar — "Upload to Velocity" lands here (commit 2). */}
        </div>
      </div>
    </div>
  );
}
