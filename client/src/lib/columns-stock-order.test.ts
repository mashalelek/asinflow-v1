// The Stock columns' order (Maria 2026-11-07): new default, and a saved
// config's eight Stock columns reordered once in place — nothing else moves.
import { describe, it, expect, beforeEach } from "vitest";
import { ALL_COLUMNS, DEFAULT_COLUMNS } from "@shared/schema";
import { STOCK_ORDER, reorderStock, loadColumnConfig, getDefaultConfig } from "./columns";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const OLD_STOCK = ["stock", "availableFba", "onOrder", "atPrep", "atWarehouse", "fbaStock", "reserved", "sentToFba"] as const;

describe("Stock column order", () => {
  beforeEach(() => store.clear());

  it("is the default in ALL_COLUMNS (what the table renders) and DEFAULT_COLUMNS, Days Left after", () => {
    const stockIds = ALL_COLUMNS.filter((c) => c.group === "stock").map((c) => c.id);
    expect(stockIds).toEqual([...STOCK_ORDER, "daysLeft"]);
    expect(DEFAULT_COLUMNS.filter((id) => (STOCK_ORDER as readonly string[]).includes(id))).toEqual([...STOCK_ORDER]);
    expect(getDefaultConfig().order.slice(0, 8)).toEqual(DEFAULT_COLUMNS.slice(0, 8));
  });

  it("reorders only the eight, inside the slots they hold", () => {
    const order = ["product", "stock", "brand", "availableFba", "onOrder", "atPrep", "atWarehouse", "fbaStock", "reserved", "sentToFba", "daysLeft", "tags"] as any;
    expect(reorderStock(order)).toEqual(["product", "stock", "brand", "fbaStock", "availableFba", "reserved", "sentToFba", "atPrep", "atWarehouse", "onOrder", "daysLeft", "tags"]);
  });

  it("a config saved before the change is reordered once and keeps its visibility and other columns", () => {
    const order = [...DEFAULT_COLUMNS.slice(0, 8), ...OLD_STOCK, ...DEFAULT_COLUMNS.slice(16)];
    store.set("fba-column-config", JSON.stringify({ order, visible: ["product", "atPrep", "tags"] }));
    const cfg = loadColumnConfig();
    expect(cfg.order).toEqual([...DEFAULT_COLUMNS]);
    expect(Array.from(cfg.visible).sort()).toEqual(["atPrep", "product", "tags"]);
    const saved = JSON.parse(store.get("fba-column-config")!);
    expect(saved.stockOrderV).toBe(1);
    expect(saved.order).toEqual([...DEFAULT_COLUMNS]);
  });

  it("a config already marked is left alone", () => {
    const order = [...DEFAULT_COLUMNS.slice(0, 8), ...OLD_STOCK, ...DEFAULT_COLUMNS.slice(16)];
    store.set("fba-column-config", JSON.stringify({ order, visible: ["product"], stockOrderV: 1 }));
    expect(loadColumnConfig().order).toEqual(order);
  });
});
