// 29. PO documents (hourly tier: the 00:00 pass and every hourly pass) —
// patch po-documents §5, SPEC §22 "PO documents". Order-confirmation,
// shipped and delivered emails in orders@ matched to one PO are rendered to
// PDF and saved in Maria's Drive (server/po-documents.ts ingestDocuments).
// The 00:00 pass also links PDFs Maria saved by hand (D1 linking, the same
// name rules as the backfill). Scheduled passes only; the manual entry is
// `npm run po-docs`. A Gmail / Drive failure is recorded, not thrown.
import { gmailClient } from "../../gmail-client";
import { driveClient } from "../../drive-client";
import { ingestDocuments, linkExistingDocuments } from "../../po-documents";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const documentsDeps = { gmail: () => gmailClient(), drive: () => driveClient() };

export const poDocuments: ComponentDef = {
  n: 29, key: "29_po_documents", name: "PO documents", tier: "hourly", kind: "account",
  call: "Gmail API users.messages (orders@, gmail.readonly); Drive API files (Invoices root, as Maria)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    try {
      const drive = documentsDeps.drive();
      const r = await ingestDocuments({ query: ctx.query, deps: { gmail: documentsDeps.gmail(), drive }, log: ctx.log });
      Object.assign(counts, { scanned: r.scanned, documents: r.documents, matched: r.matched, unmatched: r.unmatched, ambiguous: r.ambiguous, already: r.already, sheet_era_skipped: r.sheet_era_skipped, written: r.items.length, failed: r.failed });
      for (const i of r.items) outcomes[`${i.supplier} ${i.order_id} ${i.type}`] = i.file_name ?? "";
      for (const f of r.failures) outcomes[`failed ${f.message_id}`] = f.error;
      if (r.folders_created.length) outcomes._folders_created = r.folders_created.join(", ");
      outcomes._window = `${r.since ?? "start"}..${r.until}`;
      if (ctx.job.include_daily) {
        const l = await linkExistingDocuments({ query: ctx.query, drive, log: ctx.log });
        Object.assign(counts, { linked_name: l.linked.name, linked_loose: l.linked.loose, link_review: l.review.length });
      }
    } catch (err: any) {
      counts.failed = (counts.failed ?? 0) + 1;
      outcomes._documents = `error: ${err?.message ?? err}`;
      ctx.log(outcomes._documents);
    }
    return { counts, outcomes };
  },
};
