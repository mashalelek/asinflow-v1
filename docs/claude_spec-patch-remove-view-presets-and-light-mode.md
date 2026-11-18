# SPEC Patch — Remove view presets and light mode

*Drafted 2026-11-18 with Maria. Two removals, two commits. Maria uses
neither feature. Runs before `claude/spec-patch-keepa-trends.md`.*

> **Status: APPROVED by Maria 2026-11-18 and IMPLEMENTED the same day** —
> commit 1 `ui: remove view presets` (migration 120), commit 2 `ui: remove
> light mode`. The probe's findings and the filled-in acceptance table are at
> the end of this file.

## Decisions (Maria, 2026-11-18)

| # | Decision |
|---|---|
| 1 | View presets are deleted altogether: the view button on the ASINs toolbar (shows "Custom", opens "Full View" / "+ Save As New View"), its menu, the save flow, and everything behind it. |
| 2 | Light mode is removed. AF is dark only. The theme option leaves the header. |

No mockup: both changes only remove a control. Nothing else on any screen
moves, except that the toolbar closes the gap the view button leaves.

## Rule

**What Maria sees in the table before the patch is what she sees after it:
the same columns, in the same order, at the same widths, with the same
filters and toggles. The patch removes the ability to switch or save views;
it does not reset anyone's columns.**

## Commit 0 — probe (read-only, reported, nothing changed)

1. Every reader and writer of view presets: the `view_presets` table, its
   API routes, client hooks/components, localStorage keys, seeds, tests.
2. Every page that renders the view button (ASINs; check Bulk Calc and the
   Repricer tab, which reuse the table).
3. Whether anything other than the view button depends on a preset: the
   default column set for a new user or cleared storage, the Replenishment
   filter (SPEC §4), the Buy List view, the Sourcing view, the Repricer's
   own column config.
4. Where the theme is chosen: the header control, the stored preference, any
   OS `prefers-color-scheme` read, and how many places branch on theme.

**Stop and report only if** item 3 finds a feature other than the view
button that would stop working (for example the Replenishment filter being
implemented as a preset). Otherwise continue.

## Commit 1 — remove view presets

- Remove the view button, its dropdown, "Save As New View" and any
  rename/delete-view UI from every page found in the probe.
- The **Columns** button (Manage Columns) stays and is the only way to
  choose columns.
- Each user's current on-screen column configuration becomes their column
  configuration. If the active config lives inside a preset record ("Custom"
  or a named view), it is copied to the plain per-user column-config storage
  before the preset code is removed, per page (parameterized storage keys
  stay separate for the Repricer tab and Bulk Calc).
- Default for a user with no saved config: `COLUMN_GROUPS` with each
  column's `defaultVisible`.
- Remove the preset API routes, client code and tests. Drop `view_presets`
  in a migration **only after** the probe shows no remaining reader; the
  migration copies nothing it has not already copied above.
- **Not touched:** the Replenishment filter, Smart Replenishment tiers, Buy
  List and Buy List (on hold), visibility toggles (Show gated / meltable /
  parked / dead), column filters, Active Filters, the Columns panel.

## Commit 2 — remove light mode

- Remove the theme option from the header.
- AF renders dark for every user (Maria, partner, VA): the stored theme
  preference and the OS preference are no longer read; `dark` is set once at
  the app root.
- Delete the stored-preference code and the light-only branches and token
  blocks where that is a straight deletion. Anything that is not a straight
  deletion is listed in the report and left.
- Tests that assert "both themes" become dark-only.

## Acceptance table (the test; filled in in the report)

| # | Case | What Maria sees |
|---|---|---|
| 1 | Open ASINs after deploy | No view button next to Columns; the table shows exactly the columns, order and widths she had before |
| 2 | Open the Repricer tab and Bulk Calc | Same: their own columns unchanged, no view button |
| 3 | Open Columns, hide a column, reload | Still hidden |
| 4 | Replenishment filter, Buy List, Show parked | Work as before |
| 5 | Header | No light/dark option |
| 6 | A browser or OS set to light | AF is still dark |
| 7 | Partner's login | Dark, his own columns unchanged |

## Tests

- Column config before/after migration is identical for a user whose active
  config was a preset, a "Custom" state, and no saved config.
- No route, component or query references view presets.
- App root is dark regardless of stored preference or `prefers-color-scheme`.

## Commits

0. Probe (report only).
1. **`ui: remove view presets`** — SPEC §6 (column config), §13/§14 mentions,
   CLAUDE.md "Three view presets" line, schema doc.
