-- 083_po_documents.sql — PO documents (patch docs/claude_spec-patch-po-documents.md
-- §4; SPEC §22 "PO documents", §26). One row per PDF kept for a PO in Maria's
-- Drive (Invoices root, D1): an order email AF rendered (source 'email'), a
-- file uploaded on the Documents tab ('upload') or an existing PDF linked by
-- name ('linked_existing' — AF never renames, moves or deletes those files).
-- "Invoice attached" is derived from these rows (Maria 2026-11-04: any row);
-- purchase_orders.invoice_attached (the sheet's Rcpt flag) is history only.
-- created_by: 'system' (the passes, the link script) or the uploading user's id.
-- Idempotence: one document per (gmail_message_id, type); a Drive file is
-- linked to a PO once.
CREATE TABLE po_documents (
  id bigserial PRIMARY KEY,
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('order_confirmation', 'shipped', 'delivered', 'invoice_manual')),
  gmail_message_id text,
  drive_file_id text NOT NULL,
  file_name text NOT NULL,
  bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system',
  source text NOT NULL CHECK (source IN ('email', 'upload', 'linked_existing'))
);
CREATE UNIQUE INDEX po_documents_message_type_key ON po_documents (gmail_message_id, type) WHERE gmail_message_id IS NOT NULL;
CREATE UNIQUE INDEX po_documents_po_file_key ON po_documents (po_id, drive_file_id);
CREATE INDEX po_documents_po_idx ON po_documents (po_id, created_at);

-- An upload or a delete on the Documents tab writes a History row.
ALTER TABLE po_edit_log DROP CONSTRAINT po_edit_log_entity_check;
ALTER TABLE po_edit_log ADD CONSTRAINT po_edit_log_entity_check CHECK (entity IN ('po', 'line', 'asin', 'shipment', 'document'));
