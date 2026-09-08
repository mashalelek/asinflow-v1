-- Companion to 036: the scope CHECK still enforced the old two-value enum.
-- Allow the bulk marker while keeping the constraint meaningful.
ALTER TABLE refresh_runs DROP CONSTRAINT refresh_runs_scope_check;
ALTER TABLE refresh_runs ADD CONSTRAINT refresh_runs_scope_check
  CHECK (scope IN ('full', 'subset') OR scope LIKE 'bulk:%');
