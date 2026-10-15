import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcrypt";
import { MemoryStore } from "express-session";
import { readFileSync } from "fs";
import { join } from "path";

// Deliberately NO vi.mock("./index") here. auth.ts must not import the entry
// module at all — script/create-admin.ts loads auth.ts, and importing index.ts
// boots Express (the 2026-10-14 bootstrap created the admin, then tried to
// bind port 3000). If auth.ts ever regains that import, this suite boots the
// server and the source checks below fail first.

import {
  attemptLogin,
  createFirstAdmin,
  createAuthRouter,
  createSessionMiddleware,
  requireAuth,
  requireRole,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  SESSION_COOKIE_NAME,
} from "./auth";

// ── In-memory users table + a query shim that understands the SQL auth.ts
// issues. Keeps the lockout policy testable without Postgres (the same
// injected-query pattern the other repos use).
type UserRow = {
  id: number; email: string; display_name: string; password_hash: string; role: string;
  is_active: boolean; failed_logins: number; locked_until: Date | null; last_login_at: Date | null;
};

function makeDb(seed: UserRow[] = []) {
  const users = new Map<number, UserRow>(seed.map((u) => [u.id, { ...u }]));
  let nextId = Math.max(0, ...seed.map((u) => u.id)) + 1;
  const query = async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, email, display_name, password_hash")) {
      const row = Array.from(users.values()).find((u) => u.email === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith("SELECT id, email, display_name, role, is_active FROM users WHERE id")) {
      const row = users.get(Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith("SELECT count(*)::int AS n FROM users")) {
      return { rows: [{ n: users.size }], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET failed_logins = $2, locked_until = $3")) {
      const u = users.get(Number(params[0]))!; u.failed_logins = params[1]; u.locked_until = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET failed_logins = $2, updated_at")) {
      const u = users.get(Number(params[0]))!; u.failed_logins = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET failed_logins = 0, locked_until = NULL")) {
      const u = users.get(Number(params[0]))!; u.failed_logins = 0; u.locked_until = null; u.last_login_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO users")) {
      const row: UserRow = {
        id: nextId++, email: params[0], display_name: params[1], password_hash: params[2], role: "admin",
        is_active: true, failed_logins: 0, locked_until: null, last_login_at: null,
      };
      users.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unhandled SQL in test shim: ${s.slice(0, 80)}`);
  };
  return { users, query };
}

// Cost 4 keeps the suite fast; the policy under test does not depend on cost.
const PASSWORD = "correct horse battery";
let HASH = "";
beforeEach(async () => { if (!HASH) HASH = await bcrypt.hash(PASSWORD, 4); });

function maria(over: Partial<UserRow> = {}): UserRow {
  return {
    id: 1, email: "maria@example.com", display_name: "Maria", password_hash: HASH, role: "admin",
    is_active: true, failed_logins: 0, locked_until: null, last_login_at: null, ...over,
  };
}

describe("auth.ts and create-admin stay Express-free", () => {
  const importsIndex = /from\s+["']\.\.?\/(server\/)?index["']/;
  it("server/auth.ts does not import ./index", () => {
    expect(readFileSync(join(__dirname, "auth.ts"), "utf8")).not.toMatch(importsIndex);
  });
  it("script/create-admin.ts does not import server/index", () => {
    expect(readFileSync(join(__dirname, "..", "script", "create-admin.ts"), "utf8")).not.toMatch(importsIndex);
  });
  it("auth.ts logs through the injected logger, never a direct ./index log", () => {
    const src = readFileSync(join(__dirname, "auth.ts"), "utf8");
    expect(src).toMatch(/export function setAuthLogger/);
    // Bare `log(` only — authLog( and the console.log fallback are allowed.
    expect(src).not.toMatch(/(^|[^a-zA-Z.])log\(`/m);
  });
});

