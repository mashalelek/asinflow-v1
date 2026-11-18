import { type ColumnDef, type ColumnId, ALL_COLUMNS, DEFAULT_COLUMNS } from "@shared/schema";
import type { KeepaRange } from "@shared/keepa";

const COLUMNS_KEY = "fba-column-config";

// All three functions take an optional storage key + column set so the §21
// bulk page can keep its own config ("fba-bulk-column-config" + BULK_COLUMNS)
// without touching the main table's saved state. Defaults resolve to exactly
// the values used before parameterization — main-page call sites pass no
// arguments and are byte-identical in behavior.

// The Stock columns' order (Maria 2026-11-07). A config saved before then
// keeps the old order for these eight; reorderStock puts them in this order
// once, inside the slots they already hold — every other column, visibility
// and width stay as saved. STOCK_ORDER_V marks a config as done.
export const STOCK_ORDER: readonly ColumnId[] = ["stock", "fbaStock", "availableFba", "reserved", "sentToFba", "atPrep", "atWarehouse", "onOrder"];
const STOCK_ORDER_V = 1;

/** Pure: the eight Stock columns in STOCK_ORDER, in the positions they occupy in `order`. */
export function reorderStock(order: ColumnId[]): ColumnId[] {
  const inOrder = new Set(order);
  const queue = STOCK_ORDER.filter((id) => inOrder.has(id));
  const isStock = new Set<ColumnId>(STOCK_ORDER);
  return order.map((id) => (isStock.has(id) ? queue.shift()! : id));
}

/**
 * The Keepa trend columns' per-user settings (docs/claude_spec-patch-keepa-trends.md "Header and columns",
 * 2026-11-18): the Trend range switch and the two header toggles, stored WITH the table's column config (so the
 * Repricer tab and Bulk Calc keep their own, under their keys).
 */
export interface KeepaPrefs { range: KeepaRange; showNew: boolean; showFba: boolean }
export const DEFAULT_KEEPA_PREFS: KeepaPrefs = { range: "1y", showNew: true, showFba: true };
export function readKeepaPrefs(raw: any): KeepaPrefs {
  return {
    range: raw?.range === "all" ? "all" : "1y",
    showNew: raw?.showNew !== false,
    showFba: raw?.showFba !== false,
  };
}

export interface ColumnConfig {
  order: ColumnId[];
  visible: Set<ColumnId>;
  keepa?: KeepaPrefs;
}

export function loadColumnConfig(
  key: string = COLUMNS_KEY,
  columns: ColumnDef[] = ALL_COLUMNS,
): ColumnConfig {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      const config = mergeStoredConfig(parsed, columns);
      config.keepa = readKeepaPrefs(parsed.keepa);
      // One-time Stock reorder (2026-11-07), saved so it runs once per stored config.
      if (parsed.stockOrderV !== STOCK_ORDER_V) {
        config.order = reorderStock(config.order);
        saveColumnConfig(config, key);
      }
      return config;
    }
  } catch {}
  return getDefaultConfig(columns);
}

function mergeStoredConfig(parsed: any, columns: ColumnDef[]): ColumnConfig {
  const savedOrder: ColumnId[] = parsed.order as ColumnId[];
  const allKnownIds = new Set(columns.map((c) => c.id));
  const savedVisible: Set<ColumnId> = new Set((parsed.visible as ColumnId[]).filter((id: ColumnId) => allKnownIds.has(id)));
  // Remove stale column IDs that no longer exist
  const cleanedOrder = savedOrder.filter((id: ColumnId) => allKnownIds.has(id));
  const savedSet = new Set(cleanedOrder);

  const missingCols = columns.filter(
    (c) => allKnownIds.has(c.id) && !savedSet.has(c.id)
  );

  if (missingCols.length > 0) {
    const defaultOrder = DEFAULT_COLUMNS.filter((id) => allKnownIds.has(id as ColumnId));
    const merged = [...cleanedOrder];

    for (const col of missingCols) {
      const defaultIdx = defaultOrder.indexOf(col.id);
      if (defaultIdx === 0) {
        merged.unshift(col.id);
      } else {
        const prevId = defaultOrder[defaultIdx - 1];
        const insertAfter = merged.lastIndexOf(prevId);
        if (insertAfter >= 0) {
          merged.splice(insertAfter + 1, 0, col.id);
        } else {
          merged.push(col.id);
        }
      }
      if (col.defaultVisible) {
        savedVisible.add(col.id);
      }
    }

    return { order: merged, visible: savedVisible };
  }

  return { order: cleanedOrder, visible: savedVisible };
}

export function saveColumnConfig(config: ColumnConfig, key: string = COLUMNS_KEY): void {
  localStorage.setItem(
    key,
    JSON.stringify({
      order: config.order,
      visible: Array.from(config.visible),
      stockOrderV: STOCK_ORDER_V,
      keepa: config.keepa ?? DEFAULT_KEEPA_PREFS,
    })
  );
}

export function getDefaultConfig(columns: ColumnDef[] = ALL_COLUMNS): ColumnConfig {
  return {
    order: DEFAULT_COLUMNS.filter((id) => columns.some((c) => c.id === id)),
    visible: new Set(
      columns.filter((c) => c.defaultVisible).map((c) => c.id)
    ),
    keepa: { ...DEFAULT_KEEPA_PREFS },
  };
}
