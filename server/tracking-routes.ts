// PO tracking routes (SPEC §26; patch po-tracking-velocity §5, §6, §11).
// Mounted behind requireAuth.
//   POST /api/tracking/sync             {dryRun}  "Sync tracking": ingest (Gmail) → match → push (Velocity)
//   GET  /api/tracking/unmatched        the queue: unmatched rows (not dismissed) with reason
//   POST /api/tracking/domain-map       {domain, supplier}  map a sender domain once, then re-match
//   POST /api/tracking/:id/attach       {po_id}  attach to a PO by hand (source manual — the sync never moves it)
//   POST /api/tracking/:id/dismiss      take a row out of the queue
//   POST /api/pos/:id/review-velocity/clear   manual clear of "Review Velocity": suppresses the PO's
//                                       tracking rows that exist NOW; a later row may raise it again (§8)
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import { matchTrackingRows, setDomainMapEntry } from "./tracking-match";
import { ingestTracking } from "./tracking-ingest";
import { pushTracking } from "./tracking-push";
import { gmailClient } from "./gmail-client";
import type { QueryLike } from "./scheduler/types";

export function createTrackingRouter(deps: { query?: QueryLike } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();
  const fail = (res: Response, err: any) => res.status(500).json({ error: "tracking_failed", message: err?.message ?? String(err) });

  // "Sync tracking" (POs toolbar): the same three steps as the 00:00
  // components po_tracking_ingest → po_tracking_push. dryRun: reads Gmail
  // and Velocity, writes nothing anywhere; the push plan is per PO (target
  // orders, numbers to add, numbers already present).
  router.post("/api/tracking/sync", async (req: Request, res: Response) => {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    try {
      const ingest = await ingestTracking({ query, deps: { gmail: gmailClient() }, dryRun });
      const match = await matchTrackingRows(query, { dryRun });
      const push = await pushTracking({ query, dryRun });
      if (dryRun && ingest.drafts) ingest.drafts = ingest.drafts.slice(0, 200);
      res.json({ dryRun, ingest, match, push });
    } catch (err) { fail(res, err); }
  });

  router.get("/api/tracking/unmatched", async (_req: Request, res: Response) => {
    try {
      const rows = (await query(
        `SELECT id, carrier, tracking_number, retailer_order_id, sender_domain, supplier_guess, ship_to_street, shipped_at,
                email_subject, source, match_reason, created_at
           FROM po_tracking
          WHERE status = 'unmatched' AND COALESCE(match_reason, '') <> 'dismissed'
          ORDER BY shipped_at DESC NULLS LAST, id DESC LIMIT 1000`,
      )).rows;
      res.json({ rows, count: rows.length });
    } catch (err) { fail(res, err); }
  });

  router.post("/api/tracking/domain-map", async (req: Request, res: Response) => {
    const domain = String(req.body?.domain ?? "").trim().toLowerCase();
    const supplier = req.body?.supplier == null ? null : String(req.body.supplier).trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { res.status(400).json({ error: "invalid_domain" }); return; }
    if (supplier !== null && !supplier) { res.status(400).json({ error: "invalid_supplier" }); return; }
    try {
      if (supplier) {
        const known = (await query(`SELECT 1 FROM purchase_orders WHERE supplier = $1 LIMIT 1`, [supplier])).rows.length > 0;
        if (!known) { res.status(400).json({ error: "unknown_supplier", message: `no PO has supplier ${supplier}` }); return; }
      }
      await setDomainMapEntry(query, domain, supplier);
      // Re-open this domain's unknown_sender rows for matching.
      await query(`UPDATE po_tracking SET match_reason = NULL WHERE status = 'unmatched' AND sender_domain = $1 AND match_reason = 'unknown_sender'`, [domain]);
      res.json({ ok: true, rematch: await matchTrackingRows(query) });
    } catch (err) { fail(res, err); }
  });

  router.post("/api/tracking/:id/attach", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const poId = String(req.body?.po_id ?? "");
    if (!Number.isInteger(id) || id <= 0 || !/^[0-9a-f-]{36}$/i.test(poId)) { res.status(400).json({ error: "invalid_input" }); return; }
    try {
      const po = (await query(`SELECT id, supplier FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
      if (!po) { res.status(404).json({ error: "po_not_found" }); return; }
      const r = await query(
        `UPDATE po_tracking SET po_id = $2, supplier_guess = $3, status = 'matched', match_reason = NULL, source = 'manual', updated_at = NOW()
          WHERE id = $1 AND tracking_number NOT LIKE 'email:%' RETURNING id`,
        [id, poId, po.supplier],
      );
      if (r.rows.length === 0) { res.status(404).json({ error: "row_not_found_or_placeholder" }); return; }
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  router.post("/api/tracking/:id/dismiss", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
    try {
      const r = await query(`UPDATE po_tracking SET match_reason = 'dismissed', updated_at = NOW() WHERE id = $1 AND status = 'unmatched' RETURNING id`, [id]);
      if (r.rows.length === 0) { res.status(404).json({ error: "not_found" }); return; }
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  router.post("/api/pos/:id/review-velocity/clear", async (req: Request, res: Response) => {
    const poId = String(req.params.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(poId)) { res.status(400).json({ error: "invalid_id" }); return; }
    try {
      const r = await query(
        `UPDATE po_tracking SET suppressed_at = NOW(), updated_at = NOW()
          WHERE po_id = $1 AND review_reason IS NOT NULL AND suppressed_at IS NULL RETURNING id`,
        [poId],
      );
      res.json({ ok: true, suppressed: r.rows.length });
    } catch (err) { fail(res, err); }
  });

  return router;
}