describe("attemptLogin — credentials and lockout (SPEC §25 decision 2)", () => {
  it("success returns the public user, resets the counter and stamps last_login_at", async () => {
    const db = makeDb([maria({ failed_logins: 3 })]);
    const out = await attemptLogin("  Maria@Example.com ", PASSWORD, { query: db.query });
    expect(out).toEqual({ kind: "ok", user: { id: 1, email: "maria@example.com", displayName: "Maria", role: "admin" } });
    expect(db.users.get(1)!.failed_logins).toBe(0);
    expect(db.users.get(1)!.last_login_at).toBeInstanceOf(Date);
  });

  it("wrong password is rejected and increments failed_logins", async () => {
    const db = makeDb([maria()]);
    const out = await attemptLogin("maria@example.com", "nope", { query: db.query });
    expect(out).toEqual({ kind: "rejected", reason: "wrong_password", failedLogins: 1 });
    expect(db.users.get(1)!.locked_until).toBeNull();
  });

  it("unknown email is rejected without touching anything", async () => {
    const db = makeDb([maria()]);
    const compare = vi.fn(async () => true);
    const out = await attemptLogin("nobody@example.com", PASSWORD, { query: db.query, compare });
    expect(out).toEqual({ kind: "rejected", reason: "unknown_email" });
    expect(compare).not.toHaveBeenCalled();
  });

  it("disabled account is rejected even with the right password, no compare", async () => {
    const db = makeDb([maria({ is_active: false })]);
    const compare = vi.fn(async () => true);
    const out = await attemptLogin("maria@example.com", PASSWORD, { query: db.query, compare });
    expect(out).toEqual({ kind: "rejected", reason: "disabled" });
    expect(compare).not.toHaveBeenCalled();
  });

  it(`the ${MAX_FAILED_LOGINS}th consecutive failure locks for ${LOCKOUT_MINUTES} min; the next attempt is refused without a compare and does not extend the lock`, async () => {
    const db = makeDb([maria()]);
    const t0 = new Date("2026-10-14T12:00:00Z");
    let now = t0;
    const realCompare = (p: string, h: string) => bcrypt.compare(p, h);
    const compare = vi.fn(realCompare);
    const deps = { query: db.query, compare, now: () => now };

    for (let i = 1; i < MAX_FAILED_LOGINS; i++) {
      const out = await attemptLogin("maria@example.com", "nope", deps);
      expect(out).toEqual({ kind: "rejected", reason: "wrong_password", failedLogins: i });
    }
    const fifth = await attemptLogin("maria@example.com", "nope", deps);
    expect(fifth).toEqual({ kind: "rejected", reason: "locked_now", failedLogins: MAX_FAILED_LOGINS });
    const lockedUntil = db.users.get(1)!.locked_until!;
    expect(lockedUntil.getTime()).toBe(t0.getTime() + LOCKOUT_MINUTES * 60 * 1000);
    expect(compare).toHaveBeenCalledTimes(MAX_FAILED_LOGINS);

    // 6th: correct password, still locked → rejected, no compare, lock unchanged.
    now = new Date(t0.getTime() + 60 * 1000);
    const sixth = await attemptLogin("maria@example.com", PASSWORD, deps);
    expect(sixth.kind).toBe("rejected");
    expect((sixth as any).reason).toBe("locked");
    expect(compare).toHaveBeenCalledTimes(MAX_FAILED_LOGINS);
    expect(db.users.get(1)!.locked_until!.getTime()).toBe(lockedUntil.getTime());

    // After the window: the correct password logs in and clears the lock.
    now = new Date(lockedUntil.getTime() + 1000);
    const after = await attemptLogin("maria@example.com", PASSWORD, deps);
    expect(after.kind).toBe("ok");
    expect(db.users.get(1)!.locked_until).toBeNull();
    expect(db.users.get(1)!.failed_logins).toBe(0);
  });
});

describe("createFirstAdmin — bootstrap (decision 3)", () => {
  it("creates the admin on an empty table", async () => {
    const db = makeDb();
    const u = await createFirstAdmin({ email: "Maria@Example.com", displayName: "Maria", password: "long enough pw" }, { query: db.query, cost: 4 });
    expect(u).toEqual({ id: 1, email: "maria@example.com", displayName: "Maria", role: "admin" });
    expect(db.users.get(1)!.password_hash).not.toBe("long enough pw");
  });

  it("refuses when any user already exists", async () => {
    const db = makeDb([maria()]);
    await expect(
      createFirstAdmin({ email: "x@example.com", displayName: "X", password: "long enough pw" }, { query: db.query, cost: 4 }),
    ).rejects.toThrow(/refusing: 1 user/);
    expect(db.users.size).toBe(1);
  });

  it("rejects a short password before touching the table", async () => {
    const db = makeDb();
    await expect(
      createFirstAdmin({ email: "x@example.com", displayName: "X", password: "short" }, { query: db.query, cost: 4 }),
    ).rejects.toThrow(/at least 8/);
    expect(db.users.size).toBe(0);
  });
});

