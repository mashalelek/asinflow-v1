// Capture page samples (Maria 2026-11-05; migration 092; SPEC §11 "Chrome
// extension — Capture PO", v1.4): a captured page whose Products or Totals
// stayed empty after every layer is kept server-side — its scrubbed text and
// fields, 30 days — so it can become a test fixture without Maria pasting
// it. Admin-only. `npm run capture:samples [-- --prod] [--save <id>]` lists
// them and writes one under server/__fixtures__/capture-pages/samples/.
import { Router, type Request, type Response } from "express";
import type { QueryLike } from "./scheduler/types";
import { requireRole } from "./auth";

export const SAMPLE_LIST_SQL = `SELECT id, created_at, retailer, step, url, title, missing, layers, length(text) AS chars, jsonb_array_length(fields) AS field_count
  FROM capture_page_samples WHERE created_at >= now() - interval '30 days' ORDER BY created_at DESC LIMIT 200`;

/** One sample in the "Copy page text" layout (buckets.js debugText) — what a fixture file holds. */
export function sampleAsFixture(s: { retailer: string; step: string | null; url: string | null; title: string | null; created_at: Date | string; text: string; fields: Array<{ label: string; value: string }> }): string {
  const f = Array.isArray(s.fields) ? s.fields : [];
  const at = s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at);
  return [`AsinFlow capture · ${s.retailer} · 1 page · kept by the server ${at} · card numbers were masked in the page`, "",
    `=== page 1 · step ${s.step ?? "other"} · ${s.url ?? ""} · ${String(s.title ?? "").replace(/\s+/g, " ")} · captured ${at} · ${s.text.length} chars ===`,
    s.text, `--- fields (${f.length}) ---`, ...f.map((x) => JSON.stringify(x))].join("\n");
}

export function createCaptureSamplesRouter(query: QueryLike): Router {
  const router = Router();
  router.use("/api/admin/capture-samples", requireRole("admin"));
  router.get("/api/admin/capture-samples", async (_req: Request, res: Response) => {
    try { res.json({ samples: (await query(SAMPLE_LIST_SQL)).rows }); } catch (err: any) { res.status(500).json({ message: err?.message ?? String(err) }); }
  });
  router.get("/api/admin/capture-samples/:id", async (req: Request, res: Response) => {
    try {
      const s = (await query(`SELECT * FROM capture_page_samples WHERE id = $1 AND created_at >= now() - interval '30 days'`, [Number(req.params.id) || 0])).rows[0];
      if (!s) { res.status(404).json({ message: "no such sample (kept 30 days)" }); return; }
      res.type("text/plain").send(sampleAsFixture(s));
    } catch (err: any) { res.status(500).json({ message: err?.message ?? String(err) }); }
  });
  return router;
}
