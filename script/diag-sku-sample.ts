// Read-only diagnostic. No DB writes. No code changes to sync paths.
//
// Three sections:
//   1. Top distinct brands → proposed BRD codes (algorithmic first-3-letters)
//   2. Top distinct categories → proposed DEP/SUB codes (same algorithm)
//   3. 20 random ASINs → derived TTL for sanity check
//
// The BRD/DEP/SUB proposals are starter values for the user to review and
// curate into a persistent legend. The TTL column is what the canonical
// generator will produce — that algorithm IS what we'd ship.

import "dotenv/config";
import { query } from "../server/db";
import { deriveTtl } from "../shared/sku-generator";

function propose3Code(raw: string): string {
  const stopwords = new Set(["the", "and", "of", "for", "with", "a", "an"]);
  const first = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !stopwords.has(w))[0];
  return (first ?? "XXX").toUpperCase().padEnd(3, "X").slice(0, 3);
}

(async () => {
  const brands = await query(`
    SELECT brand, COUNT(*) AS n
    FROM asins
    WHERE brand IS NOT NULL AND brand <> ''
    GROUP BY brand
    ORDER BY n DESC
    LIMIT 25
  `);
  console.log("=== Brand legend candidates (top 25 by ASIN count) ===");
  console.log("ASINs  | BRD | brand");
  for (const r of brands.rows) {
    console.log(`${String(r.n).padStart(5)}  | ${propose3Code(r.brand)} | ${r.brand}`);
  }

  const cats = await query(`
    SELECT category, COUNT(*) AS n
    FROM asins
    WHERE category IS NOT NULL AND category <> ''
    GROUP BY category
    ORDER BY n DESC
    LIMIT 25
  `);
  console.log("\n=== Department/sub-category legend candidates (top 25) ===");
  console.log("ASINs  | code | category");
  for (const r of cats.rows) {
    console.log(`${String(r.n).padStart(5)}  | ${propose3Code(r.category)} | ${r.category}`);
  }

  const sample = await query(`
    SELECT asin, brand, category, title
    FROM asins
    WHERE title IS NOT NULL AND brand IS NOT NULL
    ORDER BY random()
    LIMIT 20
  `);
  console.log("\n=== TTL sample (20 random ASINs) ===");
  console.log("ASIN        | TTL | brand                    | title");
  for (const r of sample.rows) {
    const ttl = deriveTtl(r.title, r.brand);
    console.log(
      `${r.asin}  | ${ttl} | ${(r.brand ?? "").padEnd(24).slice(0, 24)} | ${(r.title ?? "").slice(0, 80)}`,
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error("Diag failed:", err.message);
  process.exit(1);
});