2. **`ui: remove light mode`** — SPEC §7 (light palette removed), CLAUDE.md.

## Out of scope

- Restyling the toolbar or header (AF-wide restyle is its own priority).
- Any change to which columns are visible.

## Report (2026-11-18)

### Commit 0 — probe findings

1. **Readers / writers of view presets:** `client/src/components/view-presets.tsx`
   (the only client; ASINs toolbar), four routes in `server/routes.ts`
   (`GET / POST /api/view-presets`, `PUT / DELETE /api/view-presets/:id`),
   their four lines in `server/route-inventory.test.ts`, the `view_presets`
   table (baseline; migrations 049 / 050 mention its dropped `created_by`),
   localStorage `fba-active-preset` (a label only), and two one-off SQL files
   from the 2026-05-23 cutover. No seeds, no other tests.
2. **Pages rendering the view button:** the ASINs page only. Bulk Calc, the
   Repricer tab and ASIN Analytics render `ColumnManager` with their own
   storage keys and never imported the component.
3. **Nothing else depends on a preset.** Activating a preset called
   `saveColumnConfig`, writing the columns into `fba-column-config`; the table
   has always loaded from that key (`loadColumnConfig`), never from a preset
   record. The Replenishment filter is `isReplens()` behind the Replens
   scorecard tile; the preset's old `filter` field was never applied. The
   default for an empty store was already `getDefaultConfig` (`COLUMN_GROUPS`
   × `defaultVisible`). Buy List and the Sourcing view are not preset-backed.
4. **Theme:** `theme-provider.tsx` (localStorage `fba-theme`, default dark, no
   `prefers-color-scheme` read anywhere), the Sun / Moon button in
   `top-nav.tsx`, one branch in `dashboard-chart.tsx` (`SERIES_COLORS`),
   `index.css` with a light `:root` block and a `.dark` override block, and
   134 Tailwind `dark:` utilities.

Production `view_presets` row count was not read (the production query was
blocked in the implementing session); locally the table held the one seeded
"Full View" row. The decision does not depend on it.

### What changed

- **Commit 1:** component, routes, test lines and the two one-off SQL files
  deleted; migration 120 drops the table; `client/src/lib/columns-no-presets.test.ts`
  pins the three before/after cases and scans client / server / shared for any
  reference. No column store was touched or migrated — none needed to be.
- **Commit 2:** `<html class="dark">` in `client/index.html`; `theme-provider.tsx`
  deleted; the toggle, the `useTheme` imports and the chart branch removed;
  `index.css` keeps one `:root` block (the six non-theme tokens + the dark
  values) and the `.dark` block and the `.dark .table-zebra-stone` rule are
  folded in; `SERIES_COLORS` is one pair; `metric-tiles.test.ts` and
  `dashboard-chart.test.ts` are dark-only; `client/src/dark-only.test.ts`
  guards the root class, the absence of any preference read and the single
  token block.
- **Left as is (not a straight deletion):** the 134 `dark:` utility classes
  (they keep working through the root class; rewriting each to its dark value
  is a restyle, out of scope); `client/src/components/ui/chart.tsx` (unused
  shadcn boilerplate with a light/dark THEMES map, no importer); the Capture
  PO extension's `prefers-color-scheme` panel styling (SPEC §11, a different
  surface, not AF's app root).

### Acceptance table

| # | Case | Seen 2026-11-18 (local dev server, Chrome) |
|---|---|---|
| 1 | Open ASINs after deploy | Row 2 of the toolbar ends with **Columns** alone; no view button. `fba-column-config` untouched, the table loads it as before (test: preset-active / Custom / empty) |
| 2 | Repricer tab and Bulk Calc | Never had the button; their keys `fba-repricer-column-config` / `fba-bulk-column-config` are not touched |
| 3 | Columns → hide → reload | Unchanged code path (`ColumnManager` → `saveColumnConfig`) |
| 4 | Replenishment filter, Buy List, Show parked | Not in the diff |
| 5 | Header | Date picker · Settings · User; no Sun / Moon button |
| 6 | Browser or OS set to light | `<html class="dark">` is static; `fba-theme` and `prefers-color-scheme` are never read (`dark-only.test.ts`); body bg `rgb(28, 25, 23)` |
| 7 | Partner's login | Same static root class; columns per browser, untouched |

Browser check: page scroll width == client width on ASINs and Dashboard;
Dashboard charts draw in `#3c83f6` / `#12a594`. The window could not be
shrunk below the display's 2133 CSS px in that session, so the 1280 / 1440
assertion rests on the change removing controls only.
