// GET /api/ai-spend — the monthly AI spend for Settings (shared/ai-spend.ts). Read-only. A request-log row
// (migration 092: a cache hit, a rejection) has cost 0 and no tokens, so it adds nothing and is not a call.
import { Router, type Request, type Response } from "express";
import type { QueryLike } from "./scheduler/types";
import { AI } from "./config/ai";
import { shapeAiSpend } from "@shared/ai-spend";

export const AI_SPEND_SQL = `SELECT to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM') AS month, kind,
    count(*) FILTER (WHERE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0)::int AS calls,
    COALESCE(sum(cost_estimate), 0)::float AS cost
  FROM po_prefill_log WHERE created_at >= date_trunc('month', (now() AT TIME ZONE 'America/New_York') - interval '5 months') AT TIME ZONE 'America/New_York'
  GROUP BY 1, 2`;

export function createAiSpendRouter(query: QueryLike): Router {
  const router = Router();
  router.get("/api/ai-spend", async (_req: Request, res: Response) => {
    try { res.json(shapeAiSpend((await query(AI_SPEND_SQL)).rows, AI.monthlyWarnUsd)); } catch (err: any) { res.status(500).json({ message: err?.message ?? String(err) }); }
  });
  return router;
}
