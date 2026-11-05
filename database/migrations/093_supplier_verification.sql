-- Supplier verification (Maria 2026-11-05; SPEC §11 "Supplier verification"): Capture PO's "Verify supplier" —
-- one Claude call with web search, on click only — stored on the supplier record. An AI assessment, not a
-- guarantee. findings = { legitimate, usBased, domainAge, points[] }; sources = [{ title, url }].
ALTER TABLE suppliers ADD COLUMN verified_at timestamptz;
ALTER TABLE suppliers ADD COLUMN verdict text CHECK (verdict IN ('looks_legit', 'mixed', 'red_flags'));
ALTER TABLE suppliers ADD COLUMN findings jsonb;
ALTER TABLE suppliers ADD COLUMN sources jsonb;
