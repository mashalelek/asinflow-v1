import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcrypt";
import { MemoryStore } from "express-session";
import { readFileSync } from "fs";
import { join } from "path";
import { createAuthRouter, createSessionMiddleware, requireAuth } from "./auth";
import { createAdminUsersRouter, createUser, updateUser, listUsers, AdminUserError } from "./admin-users";

// SPEC §25 commit 3: /api/admin/users behind requireAuth + requireRole('admin').
// Same injected-query shim as auth.test.ts, extended with a `sessions`
// table so the deactivation revoke is observable.

type Row = {
  id: number; email: string; display_name: string; password_hash: string; role: string;
  is_active: boolean; failed_logins: number; locked_until: Date | null; last_login_at: Date | null; created_at: Date;
};

function makeDb(seed: Row[]) {
  const users = new Map<number, Row>(seed.map((u) => [u.id, { ...u }]));
  const sessionDeletes: number[] = [];
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
    if (s.startsWith("SELECT id, email, display_name, role, is_active, last_login_at, created_at FROM users ORDER BY")) {
      return { rows: Array.from(users.values()), rowCount: users.size };
    }
    if (s.startsWith("SELECT 1 FROM users WHERE email")) {
      const hit = Array.from(users.values()).some((u) => u.email === params[0]);
      return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (s.startsWith("INSERT INTO users")) {
      const row: Row = {
        id: nextId++, email: params[0], display_name: params[1], password_hash: params[2], role: params[3],
        is_active: true, failed_logins: 0, locked_until: null, last_login_at: null, created_at: new Date(),
      };
      users.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET failed_logins = 0, locked_until = NULL")) {
      const u = users.get(Number(params[0]))!; u.failed_logins = 0; u.last_login_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET ") && s.includes("RETURNING")) {
      const id = Number(params[params.length - 1]);
      const u = users.get(id);
      if (!u) return { rows: [], rowCount: 0 };
      const setList = s.slice("UPDATE users SET ".length, s.indexOf(" WHERE")).split(", ");
      setList.forEach((clause) => {
        const [col, ph] = clause.split(" = ");
        if (ph === "NOW()") return;
        const v = params[Number(ph.slice(1)) - 1];
        (u as any)[col] = v;
      });
      return { rows: [u], rowCount: 1 };
    }
    if (s.startsWith("DELETE FROM sessions WHERE")) {
      sessionDeletes.push(Number(params[0]));
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unhandled SQL in test shim: ${s.slice(0, 90)}`);
  };
  return { users, sessionDeletes, query };
}

const PW = "correct horse battery";
let HASH = "";
beforeAll(async () => { HASH = await bcrypt.hash(PW, 4); });

function row(id: number, email: string, role: string, over: Partial<Row> = {}): Row {
  return {
    id, email, display_name: email.split("@")[0], password_hash: HASH, role,
    is_active: true, failed_logins: 0, locked_until: null, last_login_at: null, created_at: new Date("2026-10-14T00:00:00Z"), ...over,
  };
}

describe("core: createUser / updateUser / listUsers", () => {
  it("listUsers never returns password_hash", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin")]);
    const list = await listUsers(db.query);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "displayName", "email", "id", "isActive", "lastLoginAt", "role"]);
  });

  it("createUser validates and rejects a duplicate email with 409", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin")]);
    await expect(createUser({ email: "nope", displayName: "X", password: "long enough" }, { query: db.query, cost: 4 })).rejects.toMatchObject({ status: 400, code: "invalid_email" });
    await expect(createUser({ email: "x@example.com", displayName: " ", password: "long enough" }, { query: db.query, cost: 4 })).rejects.toMatchObject({ status: 400, code: "display_name_required" });
    await expect(createUser({ email: "x@example.com", displayName: "X", password: "short" }, { query: db.query, cost: 4 })).rejects.toMatchObject({ status: 400, code: "password_too_short" });
    await expect(createUser({ email: "x@example.com", displayName: "X", password: "long enough", role: "root" }, { query: db.query, cost: 4 })).rejects.toMatchObject({ status: 400, code: "invalid_role" });
    await expect(createUser({ email: "MARIA@example.com", displayName: "Dup", password: "long enough" }, { query: db.query, cost: 4 })).rejects.toMatchObject({ status: 409, code: "email_taken" });
    const u = await createUser({ email: "Partner@Example.com", displayName: "Partner", password: "long enough" }, { query: db.query, cost: 4 });
    expect(u).toMatchObject({ id: 2, email: "partner@example.com", displayName: "Partner", role: "member", isActive: true });
    expect(db.users.get(2)!.password_hash).not.toBe("long enough");
  });

  it("updateUser: admin cannot deactivate or demote self (400); can rename self", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin")]);
    await expect(updateUser(1, { isActive: false }, 1, { query: db.query })).rejects.toMatchObject({ status: 400, code: "cannot_modify_self" });
    await expect(updateUser(1, { role: "member" }, 1, { query: db.query })).rejects.toMatchObject({ status: 400, code: "cannot_modify_self" });
    const u = await updateUser(1, { displayName: "Maria L" }, 1, { query: db.query });
    expect(u.displayName).toBe("Maria L");
    expect(db.sessionDeletes).toEqual([]);
  });

  it("updateUser: deactivating another user revokes that user's sessions; 404 for unknown id", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin"), row(2, "partner@example.com", "member")]);
    const u = await updateUser(2, { isActive: false }, 1, { query: db.query });
    expect(u.isActive).toBe(false);
    expect(db.sessionDeletes).toEqual([2]);
    await expect(updateUser(99, { isActive: true }, 1, { query: db.query })).rejects.toMatchObject({ status: 404 });
    await expect(updateUser(2, {}, 1, { query: db.query })).rejects.toMatchObject({ status: 400, code: "nothing_to_update" });
  });

  it("updateUser: password reset re-hashes; short password rejected", async () => {
    const db = makeDb([row(2, "partner@example.com", "member")]);
    const before = db.users.get(2)!.password_hash;
    await updateUser(2, { password: "new long password" }, 1, { query: db.query, cost: 4 });
    expect(db.users.get(2)!.password_hash).not.toBe(before);
    expect(await bcrypt.compare("new long password", db.users.get(2)!.password_hash)).toBe(true);
    await expect(updateUser(2, { password: "tiny" }, 1, { query: db.query, cost: 4 })).rejects.toBeInstanceOf(AdminUserError);
  });
});

// ── HTTP: the index.ts composition ──────────────────────────────────────────
function buildApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use(createSessionMiddleware({ secret: "t", isProduction: false, store: new MemoryStore() }));
  app.use(createAuthRouter({ query: db.query, limiter: null }));
  app.use("/api", requireAuth);
  app.use(createAdminUsersRouter({ query: db.query, cost: 4 }));
  app.get("/api/asins", (_req, res) => res.json({ ok: true }));
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

async function loginAs(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

describe("HTTP: /api/admin/users gating and behaviour", () => {
  it("anonymous → 401; member → 403 on every admin route; non-admin routes unaffected", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin"), row(2, "partner@example.com", "member")]);
    await withServer(buildApp(db), async (base) => {
      expect((await fetch(`${base}/api/admin/users`)).status).toBe(401);
      const cookie = await loginAs(base, "partner@example.com");
      for (const [m, p] of [["GET", "/api/admin/users"], ["POST", "/api/admin/users"], ["PATCH", "/api/admin/users/1"]] as const) {
        const r = await fetch(base + p, { method: m, headers: { cookie, "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" });
        expect(r.status, `${m} ${p}`).toBe(403);
        expect(await r.json()).toEqual({ error: "forbidden" });
      }
      expect((await fetch(`${base}/api/asins`, { headers: { cookie } })).status).toBe(200);
    });
  });

  it("admin: list (no hashes) → create → appears → patch → self-guard 400 → deactivate revokes", async () => {
    const db = makeDb([row(1, "maria@example.com", "admin")]);
    await withServer(buildApp(db), async (base) => {
      const cookie = await loginAs(base, "maria@example.com");
      const hdr = { cookie, "Content-Type": "application/json" };

      const list1 = await (await fetch(`${base}/api/admin/users`, { headers: hdr })).json();
      expect(list1.users).toHaveLength(1);
      expect(JSON.stringify(list1)).not.toMatch(/password|\$2b\$/);

      const created = await fetch(`${base}/api/admin/users`, {
        method: "POST", headers: hdr,
        body: JSON.stringify({ email: "partner@example.com", displayName: "Partner", password: "long enough pw", role: "member" }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).user).toMatchObject({ id: 2, email: "partner@example.com", role: "member", isActive: true });

      const dup = await fetch(`${base}/api/admin/users`, { method: "POST", headers: hdr, body: JSON.stringify({ email: "partner@example.com", displayName: "P", password: "long enough pw" }) });
      expect(dup.status).toBe(409);

      const list2 = await (await fetch(`${base}/api/admin/users`, { headers: hdr })).json();
      expect(list2.users.map((u: any) => u.email)).toEqual(["maria@example.com", "partner@example.com"]);

      const self = await fetch(`${base}/api/admin/users/1`, { method: "PATCH", headers: hdr, body: JSON.stringify({ isActive: false }) });
      expect(self.status).toBe(400);
      expect(await self.json()).toEqual({ error: "cannot_modify_self" });

      const off = await fetch(`${base}/api/admin/users/2`, { method: "PATCH", headers: hdr, body: JSON.stringify({ isActive: false, role: "admin" }) });
      expect(off.status).toBe(200);
      expect((await off.json()).user).toMatchObject({ id: 2, isActive: false, role: "admin" });
      expect(db.sessionDeletes).toEqual([2]);

      expect((await fetch(`${base}/api/admin/users/abc`, { method: "PATCH", headers: hdr, body: "{}" })).status).toBe(400);
      expect((await fetch(`${base}/api/admin/users/77`, { method: "PATCH", headers: hdr, body: JSON.stringify({ displayName: "x" }) })).status).toBe(404);
    });
  });
});

describe("wiring", () => {
  it("index.ts mounts the admin router after requireAuth on /api", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    const a = src.indexOf('app.use("/api", requireAuth)');
    const b = src.indexOf("app.use(createAdminUsersRouter())");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
  it("admin-users.ts never imports ./index and never selects password_hash", () => {
    const src = readFileSync(join(__dirname, "admin-users.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/index["']/);
    expect(src).not.toMatch(/SELECT[^;]*password_hash/i);
    expect(src).not.toMatch(/DELETE FROM users/i); // deactivate only, never delete
  });
});
