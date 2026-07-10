// DB read/write for brand_product_registry.
//
// Primitive operations only. The reserve-then-PUT orchestration (including
// commit/rollback semantics) lives in server/offer-add.ts where the PUT
// fires — that's the layer that knows whether to commit or roll back.
//
// Repo is exposed as an interface so tests can inject a mock implementation
// without touching the DB. Production wiring uses makeProductRegistryRepo
// against the real queryFn.

import type { QueryFn } from "@shared/sku-legend";
import type { ProductRegistryRow } from "@shared/product-registry";

export interface ReserveInput {
  brandCode: string;
  nnn: number;
  ttl: string;
  deptCode: string;
  productName: string | null;
  firstAsin: string;
}

export interface ProductRegistryRepo {
  /** All rows for a brand, sorted by NNN ascending. Used by preview to
   *  return the full per-brand registry to the UI for client-side NNN lookup. */
  listForBrand(brandCode: string): Promise<ProductRegistryRow[]>;
  /** Lookup by (brand, nnn). Returns null if absent. */
  getByKey(brandCode: string, nnn: number): Promise<ProductRegistryRow | null>;
  /** Insert a new reservation row. Throws on UNIQUE conflict (concurrent
   *  write to the same (brand, nnn) key) — caller handles the race. */
  reserve(input: ReserveInput): Promise<{ id: string }>;
  /** Delete a reservation by id. Used to roll back when the PUT fails AFTER
   *  reservation was inserted. Idempotent (DELETE on a missing row is a no-op). */
  rollback(id: string): Promise<void>;
}

export function makeProductRegistryRepo(queryFn: QueryFn): ProductRegistryRepo {
  return {
    async listForBrand(brandCode) {
      const r = await queryFn(
        `SELECT id, brand_code, nnn, ttl, dept_code, product_name, first_asin, registered_at
           FROM brand_product_registry
          WHERE brand_code = $1
          ORDER BY nnn`,
        [brandCode],
      );
      return r.rows.map(rowToShape);
    },
    async getByKey(brandCode, nnn) {
      const r = await queryFn(
        `SELECT id, brand_code, nnn, ttl, dept_code, product_name, first_asin, registered_at
           FROM brand_product_registry
          WHERE brand_code = $1 AND nnn = $2`,
        [brandCode, nnn],
      );
      return r.rows[0] ? rowToShape(r.rows[0]) : null;
    },
    async reserve({ brandCode, nnn, ttl, deptCode, productName, firstAsin }) {
      const r = await queryFn(
        `INSERT INTO brand_product_registry
                (brand_code, nnn, ttl, dept_code, product_name, first_asin)
              VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
        [brandCode, nnn, ttl, deptCode, productName, firstAsin],
      );
      return { id: r.rows[0].id };
    },
    async rollback(id) {
      await queryFn(`DELETE FROM brand_product_registry WHERE id = $1`, [id]);
    },
  };
}

function rowToShape(r: any): ProductRegistryRow {
  return {
    brandCode: r.brand_code,
    nnn: r.nnn,
    ttl: r.ttl,
    deptCode: r.dept_code,
    productName: r.product_name,
    firstAsin: r.first_asin,
    registeredAt: r.registered_at,
  };
}