// ── HTTP round-trip: the composition index.ts uses, with an in-memory
// session store and the shim DB.
function buildApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.json());
  app.use(createSessionMiddleware({ secret: "test-secret", isProduction: false, store: new MemoryStore() }));
  app.use(createAuthRouter({ query: db.query, limiter: null }));
  app.use("/api", requireAuth);
  app.get("/api/asins", (_req, res) => res.json({ rows: [] }));
  app.get("/api/settings", (_req, res) => res.json({}));
  app.post("/api/refresh", (_req, res) => res.json({ started: true }));
  app.get("/api/admin/ping", requireRole("admin"), (_req, res) => res.json({ admin: true }));
  app.use("/{*path}", (_req, res) => res.status(200).send("<!doctype html>spa"));
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

describe("HTTP: session, requireAuth, /health exemption", () => {
  it("/api routes 401 without a session; /health and the SPA shell do not", async () => {
    const db = makeDb([maria()]);
    await withServer(buildApp(db), async (base) => {
      for (const [m, p] of [["GET", "/api/asins"], ["GET", "/api/settings"], ["POST", "/api/refresh"], ["GET", "/api/admin/ping"]] as const) {
        const r = await fetch(base + p, { method: m });
        expect(r.status, `${m} ${p}`).toBe(401);
        expect(await r.json()).toEqual({ error: "unauthenticated" });
      }
      expect((await fetch(base + "/health")).status).toBe(200);
      expect((await fetch(base + "/asins")).status).toBe(200);
      expect((await fetch(base + "/api/auth/me")).status).toBe(401);
    });
  });

  it("login sets af.sid; the cookie unlocks /api; logout revokes it", async () => {
    const db = makeDb([maria()]);
    await withServer(buildApp(db), async (base) => {
      const bad = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "maria@example.com", password: "nope" }),
      });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: "invalid_credentials" });
      expect(bad.headers.get("set-cookie")).toBeNull();

      const ok = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "maria@example.com", password: PASSWORD, remember: true }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ user: { id: 1, email: "maria@example.com", displayName: "Maria", role: "admin" } });
      const setCookie = ok.headers.get("set-cookie") ?? "";
      expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Expires=/i); // remember: true → 30-day cookie
      const cookie = cookieFrom(ok);

      expect((await fetch(base + "/api/asins", { headers: { cookie } })).status).toBe(200);
      const me = await fetch(base + "/api/auth/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      expect((await me.json()).user.email).toBe("maria@example.com");
      expect((await fetch(base + "/api/admin/ping", { headers: { cookie } })).status).toBe(200);

      const out = await fetch(base + "/api/auth/logout", { method: "POST", headers: { cookie } });
      expect(out.status).toBe(204);
      expect((await fetch(base + "/api/asins", { headers: { cookie } })).status).toBe(401);
    });
  });

  it("remember unticked → browser-session cookie (no Expires)", async () => {
    const db = makeDb([maria()]);
    await withServer(buildApp(db), async (base) => {
      const ok = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "maria@example.com", password: PASSWORD }),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("set-cookie") ?? "").not.toMatch(/Expires=/i);
    });
  });

  it("requireRole: a member gets 403 on an admin route; /me reflects a disabled row by ending the session", async () => {
    const db = makeDb([maria({ role: "member" })]);
    await withServer(buildApp(db), async (base) => {
      const ok = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "maria@example.com", password: PASSWORD }),
      });
      const cookie = cookieFrom(ok);
      const ping = await fetch(base + "/api/admin/ping", { headers: { cookie } });
      expect(ping.status).toBe(403);
      expect(await ping.json()).toEqual({ error: "forbidden" });

      db.users.get(1)!.is_active = false;
      expect((await fetch(base + "/api/auth/me", { headers: { cookie } })).status).toBe(401);
      // The session was destroyed by /me, so even a plain route is now 401.
      expect((await fetch(base + "/api/asins", { headers: { cookie } })).status).toBe(401);
    });
  });
});
