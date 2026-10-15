// Authentication v1 (SPEC §25; patch docs/claude_spec-patch-auth-v1.md,
// 2026-10-14).
//
// RULE: every request is either authenticated by a valid session or answered
// with 401 (API) / the login page (UI). `GET /health` is the only exception.
//
// Layout:
//   - pure-ish core (attemptLogin, createFirstAdmin, hashPassword) takes an
//     injected query so the lockout policy is unit-tested without Postgres;
//   - Express pieces (session middleware, auth router, requireAuth,
//     requireRole, login rate limiter) are thin and composed in index.ts in
//     the order: health → session → auth routes → requireAuth → routes → static.
//
// Lockout (decision 2): 5 consecutive failures lock the account 15 minutes.
// While locked, every attempt is rejected WITHOUT a bcrypt compare and does
// not extend the lock. Success resets the counter. Per account, not per IP;
// the per-IP cap is the separate rate limiter below.
//
// The 401 body for every rejection is the same `invalid_credentials` —
// unknown email, wrong password, disabled and locked are indistinguishable
// to the caller. The server log (tag `auth`) records which.
import bcrypt from "bcrypt";
import express, { type Request, type Response, type NextFunction, type RequestHandler, type Router } from "express";
import session, { type Store } from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import type pg from "pg";
import { query as defaultQuery } from "./db";
import { log } from "./index";

export const BCRYPT_COST = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const REMEMBER_ME_MS = 30 * 24 * 60 * 60 * 1000; // decision 1: 30 days
export const SESSION_COOKIE_NAME = "af.sid";
export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT = 20;

export type UserRole = "admin" | "member";

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
}

declare module "express-session" {
  interface SessionData {
    userId: number;
    role: UserRole;
  }
}

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

export async function hashPassword(password: string, cost: number = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(password, cost);
}

function toPublic(row: any): PublicUser {
  return { id: Number(row.id), email: String(row.email), displayName: String(row.display_name), role: row.role as UserRole };
}

// ── Login core ───────────────────────────────────────────────────────────────

export type LoginRejection = "unknown_email" | "wrong_password" | "disabled" | "locked" | "locked_now";

export type LoginOutcome =
  | { kind: "ok"; user: PublicUser }
  | { kind: "rejected"; reason: LoginRejection; failedLogins?: number };

export async function attemptLogin(
  emailRaw: string,
  password: string,
  deps: {
    query?: QueryLike;
    compare?: (password: string, hash: string) => Promise<boolean>;
    now?: () => Date;
  } = {},
): Promise<LoginOutcome> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const compare = deps.compare ?? bcrypt.compare;
  const now = deps.now ?? (() => new Date());
  const email = normalizeEmail(emailRaw);

  const r = await query(
    `SELECT id, email, display_name, password_hash, role, is_active, failed_logins, locked_until
       FROM users WHERE email = $1`,
    [email],
  );
  const row = r.rows[0];
  if (!row) return { kind: "rejected", reason: "unknown_email" };
  if (row.is_active !== true) return { kind: "rejected", reason: "disabled" };

  // Locked: rejected before any compare, and the lock is NOT extended.
  if (row.locked_until != null && new Date(row.locked_until).getTime() > now().getTime()) {
    return { kind: "rejected", reason: "locked", failedLogins: Number(row.failed_logins) };
  }

  const ok = await compare(password, String(row.password_hash));
  if (!ok) {
    const failed = Number(row.failed_logins ?? 0) + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      await query(
        `UPDATE users SET failed_logins = $2, locked_until = $3, updated_at = NOW() WHERE id = $1`,
        [row.id, failed, new Date(now().getTime() + LOCKOUT_MINUTES * 60 * 1000)],
      );
      return { kind: "rejected", reason: "locked_now", failedLogins: failed };
    }
    await query(`UPDATE users SET failed_logins = $2, updated_at = NOW() WHERE id = $1`, [row.id, failed]);
    return { kind: "rejected", reason: "wrong_password", failedLogins: failed };
  }

  await query(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [row.id],
  );
  return { kind: "ok", user: toPublic(row) };
}

/** Fresh read for GET /api/auth/me; null when the row is gone or disabled. */
export async function loadActiveUser(id: number, query: QueryLike = defaultQuery as any): Promise<PublicUser | null> {
  const r = await query(`SELECT id, email, display_name, role, is_active FROM users WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row || row.is_active !== true) return null;
  return toPublic(row);
}

// ── Bootstrap (decision 3) ───────────────────────────────────────────────────

/**
 * Create the first admin. Refuses when ANY user exists — further accounts are
 * made in Settings → Users, never by script.
 */
export async function createFirstAdmin(
  input: { email: string; displayName: string; password: string },
  deps: { query?: QueryLike; cost?: number } = {},
): Promise<PublicUser> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const email = normalizeEmail(input.email);
  const displayName = String(input.displayName ?? "").trim();
  if (!email || !email.includes("@")) throw new Error("email is required");
  if (!displayName) throw new Error("display name is required");
  if (!input.password || input.password.length < 8) throw new Error("password must be at least 8 characters");

  const existing = await query(`SELECT count(*)::int AS n FROM users`);
  const n = Number(existing.rows[0]?.n ?? 0);
  if (n > 0) throw new Error(`refusing: ${n} user(s) already exist — create further accounts in Settings → Users`);

  const hash = await hashPassword(input.password, deps.cost ?? BCRYPT_COST);
  const r = await query(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     RETURNING id, email, display_name, role`,
    [email, displayName, hash],
  );
  return toPublic(r.rows[0]);
}

