# UI rules

Required reading before any UI change (Maria 2026-11-04). The visual
design system itself is SPEC §7; these are the rules every page, table
and dialog must meet, and the check that proves it.

## Layout

1. **No horizontal scroll at ≥ 1280 px** on any page or dialog: the
   document's scroll width equals the viewport width at 1280 and 1440.
   A table wider than its box scrolls inside its own box; it never widens
   the page or its parent table. The expanded ASIN rows fit the POs table
   from 1024 (2026-11-05: 17 display columns, 1,118 px minimum).
2. **Tables use fixed layout with content-sized default widths, never
   auto.** `table-layout: fixed`, a `<colgroup>` and a default width (px)
   for every column, sized to what the column holds — a 60 px ASINs count
   is not a 300 px column. Spare page width goes to a trailing empty
   filler column, not spread over the others. Long values truncate with
   an ellipsis and carry the full text as the cell's `title`. A resizable
   table keeps its drag handles, per-browser saved widths and a
   **Reset widths** that returns to the defaults
   (`client/src/hooks/use-column-widths.tsx`).
3. **Fields are fixed width; rows wrap.** An input is sized for its
   content (money / percent 120 px, dates, codes) and never stretches to
   fill a row; a row of fields wraps to the next line instead of pushing
   past the edge.
4. **Labels never overlap.** A header label that does not fit wraps to
   two lines inside its column (never `nowrap` into the neighbour); a
   label and its value never sit on top of each other at any supported
   width.

## Look

5. **Warm-stone palette, quiet chrome (SPEC §7).** Stone surfaces, dark
   stone table headers, hairline borders. No new colours: amber is for
   warnings, tinted text / chips for status, never saturated badge fills;
   money is neutral. An "on / off" state is shown by form (filled vs
   outline icon, weight), not by a new colour.

## The browser check

6. **Every UI browser check asserts page scroll width == viewport at 1280
   and 1440** (`document.documentElement.scrollWidth ===
   clientWidth`), on every page and dialog the change touches, in the
   states it touches (a row expanded, a popover open, a dialog up).
7. **Before reporting, list anything a user would notice as wrong** —
   truncation that hides what matters, a tooltip that pops up on its
   own, misaligned columns, a wrap that splits a phrase, a control that
   jumps — and either fix it or name it in the report. "Tests pass" is
   not the check; looking at the screenshot is.

How a check is run here (headless Chrome over CDP, a throwaway `zz-`
user, cleaned up after): see CLAUDE.md "Gate tests must not leave ROWS
behind".
