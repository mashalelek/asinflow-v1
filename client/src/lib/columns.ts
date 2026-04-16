import { type ColumnId, ALL_COLUMNS, DEFAULT_COLUMNS } from "@shared/schema";

const COLUMNS_KEY = "fba-column-config";

export interface ColumnConfig {
  order: ColumnId[];
  visible: Set<ColumnId>;
}

export function loadColumnConfig(): ColumnConfig {
  try {
    const stored = localStorage.getItem(COLUMNS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const savedOrder: ColumnId[] = parsed.order as ColumnId[];
      const allKnownIds = new Set(ALL_COLUMNS.map((c) => c.id));
      const savedVisible: Set<ColumnId> = new Set((parsed.visible as ColumnId[]).filter((id: ColumnId) => allKnownIds.has(id)));
      // Remove stale column IDs that no longer exist
      const cleanedOrder = savedOrder.filter((id: ColumnId) => allKnownIds.has(id));
      const savedSet = new Set(cleanedOrder);

      const missingCols = ALL_COLUMNS.filter(
        (c) => allKnownIds.has(c.id) && !savedSet.has(c.id)
      );

      if (missingCols.length > 0) {
        const defaultOrder = [...DEFAULT_COLUMNS];
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
  return getDefaultConfig();
}

export function saveColumnConfig(config: ColumnConfig): void {
  localStorage.setItem(
    COLUMNS_KEY,
    JSON.stringify({
      order: config.order,
      visible: Array.from(config.visible),
    })
  );
}

export function getDefaultConfig(): ColumnConfig {
  return {
    order: [...DEFAULT_COLUMNS],
    visible: new Set(
      ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id)
    ),
  };
}
