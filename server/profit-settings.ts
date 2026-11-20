// Settings rows → the typed Settings calculateProfit takes. Pure (no pool), so
// the offer-add loaders and the Capture PO history's "This PO" profit
// (server/extension-history.ts) read the same keys the same way. Since the
// Finances API patch (commit 1) the key map lives in shared/settings-keys.ts
// and the same reader serves GET /api/settings/profit.
export { settingsFromRows } from "@shared/settings-keys";
