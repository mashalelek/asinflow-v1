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
      return {
        order: parsed.order as ColumnId[],
        visible: new Set(parsed.visible as ColumnId[]),
      };
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
