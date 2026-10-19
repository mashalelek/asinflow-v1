// 22. Close OOS listings (hourly) — listing hygiene, SPEC §11. CALL-12
// patchListingsItem per SKU (op "merge" on /attributes/purchasable_offer,
// end_at = the born-closed date through the shared helper).
//
// A SKU whose listing exists and is not closed is closed when Available,
// Inbound (working + shipped + receiving), FC Transfer, FC Processing,
// Reserved (customer orders) and future supply are all zero. Unfulfillable
// and Researching do not block; stages before FBA (On Order, At Prep, POs,
// Velocity) are never read. Needs this pass's 15 (complete) and 16.
// Scheduled passes only, plus its own entry points (run / release).
// LISTING_CLOSE_LIVE unset → dry run. AF never reopens.
import { runHygiene } from "../../listing-hygiene-run";
import type { ComponentDef } from "../types";

export const closeOos: ComponentDef = {
  n: 22, key: "22_close_oos", name: "Close OOS listings", tier: "hourly", kind: "account",
  call: "CALL-12 patchListingsItem, per SKU",
  run: (ctx) => runHygiene("close", ctx),
};
