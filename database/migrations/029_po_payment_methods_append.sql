-- Migration 029: append three payment methods observed in the 2026 import
-- data to po_payment_methods — Amex (1002), Walmart card, Citi (9627).
-- Idempotent: each appends only if absent (jsonb containment check), always
-- at the END — existing order preserved, element 0 stays the default
-- (list order is meaningful, per 028). Other lists untouched.

UPDATE settings SET value = value || '"Amex (1002)"'::jsonb
 WHERE key = 'po_payment_methods' AND NOT value @> '"Amex (1002)"'::jsonb;

UPDATE settings SET value = value || '"Walmart card"'::jsonb
 WHERE key = 'po_payment_methods' AND NOT value @> '"Walmart card"'::jsonb;

UPDATE settings SET value = value || '"Citi (9627)"'::jsonb
 WHERE key = 'po_payment_methods' AND NOT value @> '"Citi (9627)"'::jsonb;
