# Why the removal order detail report ends FATAL (2026-11-21)

`GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` ended FATAL on most of the
60-day windows the Finances backfill asked for (jobs #784, #790, #796 on
production; jobs 61 / 70 locally) — within seconds of creation, with no
document attached. This note records the diagnosis before the fix.

## What Amazon documents

- The FBA reports page lists both removal reports as "can only be
  requested" and **"near real-time"**, and says of near-real-time FBA
  reports: *"A near real-time FBA report is generated no more than once
  every 30 minutes."* No date-range limit, no date-field semantics, nothing
  about empty windows or FATAL
  ([report type values, FBA](https://developer-docs.amazon/sp-api/docs/report-type-values-fba)).
- The GitHub discussion asking Amazon to document request frequency says
  *"if you request a report 'too frequently' you will get a fatal status
  back"* and that the removal SHIPMENT detail report *"appears to only be
  requestable approximately once every two hours"* (an observation, not a
  documented limit)
  ([amzn/selling-partner-api-models #601](https://github.com/amzn/selling-partner-api-models/discussions/601)).
- The issue listing FATAL causes names "no data available for the date
  range" and a date range outside the type's limits
  ([#398](https://github.com/amzn/selling-partner-api-models/issues/398)).
- A seller-forum thread about this exact report never completing (CANCELLED,
  then FATAL, "worked a couple of weeks earlier") got no answer beyond
  "open a support case"
  ([seller forums](https://sellercentral.amazon.com/seller-forums/discussions/t/1d3fa8227bf693d7db5c6cc0497d65e8)).

## The probe (production account, 2026-11-21, read-only)

Each request: `createReport`, polled every 10 s, the full `getReport`
payload kept, the document downloaded when a `reportDocumentId` exists.
Scripts under the session scratchpad (`removal-matrix.ts`, `removal-one.ts`).

| # | Time (UTC) | Report | Window | Result | Note |
|---|---|---|---|---|---|
| A1 | 11:00 | removal order detail | 2026-10-15 … 10-25 (10 d, removals known) | **DONE**, 20 rows, 21 s | first request of this type for 4 hours |
| A2 | 11:02 | removal order detail | the same window, 90 s later | **FATAL**, 21 s | no `reportDocumentId` in the payload — there is no error document to read |
| A3 | 11:04 | removal order detail | 2025-02-01 … 02-07 (7 d, no removal fees posted that fortnight) | FATAL, 21 s | 2 min after A2 — cannot separate "empty" from "too frequent" |
| A4 | 11:06 | removal shipment detail | 2026-10-15 … 10-25 | **DONE**, 16 rows, 31 s | the other type is independent (its own counter) |
| A5 | 11:08 | removal shipment detail | 2025-02-01 … 02-07 | FATAL, 31 s | 2 min after A4 — same ambiguity |
| C1 | 11:40 | removal order detail | 2025-02-01 … 02-07, **alone**, 36 min after A3 | **DONE**, 0 rows (header only), 31 s | an empty window is a normal, empty report |
| C2 | 12:12 | removal order detail | 2026-10-15 … 10-25, 31 min after C1 | **DONE**, 20 rows | control |
| C3 | 12:43 | removal order detail | 2026-09-12 … 11-10 (the 60-day window that ended FATAL three times in the jobs), 31 min after C2 | **DONE**, 31 s | the window was never the problem |

**Which date the window applies to:** A1's 20 rows have `request-date`
2026-10-16 … 10-23, inside the window, while their `last-updated-date`
runs to 2026-11-17, outside it — the range filters on **request-date**. A4
(shipment detail) likewise: request-date inside, shipment-date to 11-11.

**The processing payload of a FATAL report** carries `createdTime`,
`processingStartTime`, `processingEndTime` ≈ 9 s later, the window, and no
`reportDocumentId`: Amazon attaches no reason for this type.

## Reading the job history against the 30-minute rule

| Job | Requests of the type | Outcome |
|---|---|---|
| local 61 (16:15 UTC 11-20) | chunk 1 right after a probe request at 15:xx | chunk 1 DONE, chunk 2 (seconds later) FATAL |
| local 70 (16:16) | chunk 1 one minute after job 61's | FATAL |
| probe 11-20 ~16:30, three windows in a row | | all three FATAL; a lone request of Aug 1 – 31 fifty minutes later: DONE, 22 rows |
| production 784 (23:25) | chunk 1 | DONE; chunk 2 seconds later FATAL (the old code stopped there) |
| production 790 (02:19 → 05:21) | 12 chunks, each retried after 10-min quota waits | stored at 02:32, 03:11, 04:26 — the three that fell ≥ 30 min after the previous success; the rest FATAL |
| production 796 (06:59) | one 60-day chunk | FATAL — job 790's component had stamped a request for the same type at 07:00:39 (its last chunk's retry landed as 796 started: `finances_ingest_log` shows a removals row at 07:00:39) |

Every DONE sits ≥ 30 minutes after the previous request of the same type;
every FATAL (so far) sits inside 30 minutes of one.

## Findings

1. **The cause is request frequency, nothing else.** The removal order
   detail report is a near-real-time FBA report; Amazon generates it no
   more than once every 30 minutes per report type, and a second request
   inside that window is not queued, not served from cache and not refused
   at `createReport` — it is accepted and ends **FATAL** about nine seconds
   later, with no `reportDocumentId`, so there is no error document to read.
   Every FATAL in the jobs and probes sat inside 30 minutes of an earlier
   request of the type; every request spaced ≥ 31 minutes came back DONE
   (A1, C1, C2, C3; the three stored chunks of job #790 at 02:32, 03:11,
   04:26).
2. **An empty window is not FATAL.** 2025-02-01 … 02-07 (no removal orders)
   asked alone returns DONE with a header-only document (C1). Nothing to
   special-case: zero rows is an empty, covered window.
3. **Window length is not a factor** in the range used: 1-day to 60-day
   windows, and the 91-day Jul 1 – Sep 30 probe of 2026-11-18, all DONE
   when spaced. C3 is the exact 60-day window that ended FATAL three times
   in the jobs.
4. **The window filters on `request-date`**, not `last-updated-date`: rows
   requested inside the window carry updates up to weeks after it. A
   removal requested in one window and completed in the next appears in the
   first; the upsert keeps its latest `last-updated-date` whenever that
   window is read again.
5. **The shipment detail report** (`GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA`)
   behaves the same way (A4 DONE, A5 FATAL two minutes later) and has its
   own 30-minute counter — the two types do not block each other (A4 ran
   DONE two minutes after A3's FATAL). It carries shipments only (no
   disposals), so it cannot replace the order detail report for the
   Disposal line.
6. **What the ingest did wrong:** it asked the 12 chunks of a backfill back
   to back (job #784 after the first; #790 every 10-minute quota wait), the
   stand-in job #796 asked within a minute of #790's last retry, and the
   local probes of 2026-11-18 / 11-20 ran beside the jobs — all second
   requests inside 30 minutes.

## The fix (commit `532eb9f`, 2026-11-21)

- `ensureReportSpacing(type)` (`server/finances-reports.ts`): before every
  removal order report request, wait until 31 minutes have passed since the
  type's last request — the stamp lives in `settings`
  (`reports.last_request.<type>`), so it holds across jobs, passes, scripts
  and restarts — then stamp now. A FATAL that still comes is asked once
  more after another spacing, then recorded as a failed chunk (the step
  shows `error:` outcomes, the job goes on).
- Empty windows: a header-only DONE report is stored as an empty window
  (a `finances_ingest_log` row with 0 rows) — covered, not failed.
- **Coverage ledger:** `missingRemovalWindows(from, to)` = the ≤ 60-day
  windows no successful `removals` ingest-log row covers. The nightly pass
  asks the trailing 60 days and then **one** older uncovered window (newest
  first, back to Amazon's 730 days), so the history fills itself at one
  window per night; `_removals_older_missing` on the ledger row says how
  many wait.
- `npm run backfill:finances -- --prod --from <day> --removals-only` asks
  every missing window of a range at the 31-minute pace (ten windows ≈ five
  hours) and rebuilds `finances_daily` from `from`; `finances_reports:
  "removals"` on the job's params.
- The returns report and the storage report are not near-real-time and
  keep their own rules (back-to-back chunks; two newest + three missing
  storage months per pass).

## Backfilling the missing windows

`npm run backfill:finances -- --prod --from 2025-03-21 --removals-only`
(2025-03-21 … today in 60-day windows: the gaps 2025-03-21 … 2026-03-15,
2026-05-15 … 2026-07-13 and 2026-09-12 … today, the covered ones re-read
harmlessly), spaced 31 minutes apart. Result recorded in
`docs/finances-acceptance-results-2026-11-20.md` ("Production results").
