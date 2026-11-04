-- 084_po_documents_invoice_type.sql — a supplier's own invoice email is a
-- document type (Maria 2026-11-04: "[ShagTools] Invoice 4126643 for order
-- 4126643" is a real invoice; SPEC §22 "PO documents", §26). 'invoice' is the
-- emailed one, 'invoice_manual' the Documents-tab upload; both file as
-- `_invoice`. po_prefill_log gains 'doc_classify': the AI fallback that types
-- an order email no subject rule names (one call per email, capped per pass).
ALTER TABLE po_documents DROP CONSTRAINT po_documents_type_check;
ALTER TABLE po_documents ADD CONSTRAINT po_documents_type_check
  CHECK (type IN ('order_confirmation', 'invoice', 'shipped', 'delivered', 'invoice_manual'));
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify'));
