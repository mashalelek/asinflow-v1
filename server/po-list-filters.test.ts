import { describe, it, expect } from "vitest";
import { parsePoListFilters, poListWhere, poFacetCounts } from "./po-list-filters";
import { DISPLAY_ACTION_ITEMS, REPLACEMENT_TRACKING_ITEM } from "./po-status-map";

const placeholders = (sql: string) => Array.from(new Set(Array.from(sql.matchAll(/\$(\d+)/g)).map((m) => Number(m[1])))).sort((a, b) => a - b);

describe("POs list filters (2026-11-06)", () => {
  const f = parsePoListFilters({ search: "caress", action: "SHIP,Pack Size Missing", supplier: "walmart.com,target.com", from: "2026-01-01", closed: "all", refunds: "due" });
  it("parses the query: legacy action labels mapped, Status defaults to Open", () => {
    expect(parsePoListFilters({}).closed).toBe("open");
    expect(f.supplier).toEqual(["walmart.com", "target.com"]);
  });
  it("the WHERE uses every placeholder it passes, in order; leaving a facet out drops exactly its condition", () => {
    const all = poListWhere(f);
    expect(placeholders(all.where)).toEqual(all.params.map((_, i) => i + 1));
    const noSup = poListWhere(f, "supplier");
    expect(noSup.where).not.toMatch(/p\.supplier = ANY/);
    expect(noSup.where).toMatch(/p\.order_id ILIKE/);
    expect(poListWhere(f, "closed").where).toBe(all.where); // closed=all adds no condition
    expect(poListWhere({ ...f, closed: "open" }, "closed").where).not.toMatch(/closed_at IS NULL/);
  });
  it("the replacement pair's item is a real condition (until 2026-11-06 the filter ignored it and listed every PO)", () => {
    expect(poListWhere({ ...parsePoListFilters({}), action: [REPLACEMENT_TRACKING_ITEM] }).where).toMatch(/p\.order_id = '200015663718988'/);
  });
  it("counts: four queries, each without its own facet; every display Action Item counted; placeholders consistent", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const q = async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      if (/GROUP BY p\.supplier/.test(sql)) return { rows: [{ supplier: "walmart.com", n: 5 }] };
      if (/AS a0/.test(sql)) return { rows: [Object.fromEntries(DISPLAY_ACTION_ITEMS.map((_, i) => [`a${i}`, i]))] };
      if (/AS due/.test(sql)) return { rows: [{ any: 9, due: 2, none: 7 }] };
      return { rows: [{ open: 3, closed: 6, all: 9 }] };
    };
    const c = await poFacetCounts(q as any, f);
    expect(seen).toHaveLength(4);
    for (const s of seen) expect(placeholders(s.sql)).toEqual(s.params.map((_, i) => i + 1));
    expect(seen.find((s) => /GROUP BY p\.supplier/.test(s.sql))!.sql).not.toMatch(/p\.supplier = ANY/);
    expect(seen.find((s) => /AS a0/.test(s.sql))!.sql.split("FROM purchase_orders p")[1]).not.toMatch(/ai\.item =/); // the Action Items facet left out of its own WHERE
    expect(c).toMatchObject({ closed: { open: 3, closed: 6, all: 9 }, refunds: { any: 9, due: 2, none: 7 }, suppliers: { "walmart.com": 5 } });
    expect(Object.keys(c.actionItems)).toEqual([...DISPLAY_ACTION_ITEMS]);
  });
});
