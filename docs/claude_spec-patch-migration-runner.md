# SPEC Patch — Migration runner

*Drafted 2026-10-15 with Maria. Decisions confirmed the same day. Replaces the
"Migrations are manual `psql -f`" procedure in SPEC §24 with an automatic
runner so a schema change reaches Render the same way code does: on deploy.*

> **Status: DRAFT — awaiting implementation.** Two single-concern commits.
> Prerequisite for the scheduler rework, which will add several migrations.

## Why

Today every migration is applied by hand with `psql -f`, locally and (since
2026-10-15) against Render over the external URL. Two databases, one human
step each, no record of what has been applied except the files' existence.
A missed step on Render means a deploy whose code expects a column the
database doesn't have. The runner removes the step and keeps a ledger.

## Decisions (2026-10-15)

1. **Ledger seeding:** the runner's own first migration marks every
   migration file that already exists as applied, so both existing databases
   (local, Render) are current on the first run with nothing re-executed.
   Jason's future clone restored from a dump gets the same treatment.
2. **Dev uses the runner too.** `npm run dev` runs it on startup exactly as
   `npm start` does. The local flow becomes: write the file → restart the
   dev server → commit. `psql -f` is no longer part of the procedure.
3. **Fail closed.** A migration failure logs the file and the error and
   exits the process before the server listens. Render's health check then
   fails the deploy and keeps the previous instance up — the same posture as
   a missing `SESSION_SECRET`.

## Rule

**On startup, before anything else touches the database, the server applies
every unapplied file in `database/migrations/` in numeric order, each in its
own transaction, and records it. Nothing is ever applied twice. Nothing
serves until the ledger matches the files on disk.**

## Data model

Created by the runner itself if absent (not by a migration file, since the
runner must exist before any ledger does):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,          -- the NNN prefix
  filename    TEXT NOT NULL,                -- full file name, for the record
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL                 -- sha256 of file contents at apply time
);
```

`checksum` is informational: on startup, a mismatch between a recorded
checksum and the file now on disk is **logged as a warning**, never an error
(migration files are occasionally touched for comments). It is there so a
"did this file change after it was applied" question has an answer.

## Seeding migration

`database/migrations/051_seed_schema_migrations.sql` is an ordinary
migration whose body is empty except a comment. The runner special-cases
nothing. Seeding happens in code:

- On first run (ledger table just created and empty), **before** applying
  anything, the runner checks whether the database already has the
  `asins` table. If it does, this is an existing database: insert a ledger
  row for every file on disk with version ≤ the highest version present
  **except** files whose version is greater than the highest version the
  runner can prove was applied. The proof is simple and conservative: a file
  is treated as applied if its version ≤ 050 (the last manually applied
  migration as of this patch, recorded here as a constant
  `LAST_MANUAL_MIGRATION = 50`). Files above that are applied normally.
- If `asins` does not exist, this is a fresh database: the runner applies
  `database/asinflow_schema_v1.1.sql` first (the base schema), then every
  numbered file from 001 upward. This replaces the manual bootstrap in
  SPEC §24 and gives Jason a one-command local setup.

The constant is the one hard-coded number in the runner and is documented
in-line with the date. It is only consulted when the ledger is empty.

## Runner behaviour

- Location: `server/migrate.ts`, exporting `runMigrations(pool)`. Called
  from `server/index.ts` after the pool is created and before
  `ensureSettingsTable` and `ensureExtensionTables` (which it supersedes
  nothing about — they stay).
- Discovery: `fs.readdir` of `database/migrations/`, files matching
  `^(\d{3})_.*\.sql$`, sorted by the numeric prefix. Gaps are fine
  (005–007 and 009 are historical).
- Duplicate prefixes (two files with the same NNN) → fail before applying
  anything, naming both files.
- Apply loop: for each file not in the ledger, `BEGIN`; execute the file
  contents as one `query()`; insert the ledger row; `COMMIT`. Any error →
  `ROLLBACK`, log `migration NNN_name.sql failed: <pg error>`, exit 1.
- A migration file that must run outside a transaction (e.g.
  `CREATE INDEX CONCURRENTLY`) opts out with a first-line comment
  `-- migrate: no-transaction`. None exist today.
- Logging under tag `migrate`: "ledger: N applied, M pending", one line per
  file applied with elapsed ms, "schema current" when nothing is pending.
- Advisory lock: `SELECT pg_advisory_lock(7342001)` for the duration, so two
  instances starting at once (Render zero-downtime deploys overlap for a few
  seconds) cannot race. Released on exit either way.

## Tooling

- `npm run migrate` — runs the runner and exits; for applying without
  starting the server (useful on Render's Shell tab, and for Jason's first
  setup).
- `npm run migrate:status` — prints the ledger vs disk: applied, pending,
  checksum mismatches. Read-only.
- `script/create-admin.ts` unchanged.

## Documentation

- SPEC §24: "Migrations" subsection rewritten — runner, ledger, seeding,
  `migrate` and `migrate:status`, fresh-database path. "Initial data load"
  keeps the pg_dump/pg_restore procedure for copying data; notes that a
  fresh database no longer needs it for schema.
- CLAUDE.md: the migration procedure line becomes "add the file, restart
  the dev server, confirm `migrate:status` shows it applied, commit". The
  "migrations run only from committed code" rule stays.
- SPEC §25 untouched.

## Commits

1. **`migrate: runner with ledger, seeding, advisory lock; wired into startup`** — `server/migrate.ts`, startup call, `migrate` / `migrate:status` scripts, `051_seed_schema_migrations.sql`, tests. Tests: fresh DB path applies base schema then all files; existing DB path seeds ≤050 and applies 051; a failing file rolls back and exits non-zero with nothing recorded; duplicate prefix refused; `no-transaction` opt-out honoured; checksum mismatch warns only; advisory lock acquired/released.
2. **`docs: SPEC §24 migrations rewritten for the runner; CLAUDE.md procedure`** — documentation only.

Each: diff → approval → commit. Gate before push.

## Deploy sequence

1. Commit 1 lands locally; restart dev server; log shows "ledger: 51
   applied, 0 pending" (050 seeded + 051 applied). `npm run migrate:status`
   confirms.
2. Push. Render deploys; first start seeds the ledger the same way; log
   shows the same line. `/health` stays green throughout because seeding
   touches nothing but the new table.
3. From then on, a push containing `052_*.sql` applies it on deploy before
   the server listens.

## Out of scope

- Down migrations / rollback files. Forward-only, as today.
- Schema diffing or ORM-generated migrations. Files stay hand-written SQL.
