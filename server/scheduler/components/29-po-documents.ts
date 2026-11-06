// 29. PO documents (hourly tier: the 00:00 pass and every hourly pass) —
// patch po-documents §5, SPEC §22 "PO documents". Order-confirmation,
// shipped and delivered emails in orders@ matched to one PO are rendered to
// PDF and saved in Maria's Drive (server/po-documents.ts ingestDocuments).
// Every pass then links PDFs Maria saved by hand (D1 linking, the same name
// rules as the backfill; every pass since 2026-11-05 — only the 00:00 pass
// before, so a PDF saved at 13:08 waited 11 hours). Scheduled passes only;
// the manual entry is `npm run po-docs`.
//
// A failure is an error (Maria 2026-11-05): from 2026-11-04 every render
// failed with "Could not find Chrome" and the passes still finished done —
// the failures sat in the ledger's outcomes only. Now a document that was
// not saved, or a Gmail / Drive failure, fails the component with the
// reason (ComponentError keeps the counts). 29 is the last component, so
// nothing after it is skipped; the watermark stays put and the next pass
// retries.
import { gmailClient } from "../../gmail-client";
import { driveClient } from "../../drive-client";
import { ingestDocuments, linkExistingDocuments } from "../../po-documents";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

/** Test seam. */
export const documentsDeps = { gmail: () => gmailClient(), drive: () => driveClient(), ingest: ingestDocuments, link: linkExistingDocuments };

const firstLine = (s: string) => s.split("\n")[0].slice(0, 200);

export const poDocuments: ComponentDef = {
  n: 29, key: "29_po_documents", name: "PO documents", tier: "hourly", kind: "account",
  call: "Gmail API users.messages (orders@, gmail.readonly); Drive API files (Invoices root, as Maria)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    const errors: string[] = [];
    let drive: ReturnType<typeof documentsDeps.drive> | null = null;
    try {
      drive = documentsDeps.drive();
      const r = await documentsDeps.ingest({ query: ctx.query, deps: { gmail: documentsDeps.gmail(), drive }, log: ctx.log });
      Object.assign(counts, { scanned: r.scanned, rechecked: r.rechecked, documents: r.documents, matched: r.matched, unmatched: r.unmatched, ambiguous: r.ambiguous, already: r.already, sheet_era_skipped: r.sheet_era_skipped, written: r.items.length, failed: r.failed });
      for (const i of r.items) outcomes[`${i.supplier} ${i.order_id} ${i.type}`] = i.file_name ?? "";
      for (const f of r.failures) outcomes[`failed ${f.supplier} ${f.order_id} ${f.type} ${f.message_id}`] = f.error;
      if (r.folders_created.length) outcomes._folders_created = r.folders_created.join(", ");
      outcomes._window = `${r.since ?? "start"}..${r.until}`;
      if (r.failed) errors.push(`${r.failed} document${r.failed === 1 ? "" : "s"} not saved (${firstLine(r.failures[0].error)})`);
    } catch (err: any) {
      counts.failed = (counts.failed ?? 0) + 1;
      outcomes._documents = `error: ${err?.message ?? err}`;
      errors.push(`order emails: ${firstLine(String(err?.message ?? err))}`);
    }
    if (drive) {
      try {
        const l = await documentsDeps.link({ query: ctx.query, drive, log: ctx.log });
        Object.assign(counts, { linked_name: l.linked.name, linked_loose: l.linked.loose, link_review: l.review.length, retyped: l.retyped });
      } catch (err: any) {
        outcomes._link = `error: ${err?.message ?? err}`;
        errors.push(`linking: ${firstLine(String(err?.message ?? err))}`);
      }
    }
    if (errors.length) {
      ctx.log(`FAILED: ${errors.join("; ")}`);
      throw new ComponentError(errors.join("; "), { counts, outcomes });
    }
    return { counts, outcomes };
  },
};
