# SPEC Patch — Keepa trend columns

*Drafted 2026-11-18 with Maria. Mockup approved 2026-11-18.*

> **Status: IMPLEMENTED 2026-11-18 (commits 1–6 on main).** Deviations from the
> text, each noted where it applies: the component is **33**, not 25 (25 is PO
> tracking ingest in the code; the number came from the older component map);
> the cost is **4 tokens per ASIN**, not 3 (spike S3; still under the 20,000
> rule); the New, FBA line is **built** from `csv[34] COUNT_NEW_FBA` (spike S2;
> history from February 2026); **Bulk Calc has the columns** (Maria 2026-11-18:
> every table whose rows are ASINs — the "Out of scope" line below is
> superseded). The existing Product-cell hover graph uses Keepa's public image
> URL with no key (checked before commit 1). SPEC §6 "Keepa trend columns",
> §11 "Keepa jobs (lane K)", §14, §24.
> Runs after `claude_spec-patch-remove-view-presets-and-light-mode.md`.
>
> Keepa field names, array positions and token costs below come from Keepa's
> docs and secondary sources, not from a call against Maria's key. Commit 1
> is a read-only spike that confirms them.

## What this adds

Four columns on the ASINs table, each a small trend chart drawn from Keepa's
history, so a product can be judged without opening Keepa:

| Column | Lines | Header toggle |
|---|---|---|
| **Price Trend** | Buy Box · New price | New price can be hidden |
| **Sales Velocity Trend** | Monthly Sold · Sales Rank | — |
| **Offer Count** | New · New, FBA | New, FBA can be hidden |
| **Rating Count** | Rating Count | — |

The data comes from the Keepa API (Starter plan, 20 tokens/min) and is
Keepa's own history, including the years before an ASIN entered AF. Every
active and parked ASIN is refreshed once a day; a newly added ASIN is
fetched as soon as it is added.

## The mockup is the UI

`docs/mockups/keepa-trends-2026-11-18.html`. It is the spec for the four
cells, the header chips and toggles, the Trend range switch, the hover
marker and the hover popup: layout, wording and look, pixel for pixel,
proven with a side-by-side screenshot (docs/UI_RULES.md). Where the mockup
and this text differ, the mockup wins.

The nav, title row and other columns in the mockup are only a backdrop. This
patch does not restyle the ASINs page.

## How the columns behave

### Lines

| Line | Color | Width |
|---|---|---|
| Buy Box | `#ff4fb0` | 1.5 |
| New price | `#8f8ac4` | 1.25 |
| Monthly Sold | `#f5d21f` | 1.75 |
| Sales Rank | `#7dba7d` | 1.25 |
| Offer count, New | `#a3a8ff` | 1.5 |
| Offer count, New, FBA | `#f0713a` | 1.25 |
| Rating Count | `#a9c23f` | 1.5 |
| Hover marker | `#5a564f` | 1 |

In a two-line cell the first line listed (Buy Box, Monthly Sold, New) is
drawn on top.

### Range

A `1 year | All` switch in the table toolbar, applying to all four columns.
Default 1 year. Shown while at least one of the four columns is visible.

- **1 year:** the 365 days ending today (ET).
- **All:** from the ASIN's earliest stored Keepa day to today.

### Trend line

Each line is a trend over the range, not a plot of daily values:

- The range is cut into 14 equal time buckets.
- A bucket's value is the mean of its daily values.
- Consecutive buckets are joined by straight segments.

### Gaps

A stretch with no value is a gap in the line. This holds for every line.

- A bucket with data on fewer than half its days is a gap.
- The line stops before a gap and resumes after it. Nothing is drawn across
  it and it is never treated as zero.
- Days before a series begins are a gap, so a line starts where its data
  starts.

### Scales

Computed per cell, per ASIN, from the bucket values.

| Cell | Scale |
|---|---|
| Price Trend | Buy Box and New price share one dollar scale: min to max over both, padded 10%. |
| Sales Velocity Trend | Each line has its own scale. Monthly Sold: 0 to max × 1.2. Sales Rank: min to max, with the larger rank number plotted higher, as on Keepa's chart. |
| Offer Count | New and New, FBA share one scale: 0 to max(New) × 1.1. |
| Rating Count | min − 30% of span, to max. |

