# SPEC Patch — PO documents: save order emails as PDFs in Drive, download from the paperclip

*Drafted 2026-11-04 with Maria. Amends §22 (PO module), §26 (email ingestion).*

> **Status: APPROVED 2026-11-04. Implemented 2026-11-04 (SPEC §22 "PO
> documents", §26 "PO documents ingest"; probe decisions: Maria
> 2026-11-04 — Chromium on Render confirmed; matching = the §2 name case-
> and space-insensitive plus the looser date + order # rule, exactly one
> candidate; the whole root searched; Receipts_YYYY-MM month folders used
> as they are; "Invoice attached" derived from po_documents only).**

## 1. Why

Order confirmations are the invoice for most suppliers, and they already
arrive in orders@ (everything is forwarded there). Today nothing is saved:
the PO Details page shows "Invoice attached: No", and the POs-table
paperclip only mirrors the sheet's old Rcpt checkbox, with no file behind it.

## 2. Decisions already made

- Storage is Maria's Google Drive, through the same `asinflow-sheets` service
  account with domain-wide delegation, writing as Maria. Render disk is
  ephemeral, so nothing is stored locally (2026-10-22).
- File name follows the Orders sheet's Col AU rule:
  `YYYY-MM-DD_supplier_POID.pdf`. The date is the PO order date and the
  supplier is AF's supplier name. Shipped and delivered emails append
  `_shipped` / `_delivered`. A second document of the same type gets `-2`,
  `-3` (2026-10-29).
- Several documents per PO.
- The paperclip on the POs table downloads the PDF. With several documents
  it shows a small menu. With none, it opens the PO's Documents tab
  (2026-11-04).

## 3. Decisions (Maria 2026-11-04)

- **D1 — Existing invoices live in Drive.** Root folder:
  https://drive.google.com/drive/folders/1oBeUBKnmpjfcxcwD_w-hCAPLCd-Bbm13
  Layout: `My Drive / Invoices / Invoices - 2026 / Invoices 2026-MM /`.
  The folders were created by Maria, not by AF. For POs already in AF, AF
  **links** existing PDFs by the §2 file name (`source = linked_existing`)
  and never re-renders, renames or moves them. A PO with no file found
  stays "no document".
- **D2 — Same layout for new files.** AF writes to
  `Invoices / Invoices - YYYY / Invoices YYYY-MM /` by PO order date and
  **creates missing year and month folders itself** (matching names
  exactly, e.g. `Invoices - 2027`, `Invoices 2027-01`). It never creates a
  folder if one with that exact name already exists under the parent.
- **D3 — Manual upload name:** `_invoice` appended. Approved.
- **D4 — Render backfill only for POs created in AF** (source = extension /
  form / email_renewal) that have a matched confirmation email in orders@.
  Sheet-era POs get only D1 linking.

## 4. Data

`po_documents`: `id, po_id, type (order_confirmation | shipped | delivered |
invoice_manual), gmail_message_id (nullable), drive_file_id, file_name,
bytes, created_at, created_by (system | user id), source (email | upload |
linked_existing)`. The PO-level `rcpt` flag from the sheet is read-only
history; "Invoice attached" becomes derived: a `po_documents` row of type
order_confirmation or invoice_manual exists.

## 5. Ingest

- The tracking / reconcile pass already matches order-confirmation,
  shipped and delivered emails to POs. On a match with no document of that
  type for that message yet, render the email to PDF and upload it to
  Drive under the §2 name, then write the `po_documents` row. This runs
  in the 00:00 pass and on the hourly reconcile.
- Rendering: email HTML → PDF with headless Chromium on Render. **Probe
  first** that Chromium runs in the Render image (memory, fonts, inline
  images); if not, say so and propose the alternative before building.
- Remote images in the email: fetched at render time; a failed image
  renders as blank, never blocks the PDF.
- Idempotent: one document per (gmail_message_id, type). Re-running never
  creates duplicates or renames existing files.

## 6. UI

- **POs table paperclip:** filled icon = at least one document; click
  downloads it (one document) or opens a menu listing each by type and
  date (several). Outline icon = none; click opens the Documents tab.
- **PO detail page — Documents tab:** list of documents (type, file name,
  date, source) with Download and Open in Drive; "Upload invoice" accepts
  a PDF or image (converted to PDF), named per D3; delete with confirm
  (removes the Drive file too).
- **PO Details card:** "Invoice attached" reads Yes / No from the derived
  rule; the Invoice File Name line stays.
- Downloads stream through AF (the browser never needs Drive access).

## 7. Setup step for Maria

Because the folders were created by Maria, the scope must be full Drive:
`https://www.googleapis.com/auth/drive`, added next to the existing Gmail
scope on the `asinflow-sheets` client in Admin console → Security →
Access and data control → API controls → Manage Domain Wide Delegation.
Google Drive API enabled in Cloud project amazon-fba-463600. AF only ever
touches files under the Invoices root from D1.

## 8. Commits

0. Probe: Chromium on Render; Drive scope works as Maria; D1 root
   readable and its year/month folders listed; how many sheet-era POs
   find an existing PDF by name (by month); count of AF-created POs with a
   matched confirmation email. Report, stop.
1. `po_documents` migration + Drive client + naming function (tests on the
   AU examples).
2. Linking existing PDFs (D1) + renderer + ingest in the passes,
   idempotent, with auto-created year/month folders (D2); dry run on
   production (counts only), then live.
3. UI: paperclip, Documents tab, upload, derived Invoice attached.
4. SPEC §22/§26, CLAUDE.md, backlog.
