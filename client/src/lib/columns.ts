import { type ColumnDef, type ColumnId, ALL_COLUMNS, DEFAULT_COLUMNS } from "@shared/schema";

const COLUMNS_KEY = "fba-column-config";

// All three functions take an optional storage key + column set so the §21
// bulk page can keep its own config ("fba-bulk-column-config" + BULK_COLUMNS)
// without touching the main table's saved state. Defaults resolve to exactly
// the values used before parameterization — main-page call sites pass no
// arguments and are byte-identical in behavior.

export interface ColumnConfig {
  order: ColumnId[];
  visible: Set<ColumnId>;
}

export function loadColumnConfig(
  key: string = COLUMNS_KEY,
  columns: ColumnDef[] = ALL_COLUMNS,
): ColumnConfig {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
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
  } catch {}
  return getDefaultConfig(columns);
}

export function saveColumnConfig(config: ColumnConfig, key: string = COLUMNS_KEY): void {
  localStorage.setItem(
    key,
    JSON.stringify({
      order: config.order,
      visible: Array.from(config.visible),
    })
  );
}

export function getDefaultConfig(columns: ColumnDef[] = ALL_COLUMNS): ColumnConfig {
  return {
    order: DEFAULT_COLUMNS.filter((id) => columns.some((c) => c.id === id)),
    visible: new Set(
      columns.filter((c) => c.defaultVisible).map((c) => c.id)
    ),
  };
}