Hiding a line with its header toggle does not change the scale of the line
that remains.

### Hover

The cell shows the chart only; values appear on hover. Hovering a chart
shows a thin vertical marker at that day and a popup above it with:

- the date (`Mar 4, 2026`);
- one row per visible line, in the line's color, with that day's stored
  value: `Buy Box $25.31` · `New $25.28` · `Monthly Sold 50+` ·
  `Sales Rank #175,887` · `New 7` · `New, FBA 3` · `Rating Count 222`.

These are the stored daily values, not the bucket averages. A line with no
value that day shows `—`. The popup must not be clipped by the table's
scroll container.

### Header and columns

- New column group **Keepa** in `COLUMN_GROUPS`, after Sellers, with the
  four columns in the order above. Group label "Keepa" as the small muted
  line above the header text, like Actual / Estimated.
- Under each header, chips name the lines in their colors. The **New** chip
  on Price Trend and the **New, FBA** chip on Offer Count are toggle buttons
  that hide or show that line (and its popup row) in every row.
- The four columns are visible by default. For a user who already has a
  saved column layout, they are added to it once, visible; hiding them
  afterwards sticks.
- The range and the two toggles are remembered per user, stored with the
  table's column config (the Repricer tab keeps its own).
- A cell with no data is empty.

## Keepa request

`GET https://api.keepa.com/product` with `key`, `domain=1`, `asin=` (comma
list), `buybox=1`, `rating=1`. The `offers` parameter is not used: it costs
6 tokens per page of 10 offers and none of this needs it.

`KEEPA_API_KEY` is a server-side env var (SPEC §24) and is never sent to the
browser. Maria upgrades the Keepa plan before commit 2 goes live.

Where each series is expected in the product object:

| AF series | Keepa source (expected) | Needs |
|---|---|---|
| `buy_box` | `csv[18]` BUY_BOX_SHIPPING | `buybox=1` |
| `new_price` | `csv[1]` NEW | base request |
| `sales_rank` | `csv[3]` SALES | base request |
| `offers_new` | `csv[11]` COUNT_NEW | base request |
| `rating_count` | `csv[17]` COUNT_REVIEWS | `rating=1` |
| `monthly_sold` | `monthlySoldHistory` | base request |
| `offers_new_fba` | unconfirmed | spike S2 |

Keepa history arrays are change points `[keepaTime, value, …]`
(`keepaTime` in minutes; unix ms = `(keepaTime + 21564000) * 60000`).
`-1` means no value. Prices are integer cents.

## Commit 1 — spike (read-only)

A script against Maria's key; results committed as
`docs/keepa-spike-<date>.md`. Test ASIN **B08G6J2PY5**, plus 19 other ASINs
from the catalog. Reference for B08G6J2PY5 is Keepa's own chart on
2026-11-18: Buy Box $25.31, New $25.28, Sales Rank #175,887, Rating Count
222, New offers 7, New, FBA offers 3; Monthly Sold at 50 from Dec 2025 to
late Jan 2026 with a short gap in Dec, and nothing since.

| # | Question | Decision rule |
|---|---|---|
| S1 | Does each series come back where the table above expects it? | Use what the response shows. A series Keepa's chart shows for B08G6J2PY5 but the response lacks → stop and report. |
| S2 | Where is New, FBA offer-count history? | In this request → build it. Only through `offers` → build the Offer Count column with the New line alone, no New, FBA line or toggle, and say so in the report. |
| S3 | Tokens consumed per ASIN for this request (1 ASIN, then a batch of 20). | Daily need = cost × ASINs in scope. Up to 20,000 tokens/day (the plan makes 28,800) → proceed. More → stop and report the cost of base / +buybox / +rating separately. |
| S4 | How does `monthlySoldHistory` mark the end of a value? | The stored series must match Keepa's chart for B08G6J2PY5: present Dec to late Jan, no value since. |
| S5 | Response size and parse time for a 20-ASIN batch. | Batch size starts at 20; halve it if a batch exceeds 30 MB or 10 s. |
| S6 | Is the returned data current without setting `update`? | Leave `update` unset unless data is more than a day stale; then report what `update=0` costs. |

The spike spends tokens from the production bucket: run it after the plan
upgrade.

## Fetching: lane K

