// Tag upsert (extracted from routes.ts 2026-09-09 for the bulk-promote
// write path). Creates missing tags case-insensitively with a random
// palette color; NEVER modifies an existing tag; no-ops when the asins
// row doesn't exist yet — callers must run this AFTER the asins INSERT
// commits.
import { query } from "./db";

export const TAG_COLORS = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16"];

export async function upsertTagsForAsin(asin: string, tagNames: string[]): Promise<void> {
  const asinRow = await query(`SELECT id FROM asins WHERE asin = $1`, [asin]);
  if (asinRow.rows.length === 0) return;
  const asinId = asinRow.rows[0].id;

  for (const name of tagNames) {
    let tagRes = await query(`SELECT id FROM tags WHERE LOWER(name) = LOWER($1)`, [name]);
    if (tagRes.rows.length === 0) {
      tagRes = await query(
        `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id`,
        [name, TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]]
      );
    }
    await query(
      `INSERT INTO asin_tags (asin_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [asinId, tagRes.rows[0].id]
    );
  }
}
