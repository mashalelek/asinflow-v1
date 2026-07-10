// Pure repo tests with mocked queryFn. Real-DB integration is in
// script/diag-product-registry-smoke.ts (BEGIN/ROLLBACK).

import { describe, it, expect } from "vitest";
import { makeProductRegistryRepo } from "./product-registry-repo";

function fakeQuery(handler: (sql: string, params?: any[]) => any) {
  return async (sql: string, params?: any[]) => ({ rows: handler(sql, params) ?? [] });
}

describe("makeProductRegistryRepo", () => {
  it("listForBrand returns rows mapped to camelCase, sorted by NNN", async () => {
    const repo = makeProductRegistryRepo(fakeQuery((sql, params) => {
      expect(sql).toContain("WHERE brand_code = $1");
      expect(sql).toContain("ORDER BY nnn");
      expect(params).toEqual(["AMG"]);
      return [
        { id: "u1", brand_code: "AMG", nnn: 1, ttl: "RRC", dept_code: "BPC", product_name: "Cleanser", first_asin: "B00X", registered_at: new Date("2026-06-28T00:00:00Z") },
      ];
    }));
    const rows = await repo.listForBrand("AMG");
    expect(rows).toHaveLength(1);
    expect(rows[0].brandCode).toBe("AMG");
    expect(rows[0].nnn).toBe(1);
    expect(rows[0].ttl).toBe("RRC");
    expect(rows[0].deptCode).toBe("BPC");
    expect(rows[0].productName).toBe("Cleanser");
  });

  it("getByKey returns null when no row exists", async () => {
    const repo = makeProductRegistryRepo(fakeQuery(() => []));
    const row = await repo.getByKey("AMG", 999);
    expect(row).toBeNull();
  });

  it("getByKey returns the row when present", async () => {
    const repo = makeProductRegistryRepo(fakeQuery((sql, params) => {
      expect(params).toEqual(["AMG", 1]);
      return [{ id: "u1", brand_code: "AMG", nnn: 1, ttl: "RRC", dept_code: "BPC", product_name: null, first_asin: null, registered_at: new Date() }];
    }));
    const row = await repo.getByKey("AMG", 1);
    expect(row).not.toBeNull();
    expect(row!.ttl).toBe("RRC");
  });

  it("reserve INSERTs and returns the new id", async () => {
    const repo = makeProductRegistryRepo(fakeQuery((sql, params) => {
      expect(sql).toContain("INSERT INTO brand_product_registry");
      expect(sql).toContain("RETURNING id");
      expect(params).toEqual(["AMG", 5, "XYZ", "BPC", "Some Product", "B00ABC"]);
      return [{ id: "new-uuid-here" }];
    }));
    const { id } = await repo.reserve({
      brandCode: "AMG", nnn: 5, ttl: "XYZ", deptCode: "BPC",
      productName: "Some Product", firstAsin: "B00ABC",
    });
    expect(id).toBe("new-uuid-here");
  });

  it("reserve propagates UNIQUE conflict as a throw (caller handles race)", async () => {
    const repo = makeProductRegistryRepo(async () => {
      const err: any = new Error("duplicate key value violates unique constraint \"brand_product_registry_brand_code_nnn_key\"");
      err.code = "23505";
      throw err;
    });
    await expect(repo.reserve({
      brandCode: "AMG", nnn: 1, ttl: "RRC", deptCode: "BPC",
      productName: null, firstAsin: "B00ABC",
    })).rejects.toThrow(/duplicate key/);
  });

  it("rollback issues DELETE WHERE id and is idempotent (no-op on missing row)", async () => {
    let deleteCalls = 0;
    const repo = makeProductRegistryRepo(fakeQuery((sql, params) => {
      deleteCalls++;
      expect(sql).toContain("DELETE FROM brand_product_registry");
      expect(params).toEqual(["abc"]);
      return [];
    }));
    await repo.rollback("abc");
    await repo.rollback("abc"); // call twice — DELETE on missing row is a no-op, no throw
    expect(deleteCalls).toBe(2);
  });
});