The runner has two lanes (S = scheduled passes, M = manual / onboarding /
bulk). This patch adds **lane K** for Keepa. It runs alongside S and M, one
Keepa job at a time. Keepa is a different API writing different tables, so
lane K shares nothing with the other lanes and a Keepa job waiting for
tokens holds nothing up.

SPEC §11/§14 lane rule becomes: SP-API refresh work on lanes S and M; Keepa
on lane K.

| # | Component | Lane | Call |
|---|---|---|---|
| 25 | Keepa history | K | Keepa `product`, batches of up to 20 ASINs |

Component 25 runs only in Keepa jobs. Scheduled passes, the Refresh button,
the onboarding Refresh job and Bulk Calc do not include it.

### Jobs

`jobs.kind` gains `'keepa'`.

- **Daily** — `0 0 * * *` America/New_York enqueues a scheduled Keepa job
  for every active and parked ASIN. If the previous one is still queued or
  running, none is added.
- **New ASINs** — when ASINs are inserted into `asins` (Upload File, Sync
  Sourcing, SC discovery, Buy List promote, sales import), a Keepa job for
  those ASINs is enqueued at once. One enqueue point, in the shared
  onboarding function.

A new-ASIN job goes ahead of the daily job: the daily job checks between
batches, lets it run, then continues.

### Running a job

1. Order the ASINs by `keepa_fetch.fetched_at`, never-fetched first, then
   oldest. The daily job leaves out ASINs already fetched since 00:00 ET.
2. Fetch in batches of up to 20. If Keepa's `tokensLeft` does not cover the
   next batch, wait for the refill Keepa reports (`refillIn`, `refillRate`).
3. Store each ASIN and record its outcome.

Expected at about 3 tokens per ASIN and 2,453 ASINs: about 7,400 tokens. The
bucket holds 1,200 at midnight and refills 20/min, so the daily job takes
about five hours. A few new ASINs are fetched within a minute or two; a
500-ASIN upload takes about 1 hour 15 minutes.

- **Outcome per ASIN:** `fetched` · `not_due` (daily job, already fetched
  today) · `not_found` · `error`. The job summary records tokens spent.
- **Errors:** HTTP 429 → wait `refillIn`, retry. Any other batch failure →
  3 retries with backoff, then mark those ASINs `error` and go on. The next
  day's job is a new job.
- **Restart:** a job found `running` at startup continues; the ordering and
  the fetched-today rule keep it from refetching.
- **Incomplete day:** a daily job that ends with in-scope ASINs not fetched
  that day records `keepa_incomplete: N`, shown on its row in the jobs
  dialog.
- **Jobs dialog:** rows `scheduled · Keepa` and `onboarding · Keepa`,
  progress in ASINs. `GET /api/jobs/current` gains `keepa`.
- Dead ASINs are not fetched; what is stored for them stays.

## Data model

Next free migration number. Keyed by ASIN text, no FK (public data, like
`asin_estimates`).

```sql
CREATE TABLE keepa_series (
  asin       TEXT      NOT NULL,
  series     TEXT      NOT NULL CHECK (series IN
             ('buy_box','new_price','sales_rank','monthly_sold',
              'offers_new','offers_new_fba','rating_count')),
  first_day  DATE      NOT NULL,   -- America/New_York day of vals[1]
  vals       INTEGER[] NOT NULL,   -- one element per day; NULL = no value
  PRIMARY KEY (asin, series)
);

CREATE TABLE keepa_fetch (
  asin              TEXT PRIMARY KEY,
  fetched_at        TIMESTAMPTZ NOT NULL,
  keepa_last_update TIMESTAMPTZ,   -- product.lastUpdate
  tokens            INTEGER,
  status            TEXT NOT NULL, -- fetched | not_found | error
  error             TEXT
);
```

`jobs.kind` CHECK widened to include `'keepa'`.

### Change points → daily values

- Day boundary: America/New_York.
- A day's value is the value in effect at the end of that day; a value holds
  until Keepa's next change point.
- Keepa `-1` → NULL. NULL is "no value", distinct from 0.
- A series ends at the day of `product.lastUpdate`.

### Writes

- One transaction per ASIN: each series in the response replaces its stored
  row, then `keepa_fetch` is upserted. Every pull carries the full history,
  so replacing is idempotent.
