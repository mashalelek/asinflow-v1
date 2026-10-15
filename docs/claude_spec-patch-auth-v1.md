# SPEC Patch — Authentication v1 (login, users, sessions)

*Drafted 2026-10-14 with Maria. Decisions confirmed the same day. Prerequisite
for loading real data into the Render deployment (SPEC §24): today nothing
gates the app — every `/api` route is open to anyone who reaches the host.*

> **Status: IMPLEMENTED 2026-10-14.** Three single-concern commits as
> listed below, plus two follow-ups found on the way: `auth.ts` must not
> import `./index` (the bootstrap script booted the server), and migration
> 050 drops the four Replit-era owner columns whose foreign keys 049's
> CASCADE removed. SPEC §25 is the record; this patch stays as the design
> source. Deviations from the text here: the Log out item is its own user
> menu in the top nav rather than inside the settings gear (the gear is a
> per-page button, not a menu, and is absent on some routes). The
> VA-specific restricted view and permission enforcement remain **on hold**
> (decided 2026-10-14); a `role` column is all that shipped for them.

## Why

The Part A audit (2026-10-13) found: no auth middleware; the only global
middleware is CORS, body parsing and request logging; `POST
/api/verify-password` compares to `APP_PASSWORD` and returns `valid: true`
when the variable is unset, but no client calls it; `login-screen.tsx` posts
to `/api/login`, which does not exist, and nothing imports it; `server/auth.ts`
(bcrypt helpers), the `users` table, `server/create-user.ts`, and the
`passport` / `express-session` / `connect-pg-simple` dependencies are unused
by the running server. That scaffolding is Replit-era and was stripped from
the request path in April; it was never rebuilt.

Amazon's Data Protection Policy for SP-API applications requires access
controls on any system holding seller data. A public URL with no login does
not meet that, so the data load waits for this patch.

## Decisions (2026-10-14)

1. **Session length:** 30 days with "Remember me" ticked; browser-session
   (cookie expires on close) when unticked.
2. **Lockout:** 5 failed attempts → account locked 15 minutes. Counter resets
   on success. Lockout is per account, not per IP.
3. **First account:** created by a one-time bootstrap script run against the
   database (locally first; on Render via the service's Shell tab after the
   data restore). No sign-up page. No default password anywhere.
4. **Further accounts:** created in a small admin UI (Settings → Users), not
   by script. Maria creates her partner's account there in the same session
   the first admin logs in. No self-service sign-up.
5. **Roles:** `admin` and `member`. Both see the full app today. The only
   role-gated surface in this patch is Settings → Users itself (admin only).
   VA restrictions are a later patch that builds on this column.
6. **Chrome extension:** treated as dead. Its routes get the same auth as
   everything else (a request without a session gets 401); the
   `chrome-extension://*` CORS allowance is removed. The extension rebuild
   starts from a clean slate and authenticates like any client.
