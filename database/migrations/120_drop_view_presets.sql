-- 120: view presets are gone (Maria 2026-11-18, docs/claude_spec-patch-remove-view-presets-and-light-mode.md).
-- The view button, its menu, the save flow and the four /api/view-presets routes were removed with this
-- migration's commit; nothing reads the table any more. Each user's on-screen columns were never stored here:
-- activating a preset copied its columns into the browser's own column config (localStorage
-- `fba-column-config`), which the table has always loaded from — so dropping the table changes no one's
-- columns, order or widths. The last row was the seeded "Full View" (2026-04-04).
DROP TABLE IF EXISTS view_presets;
