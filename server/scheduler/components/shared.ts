// Helpers shared by the component files: chunking with checkpoints, and the
// once-per-job catalog fetch that components 2–6 ride (CALL-2).
import { fetchCatalogBatch, type CatalogBatchEntry } from "../../product-info-batch";
import { ASIN_CHECKPOINT_EVERY, BATCH_CHUNK, type ComponentContext } from "../types";

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Per-ASIN loop with a progress checkpoint every ASIN_CHECKPOINT_EVERY. */
export async function forEachAsin(
  ctx: ComponentContext,
  fn: (asin: string) => Promise<void>,
): Promise<void> {
  let i = 0;
  for (const asin of ctx.asins) {
    await fn(asin);
    i++;
    if (i % ASIN_CHECKPOINT_EVERY === 0 || i === ctx.asins.length) await ctx.checkpoint(asin);
  }
}

/** Batch loop: BATCH_CHUNK ASINs per call group, checkpoint after each. */
export async function forEachBatch(
  ctx: ComponentContext,
  fn: (asins: string[]) => Promise<void>,
  size: number = BATCH_CHUNK,
): Promise<void> {
  for (const part of chunk(ctx.asins, size)) {
    await fn(part);
    await ctx.checkpoint(part[part.length - 1]);
  }
}

const CATALOG_CACHE = "catalog:results";

/**
 * CALL-2 results for the job scope, fetched once per job and shared by
 * components 2–6. Component 2 fetches chunk by chunk with checkpoints; a
 * rider that finds no cache (a job resumed after component 2 completed)
 * refetches the whole scope in one go — correct, just not free.
 */
export async function getCatalogResults(ctx: ComponentContext): Promise<Map<string, CatalogBatchEntry>> {
  const cached = ctx.cache.get(CATALOG_CACHE) as Map<string, CatalogBatchEntry> | undefined;
  if (cached && ctx.scopeAsins.every((a) => cached.has(a))) return cached;
  const out = cached ?? new Map<string, CatalogBatchEntry>();
  const missing = ctx.scopeAsins.filter((a) => !out.has(a));
  ctx.log(`catalog cache ${cached ? "incomplete" : "absent"}: fetching ${missing.length} ASIN(s)`);
  for (const part of chunk(missing, BATCH_CHUNK)) {
    const m = await fetchCatalogBatch(part);
    m.forEach((v, k) => out.set(k, v));
  }
  ctx.cache.set(CATALOG_CACHE, out);
  return out;
}

export function putCatalogResults(ctx: ComponentContext, m: Map<string, CatalogBatchEntry>): void {
  const existing = (ctx.cache.get(CATALOG_CACHE) as Map<string, CatalogBatchEntry> | undefined) ?? new Map();
  m.forEach((v, k) => existing.set(k, v));
  ctx.cache.set(CATALOG_CACHE, existing);
}

export function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
