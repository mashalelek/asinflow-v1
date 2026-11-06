// A new PO reads the order emails that arrived before it (2026-11-06,
// server/gmail-recheck.ts): right after POST /api/pos, the stored unmatched
// order emails and confirmations are matched against it — its confirmation
// is saved as a document and compared, without waiting for the next pass.
// Runs in the background; a failure is logged and the next pass retries
// (the emails stay on the list). Only where the passes run
// (ENABLE_CRONS=true): a local dev server never writes to Maria's Drive.
import type { QueryLike } from "./scheduler/types";
import { gmailClient } from "./gmail-client";
import { driveClient } from "./drive-client";
import { ingestDocuments } from "./po-documents";
import { reconcileConfirmations } from "./po-confirm-reconcile";

/** Test seam. */
export const recheckDeps = { gmail: () => gmailClient(), drive: () => driveClient(), ingest: ingestDocuments, reconcile: reconcileConfirmations, enabled: () => process.env.ENABLE_CRONS === "true" };

export async function recheckForNewPo(query: QueryLike, poId: string, log: (m: string) => void): Promise<{ documents: number; confirmations: number } | null> {
  if (!recheckDeps.enabled()) return null;
  const out = { documents: 0, confirmations: 0 };
  try {
    const gmail = recheckDeps.gmail();
    const d = await recheckDeps.ingest({ query, deps: { gmail, drive: recheckDeps.drive() }, onlyStored: true, onlyPoId: poId });
    out.documents = d.items.length;
    const c = await recheckDeps.reconcile({ query, deps: { gmail }, onlyStored: true, onlyPoId: poId });
    out.confirmations = c.matched;
    log(`new PO ${poId}: ${out.documents} document(s) saved, ${out.confirmations} confirmation(s) matched from earlier emails (${d.rechecked} rechecked)`);
  } catch (err: any) {
    log(`new PO ${poId}: recheck of earlier emails failed — the next pass retries (${err?.message ?? err})`);
  }
  return out;
}
