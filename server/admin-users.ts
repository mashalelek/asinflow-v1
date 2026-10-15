// Admin user management (SPEC §25, commit 3). Settings → Users is the ONLY
// way to create further accounts (decision 4); the bootstrap script refuses
// once any user exists. No delete anywhere — deactivate only.
//
// Mounted in index.ts AFTER requireAuth on /api, and scoped here to
// requireRole('admin') on /api/admin, so a member gets 403 and an anonymous
// request never reaches this file.
//
// Express-free core (listUsers / createUser / updateUser) with an injected
// query, like auth.ts; never imports ./index.
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import { requireRole, hashPassword, normalizeEmail, BCRYPT_COST, type UserRole } from "./auth";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Thrown by the core; the router maps status/code onto the response. */
export class AdminUserError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

const SELECT_COLS = `id, email, display_name, role, is_active, last_login_at, created_at`;

function toAdmin(row: any): AdminUser {
  return {
    id: Number(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as UserRole,
    isActive: row.is_active === true,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const ROLES: ReadonlySet<string> = new Set(["admin", "member"]);
export const MIN_PASSWORD_LENGTH = 8;

export async function listUsers(query: QueryLike = defaultQuery as any): Promise<AdminUser[]> {
  // password_hash is NEVER selected here, by construction.
  const r = await query(`SELECT ${SELECT_COLS} FROM users ORDER BY created_at, id`);
  return r.rows.map(toAdmin);
}

export async function createUser(
  input: { email?: unknown; displayName?: unknown; password?: unknown; role?: unknown },
  deps: { query?: QueryLike; cost?: number } = {},
): Promise<AdminUser> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const email = normalizeEmail(typeof input.email === "string" ? input.email : "");
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const role = typeof input.role === "string" ? input.role : "member";
  if (!email || !email.includes("@")) throw new AdminUserError(400, "invalid_email");
  if (!displayName) throw new AdminUserError(400, "display_name_required");
  if (password.length < MIN_PASSWORD_LENGTH) throw new AdminUserError(400, "password_too_short");
  if (!ROLES.has(role)) throw new AdminUserError(400, "invalid_role");

  const dup = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if ((dup.rowCount ?? dup.rows.length) > 0) throw new AdminUserError(409, "email_taken");

  const hash = await hashPassword(password, deps.cost ?? BCRYPT_COST);
  try {
    const r = await query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING ${SELECT_COLS}`,
      [email, displayName, hash, role],
    );
    return toAdmin(r.rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") throw new AdminUserError(409, "email_taken"); // unique race
    throw err;
  }
}

export async function updateUser(
  id: number,
  patch: { displayName?: unknown; role?: unknown; isActive?: unknown; password?: unknown },
  actorId: number,
  deps: { query?: QueryLike; cost?: number } = {},
): Promise<AdminUser> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const sets: string[] = [];
  const values: any[] = [];
  let i = 1;

  if (patch.displayName !== undefined) {
    const v = typeof patch.displayName === "string" ? patch.displayName.trim() : "";
    if (!v) throw new AdminUserError(400, "display_name_required");
    sets.push(`display_name = $${i++}`); values.push(v);
  }
  if (patch.role !== undefined) {
    if (typeof patch.role !== "string" || !ROLES.has(patch.role)) throw new AdminUserError(400, "invalid_role");
    // An admin cannot demote their own account (patch: 400).
    if (id === actorId && patch.role !== "admin") throw new AdminUserError(400, "cannot_modify_self");
    sets.push(`role = $${i++}`); values.push(patch.role);
  }
  if (patch.isActive !== undefined) {
    if (typeof patch.isActive !== "boolean") throw new AdminUserError(400, "invalid_is_active");
    // An admin cannot deactivate their own account (patch: 400).
    if (id === actorId && patch.isActive === false) throw new AdminUserError(400, "cannot_modify_self");
    sets.push(`is_active = $${i++}`); values.push(patch.isActive);
  }
  if (patch.password !== undefined) {
    const pw = typeof patch.password === "string" ? patch.password : "";
    if (pw.length < MIN_PASSWORD_LENGTH) throw new AdminUserError(400, "password_too_short");
    sets.push(`password_hash = $${i++}`); values.push(await hashPassword(pw, deps.cost ?? BCRYPT_COST));
  }
  if (sets.length === 0) throw new AdminUserError(400, "nothing_to_update");

  sets.push(`updated_at = NOW()`);
  values.push(id);
  const r = await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${SELECT_COLS}`, values);
  if (r.rows.length === 0) throw new AdminUserError(404, "not_found");

  // Deactivation revokes every session of that user (patch: "setting
  // isActive=false deletes that user's rows from sessions"). The store keeps
  // the express-session JSON in `sess`; userId is what auth.ts wrote there.
  if (patch.isActive === false) {
    await query(`DELETE FROM sessions WHERE (sess->>'userId')::int = $1`, [id]);
  }
  return toAdmin(r.rows[0]);
}

export function createAdminUsersRouter(deps: { query?: QueryLike; cost?: number } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();
  // Scoped to the prefix: this router sits at the app root, so an unscoped
  // router.use(requireRole) would gate every request passing through it.
  router.use("/api/admin", requireRole("admin"));

  const send = (res: Response, err: any) => {
    if (err instanceof AdminUserError) { res.status(err.status).json({ error: err.code }); return; }
    res.status(500).json({ error: "admin_users_failed", message: err?.message ?? String(err) });
  };

  router.get("/api/admin/users", async (_req: Request, res: Response) => {
    try { res.json({ users: await listUsers(query) }); } catch (err) { send(res, err); }
  });

  router.post("/api/admin/users", async (req: Request, res: Response) => {
    try { res.status(201).json({ user: await createUser(req.body ?? {}, { query, cost: deps.cost }) }); }
    catch (err) { send(res, err); }
  });

  router.patch("/api/admin/users/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
    const actorId = Number(req.session?.userId);
    try { res.json({ user: await updateUser(id, req.body ?? {}, actorId, { query, cost: deps.cost }) }); }
    catch (err) { send(res, err); }
  });

  return router;
}