- A failed or partial response writes nothing for that ASIN.
- If a successful response lacks a series AF already holds, the stored
  series is kept and the outcome records `series_missing:<name>`.
- SPEC §14 ownership: `keepa_series` and `keepa_fetch` are written by
  component 25 only.

## API

- `GET /api/keepa/trends?asins=…&range=1y|all` — for the rows on screen: per
  ASIN and series, the 14 bucket values and the scale bounds.
- `GET /api/keepa/history/:asin?range=1y|all` — the daily values for one
  ASIN, all series. Loaded on first hover over that row's trend cells and
  cached for the page session.

Bucket and scale math live in one server-side function; the client draws.

## Acceptance table (the test; filled in in the report)

| # | Case | What Maria sees |
|---|---|---|
| 1 | B08G6J2PY5, 1 year; hover the right edge of each of its four charts | The popup values match Keepa's chart for that ASIN that day |
| 2 | Same ASIN, Sales Velocity Trend | Monthly Sold line at the left only (Dec to late Jan); hovering a later day shows `Monthly Sold —` with a Sales Rank number |
| 3 | An ASIN with a month-long stretch of no data on any line | That line stops and resumes around the stretch; the other line in the cell is unaffected; the popup shows `—` for it there |
| 4 | An ASIN whose Sales Rank number fell over the year | The Sales Rank line falls from left to right |
| 5 | Click **New** in the Price Trend header | The New price line and its popup row disappear in every row; the Buy Box line does not move. Click again → back |
| 6 | Click **New, FBA** in the Offer Count header | Same for the New, FBA line |
| 7 | Switch to **All**, then reload | Charts cover each ASIN's full Keepa history; still All after reload |
| 8 | An ASIN with no Sales Rank and no Monthly Sold | Empty Sales Velocity cell; its Rating Count chart still draws |
| 9 | Add one new ASIN in the afternoon | Its four charts appear within a minute or two, no click |
| 10 | Add a new ASIN at 01:00, during the daily Keepa job | Its charts appear within a few minutes; the daily job carries on |
| 11 | The 04:00 hourly pass during the daily Keepa job | Starts at 04:00 and takes its usual time; the jobs dialog shows both running |
| 12 | Click Refresh on a selection | No Keepa job is created |
| 13 | Morning after | `scheduled · Keepa` done; fetched = ASINs in scope |
| 14 | Keepa unreachable for one night | Scheduled passes run as usual; the Keepa job shows the error; charts unchanged |
| 15 | First load after deploy | The four columns are there; every other column as before |
| 16 | Side-by-side screenshot, mockup vs AF | Cells, header chips, range switch and popup match |

## Tests

- Change points → daily: value holds to the next change point, `-1` → NULL,
  ET day boundary, series ends at `lastUpdate`, Keepa time conversion.
- Bucketing: 14 buckets; half-coverage rule at the boundary; a gap splits
  the path for every series.
- Scales: shared price and offer scales unchanged by the toggles; a larger
  Sales Rank maps higher in the cell.
- Lane K: runs while S and M each have a running job; a waiting Keepa job
  does not delay a lane-S claim; a new-ASIN job goes ahead of the daily job;
  one scheduled Keepa job at most; a restart refetches nothing already
  fetched today.
- Token pacing follows Keepa's refill values; 429 handling;
  `series_missing` keeps stored data; a partial response writes nothing.
- Inserting ASINs enqueues exactly one new-ASIN Keepa job.
- Component 25 appears in no lane-S or lane-M component list.
- No request to Keepa carries `offers`; the key is in no client bundle or
  API response.

## Commits

1. `keepa: spike — series, token cost, payload (read-only)`
2. `keepa: client, keepa_series / keepa_fetch, lane K, component 25`
3. `keepa: new ASINs enqueue a Keepa job at insert`
4. `keepa: trends and history endpoints, bucket + scale math`
5. `keepa: trend columns, header toggles, range switch, hover`
6. `docs: SPEC §6 / §11 / §14 / §24, CLAUDE.md, component map`

## Out of scope

- Sorting, filtering or alerts on the trend columns.
- Trend columns in Bulk Calc.
- Using Keepa data in profit math, the repricing engine or the Sellers
  columns.
- The existing Keepa hover graph on the Product cell.
- Email when a daily Keepa job is incomplete.
