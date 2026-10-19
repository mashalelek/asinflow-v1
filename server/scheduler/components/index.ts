// The single ordered component list every job follows (SPEC §11 "Refresh
// job", component table). Numbers match docs/af_data_components.csv.
// Dependencies the order encodes: 9 before 15 (inventory copies
// ordered_qty); 10 before 13 (fees need the fresh price); 15 before 16
// (listings need the SKU set); 19–21 last. 1 runs first in every pass.
// Listing hygiene appends 22 close (needs this pass's 15 + 16), 23 ledger and
// 24 delete (needs 15, 16 and tonight's 23) — scheduled passes only.
import { scDiscovery } from "./01-sc-discovery";
import { catalog } from "./02-catalog";
import { catalogDeleted } from "./03-catalog-deleted";
import { bsr } from "./04-bsr";
import { meltable } from "./05-meltable";
import { dangerousGood } from "./06-dangerous-good";
import { hazmat } from "./07-hazmat";
import { gating } from "./08-gating";
import { poSheet } from "./09-po-sheet";
import { prices } from "./10-prices";
import { sellers } from "./11-sellers";
import { cpt } from "./12-cpt";
import { fees } from "./13-fees";
import { profit } from "./14-profit";
import { inventory } from "./15-inventory";
import { liveOffer } from "./16-live-offer";
import { primarySku } from "./17-primary-sku";
import { suppressions } from "./18-suppressions";
import { sales } from "./19-sales";
import { refunds } from "./20-refunds";
import { actualFees } from "./21-actual-fees";
import { closeOos } from "./22-close-oos";
import { ledger } from "./23-ledger";
import { deleteDead } from "./24-delete-dead";
import type { ComponentDef } from "../types";

export const COMPONENTS: readonly ComponentDef[] = Object.freeze([
  scDiscovery, catalog, catalogDeleted, bsr, meltable, dangerousGood, hazmat, gating,
  poSheet, prices, sellers, cpt, fees, profit, inventory, liveOffer, primarySku,
  suppressions, sales, refunds, actualFees,
  closeOos, ledger, deleteDead,
]);

// The order is a fact, not a convention: fail loudly at import if it drifts.
// Strictly increasing component numbers (listing hygiene 22–24 land one at a
// time, 2026-10-19).
COMPONENTS.forEach((c, i) => {
  if (i > 0 && c.n <= COMPONENTS[i - 1].n) throw new Error(`component order broken: index ${i} holds #${c.n} (${c.key}) after #${COMPONENTS[i - 1].n}`);
});
