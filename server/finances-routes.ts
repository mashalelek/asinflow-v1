// Finances API routes (patch commit 7 / 8, SPEC §6): the breakdown of §1 for a
// Pacific-day range — the account (the Dashboard's More panel) or one ASIN
// (the ASIN panel) — and the per-ASIN Actuals every table reads through ONE
// accessor. Behind the session like every /api route.
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import { parseYmd } from "./dashboard-range";
import { readAsinActuals, readBreakdown } from "./finances-aggregate";
import { isValidAsin } from "@shared/asin";
import type { QueryLike } from "./scheduler/types";

export function createFinancesRouter(deps: { query?: QueryLike } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();

  router.get("/api/finances/breakdown", async (req: Request, res: Response) => {
    const from = parseYmd(req.query.from), to = parseYmd(req.query.to);
    if (!from || !to || from > to) { res.status(400).json({ message: "from and to must be YYYY-MM-DD, from ≤ to" }); return; }
    const asinRaw = typeof req.query.asin === "string" ? req.query.asin.toUpperCase() : "";
    if (asinRaw && !isValidAsin(asinRaw)) { res.status(400).json({ message: "asin must be a 10-character ASIN" }); return; }
    try { res.json(await readBreakdown(from, to, asinRaw || null, query as any)); }
    catch (err: any) { res.status(500).json({ message: err?.message ?? String(err) }); }
  });

  router.get("/api/finances/asin-actuals", async (req: Request, res: Response) => {
    const from = parseYmd(req.query.from), to = parseYmd(req.query.to);
    if (!from || !to || from > to) { res.status(400).json({ message: "from and to must be YYYY-MM-DD, from ≤ to" }); return; }
    const asins = typeof req.query.asins === "string" && req.query.asins ? req.query.asins.split(",").map((a) => a.trim().toUpperCase()).filter(isValidAsin) : null;
    try {
      const m = await readAsinActuals(from, to, asins, query as any);
      res.json({ from, to, asins: Object.fromEntries(m) });
    } catch (err: any) { res.status(500).json({ message: err?.message ?? String(err) }); }
  });

  return router;
}
