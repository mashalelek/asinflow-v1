import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateNewUser, validatePassword, adminErrorText, listUsers, createUser, updateUser, MIN_PASSWORD_LENGTH } from "./admin-users-api";

// SPEC §25 commit 3 (client). Pure validation + API mapping, and source
// checks on the gating/wiring, same approach as auth.test.ts.

describe("validateNewUser / validatePassword", () => {
  it("accepts a complete, valid form", () => {
    expect(validateNewUser({ email: "Partner@Example.com", displayName: "Partner", password: "long enough" })).toEqual([]);
  });
  it("reports every failed rule, in display order", () => {
    expect(validateNewUser({ email: "nope", displayName: " ", password: "short" })).toEqual([
      "Enter a valid email address.",
      "Display name is required.",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    ]);
  });
  it("validatePassword mirrors the server minimum", () => {
    expect(validatePassword("1234567")).toMatch(/at least 8/);
    expect(validatePassword("12345678")).toBeNull();
  });
});

describe("adminErrorText — server codes to one line each", () => {
  it("maps the known codes and falls back sensibly", () => {
    expect(adminErrorText("email_taken", 409)).toMatch(/already has an account/);
    expect(adminErrorText("cannot_modify_self", 400)).toMatch(/your own account/);
    expect(adminErrorText("forbidden", 403)).toMatch(/Only an admin/);
    expect(adminErrorText(undefined, 401)).toMatch(/session ended/);
    expect(adminErrorText("weird", 500)).toMatch(/Something went wrong/);
  });
});

describe("API wrappers", () => {
  const json = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
  const u = { id: 2, email: "p@example.com", displayName: "P", role: "member", isActive: true, lastLoginAt: null, createdAt: "2026-10-14T00:00:00.000Z" };

  it("listUsers unwraps { users }", async () => {
    expect(await listUsers(async () => json(200, { users: [u] }))).toEqual([u]);
  });
  it("createUser POSTs the form and throws the mapped message on 409", async () => {
    let sent: any;
    const f = vi.fn(async (_url: any, init: any) => { sent = { method: init.method, body: JSON.parse(init.body) }; return json(201, { user: u }); });
    expect(await createUser({ email: "p@example.com", displayName: "P", password: "long enough", role: "member" }, f as any)).toEqual(u);
    expect(sent).toEqual({ method: "POST", body: { email: "p@example.com", displayName: "P", password: "long enough", role: "member" } });
    await expect(createUser({ email: "p@example.com", displayName: "P", password: "long enough", role: "member" }, (async () => json(409, { error: "email_taken" })) as any))
      .rejects.toThrow(/already has an account/);
  });
  it("updateUser PATCHes /api/admin/users/:id with only the given fields", async () => {
    let sent: any;
    const f = vi.fn(async (url: any, init: any) => { sent = { url, method: init.method, body: JSON.parse(init.body) }; return json(200, { user: { ...u, isActive: false } }); });
    const r = await updateUser(2, { isActive: false }, f as any);
    expect(r.isActive).toBe(false);
    expect(sent).toEqual({ url: "/api/admin/users/2", method: "PATCH", body: { isActive: false } });
  });
});

describe("wiring (source checks)", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("the settings dialog shows the Users section only to an admin", () => {
    const src = read("components/settings-dialog.tsx");
    expect(src).toMatch(/const isAdmin = user\?\.role === "admin"/);
    expect(src).toMatch(/\{isAdmin && \(/);
    expect(src).toMatch(/<UsersAdminDialog/);
  });

  it("the Users dialog has no delete, and guards the signed-in admin's own row", () => {
    const src = read("components/users-admin-dialog.tsx");
    expect(src).not.toMatch(/method:\s*["']DELETE["']/);
    expect(src).not.toMatch(/\bdeleteUser\b/);
    expect(src).toMatch(/isSelf/);
    expect(src).toMatch(/disabled=\{isSelf\}/);
  });

  it("the client API never sends a password anywhere except create/patch bodies", () => {
    const src = read("lib/admin-users-api.ts");
    expect(src).not.toMatch(/password=/); // never in a query string
  });
});