// ── Express pieces ───────────────────────────────────────────────────────────

export function createSessionMiddleware(opts: {
  secret: string;
  isProduction: boolean;
  pool?: pg.Pool;
  /** Test seam: an in-memory store instead of connect-pg-simple. */
  store?: Store;
}): RequestHandler {
  let store: Store | undefined = opts.store;
  if (!store) {
    if (!opts.pool) throw new Error("createSessionMiddleware: pool is required without an explicit store");
    const PgStore = connectPgSimple(session);
    store = new PgStore({
      pool: opts.pool,
      tableName: "sessions",
      createTableIfMissing: false, // migration 049 owns the table
      // Server-side ceiling for a browser-session cookie (no maxAge): the
      // row lives at most as long as a Remember-me session would.
      ttl: REMEMBER_ME_MS / 1000,
    });
  }
  return session({
    name: SESSION_COOKIE_NAME,
    secret: opts.secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.isProduction,
      // No maxAge here: browser-session by default. Login sets maxAge when
      // `remember` is true (decision 1).
    },
  });
}

export const loginRateLimiter: RequestHandler = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  limit: LOGIN_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.userId != null) { next(); return; }
  res.status(401).json({ error: "unauthenticated" });
}

export function requireRole(role: UserRole): RequestHandler {
  return (req, res, next) => {
    if (req.session?.userId == null) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.session.role !== role) { res.status(403).json({ error: "forbidden" }); return; }
    next();
  };
}

function clientIp(req: Request): string {
  return String(req.ip ?? req.socket?.remoteAddress ?? "?");
}

/**
 * POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me. All three
 * are mounted BEFORE requireAuth; they are unauthenticated by nature.
 */
export function createAuthRouter(deps: { query?: QueryLike; limiter?: RequestHandler | null } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();
  const limiter = deps.limiter === undefined ? loginRateLimiter : deps.limiter;

  const loginHandlers: RequestHandler[] = limiter ? [limiter] : [];
  router.post("/api/auth/login", ...loginHandlers, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; remember?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const remember = body.remember === true;
    const ip = clientIp(req);
    if (!email || !password) {
      log(`login rejected (missing fields) email=${normalizeEmail(email) || "?"} ip=${ip}`, "auth");
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    let outcome: LoginOutcome;
    try {
      outcome = await attemptLogin(email, password, { query });
    } catch (err: any) {
      log(`login error email=${normalizeEmail(email)} ip=${ip}: ${err?.message ?? err}`, "auth");
      res.status(500).json({ error: "login_failed" });
      return;
    }

    if (outcome.kind === "rejected") {
      const extra = outcome.failedLogins != null ? ` failed_logins=${outcome.failedLogins}` : "";
      const verb = outcome.reason === "locked_now" ? "LOCKED" : "rejected";
      log(`login ${verb} (${outcome.reason}) email=${normalizeEmail(email)} ip=${ip}${extra}`, "auth");
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const user = outcome.user;
    // Regenerate the session id on login (fixation guard), then populate.
    req.session.regenerate((err) => {
      if (err) {
        log(`session regenerate failed email=${user.email} ip=${ip}: ${err?.message ?? err}`, "auth");
        res.status(500).json({ error: "login_failed" });
        return;
      }
      req.session.userId = user.id;
      req.session.role = user.role;
      if (remember) req.session.cookie.maxAge = REMEMBER_ME_MS;
      req.session.save((saveErr) => {
        if (saveErr) {
          log(`session save failed email=${user.email} ip=${ip}: ${saveErr?.message ?? saveErr}`, "auth");
          res.status(500).json({ error: "login_failed" });
          return;
        }
        log(`login ok email=${user.email} role=${user.role} remember=${remember} ip=${ip}`, "auth");
        res.json({ user });
      });
    });
  });

  router.post("/api/auth/logout", (req: Request, res: Response) => {
    const email = req.session?.userId != null ? `user_id=${req.session.userId}` : "no_session";
    const finish = () => {
      res.clearCookie(SESSION_COOKIE_NAME);
      res.status(204).end();
    };
    if (!req.session) { finish(); return; }
    req.session.destroy((err) => {
      if (err) log(`logout destroy error ${email}: ${err?.message ?? err}`, "auth");
      else log(`logout ${email} ip=${clientIp(req)}`, "auth");
      finish();
    });
  });

  router.get("/api/auth/me", async (req: Request, res: Response) => {
    const id = req.session?.userId;
    if (id == null) { res.status(401).json({ error: "unauthenticated" }); return; }
    let user: PublicUser | null = null;
    try {
      user = await loadActiveUser(id, query);
    } catch (err: any) {
      log(`me lookup error user_id=${id}: ${err?.message ?? err}`, "auth");
      res.status(500).json({ error: "lookup_failed" });
      return;
    }
    if (!user) {
      // Row gone or disabled since the session was issued: end it.
      req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE_NAME);
        res.status(401).json({ error: "unauthenticated" });
      });
      return;
    }
    // Keep the session's role current with the row (admin ↔ member edits).
    req.session.role = user.role;
    res.json({ user });
  });

  return router;
}