7. **Scope guard:** auth gates `/api/*` and the SPA shell. `GET /health` stays
   unauthenticated (Render's health check has no session).

## Rule

**Every request to AsinFlow is either authenticated by a valid session or
answered with 401 (API) / a redirect to the login page (UI). `GET /health` is
the only exception.**

## Data model

Migration `049_auth_v1.sql`:

```sql
-- Replace, do not extend, the Replit-era users table.
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,           -- login identifier; lowercase enforced in code
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,                  -- bcrypt, cost 12
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin','member')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = disabled; cannot log in; sessions revoked
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,                    -- NULL = not locked
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  sid     TEXT PRIMARY KEY,
  sess    JSONB NOT NULL,
  expire  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions (expire);
```

`sessions` is the `connect-pg-simple` store shape. Expired rows are pruned by
the store's own sweeper.

No user-id columns are added to any existing table in this patch. Ledger
attribution ("who ran this sync") is a later concern; the `refresh_runs`
trigger column stays as is.

## Server

- **Session middleware:** `express-session` with `connect-pg-simple` on the
  existing `pg.Pool`. Cookie: `httpOnly`, `sameSite=lax`, `secure` when
  `NODE_ENV=production`, name `af.sid`. `maxAge` 30 days when the login
  request carried `remember: true`, otherwise no `maxAge` (browser session).
  Session secret from new env var `SESSION_SECRET` (required; the server
  refuses to start without it in production; a dev fallback is allowed only
  when `NODE_ENV !== 'production'`). Add `SESSION_SECRET` to SPEC §24's env
  table and to Render's environment before deploying commit 1.
- **Routes (new, all unauthenticated by nature):**
  - `POST /api/auth/login` `{ email, password, remember }` → 200 `{ user: { id, email, displayName, role } }` or 401 `{ error: "invalid_credentials" }`. Same 401 body for unknown email, wrong password, disabled account, and locked account — do not leak which. Lockout: on 5th consecutive failure set `locked_until = NOW() + 15 min`; while locked, every attempt returns 401 without checking the password and does not extend the lock. Success resets `failed_logins` and `locked_until`, stamps `last_login_at`, regenerates the session id.
  - `POST /api/auth/logout` → destroys the session, clears the cookie, 204.
  - `GET /api/auth/me` → 200 with the user when a session exists, 401 otherwise. The client calls this once on load.
- **Auth middleware** `requireAuth`: applied to every `/api/*` route except
  the three above and `/health`. Order in `server/index.ts`: health →
  session → auth routes → `requireAuth` → `registerRoutes` → static.
  The SPA catch-all (`serveStatic`) serves `index.html` regardless; the
  client renders the login page when `/api/auth/me` returns 401.
- **Admin routes** (behind `requireAuth` + `requireRole('admin')`):
  - `GET /api/admin/users` → list (never returns `password_hash`).
  - `POST /api/admin/users` `{ email, displayName, password, role }` → create.
  - `PATCH /api/admin/users/:id` `{ displayName?, role?, isActive?, password? }` → update; setting `isActive=false` deletes that user's rows from `sessions`; an admin cannot deactivate or demote their own account (400).
- **Rate limit:** `POST /api/auth/login` capped at 20 requests / 15 min per
  IP (`express-rate-limit`), in addition to the per-account lockout.
- **Logging:** login success/failure and lockouts to the existing `log()`
  helper under tag `auth`, with email and IP, never the password.
- **Bootstrap script** `script/create-admin.ts`: `tsx script/create-admin.ts
  --email … --name … --password …` (or prompts when flags are absent). Refuses
  to run if any user already exists. Documented in CLAUDE.md and SPEC §24.
- **Removals:** `POST /api/verify-password` and the `APP_PASSWORD` read;
  `server/create-user.ts`; `passport` and `passport-local` from
  `package.json`; the `chrome-extension://*` CORS origin. `server/auth.ts`
  is rewritten, not deleted, since the bcrypt helpers are reused.

## Client

- `client/src/components/login-screen.tsx` is replaced, not patched. New
  page: email, password, Remember me checkbox, submit. Error state shows one
  line: "Email or password is incorrect." Locked and disabled accounts see
  the same line. Warm stone palette per SPEC §7.
- `App.tsx` gates the router: on mount call `GET /api/auth/me`; 401 → render
  the login page; 200 → render the app with the user in a context. A 401 from
  any later API call clears the context and shows the login page (session
  expired) — the existing fetch wrapper gets one interceptor.
- Top nav: user's display name + a Log out item in the existing settings
  gear menu.
- Settings → **Users** (admin only; hidden for `member`): table of users
  (name, email, role, active, last login), Add user dialog, per-row edit
  (name, role, active toggle, reset password). No delete — deactivate only.

## Migration and deploy order

1. Commit 1 lands with `049_auth_v1.sql`. Apply locally. Run
   `script/create-admin.ts` locally. Verify login locally.
2. Render: add `SESSION_SECRET` (generate with `openssl rand -hex 32`) to
   the environment **before** the auto-deploy of commit 1 picks it up — or
   set Auto-Deploy to manual for this one push.
3. After `pg_dump`/`pg_restore` (SPEC §24), the restored database already
   contains `users` with Maria's local admin row and the `sessions` table.
   No bootstrap needed on Render. Log in, create the partner's account in
   Settings → Users.

## Commits

1. **`auth: users/sessions schema, session middleware, login/logout/me, requireAuth on /api, bootstrap script`** — server only. Removes `verify-password`, `APP_PASSWORD`, `create-user.ts`, passport, the extension CORS origin. SPEC §24 env table gains `SESSION_SECRET`; a new SPEC §25 "Authentication" records the rule, data model, and lockout policy. Tests: login success / wrong password / unknown email / disabled / locked (5th attempt locks; 6th is rejected without a bcrypt compare); `requireAuth` 401 on a sample of existing routes; `/health` still 200 without a session; `create-admin` refuses when a user exists.
2. **`auth: login page, app gate, logout, 401 interceptor`** — client only. Tests: router renders login on 401 from `/me`; a 401 mid-session returns to login.
3. **`auth: admin Users page and /api/admin/users routes`** — both sides. Tests: member gets 403 on admin routes; admin cannot deactivate self; deactivation clears sessions.

Each: diff → approval → commit. SPEC before or with code.

## Pre-implementation check (read-only, Code reports before commit 1)

- Confirm the extension's server routes (`POST /api/import-asin` and any
  sibling) and whether `refresh_runs` shows any `extension`-trigger rows in
  the last 30 days. Report only; the routes stay and get `requireAuth` like
  everything else.
- Confirm `express-session`, `connect-pg-simple`, `bcrypt`, `express-rate-limit`
  versions present (add `express-rate-limit` if absent) and that
  `@types/express-session` is available.
- Confirm the client's fetch wrapper location (where the 401 interceptor
  goes).

## Out of scope (explicitly)

- VA-restricted view / per-route permission enforcement beyond the admin
  page — on hold.
- Password reset by email (no outbound email yet — pinned).
- MFA.
- Ledger attribution of syncs to users.
- Chrome extension authentication (rebuild).
