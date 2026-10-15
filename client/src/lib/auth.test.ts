import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  authReducer, INITIAL_AUTH_STATE, isSessionLost401, installUnauthorizedInterceptor,
  fetchMe, loginRequest, loginErrorText, LOGIN_ERROR_TEXT, LOGIN_RATE_TEXT,
  type AuthUser,
} from "./auth";

// SPEC §25 commit 2 (client). No DOM test runner in this repo, so the gate
// is tested at the reducer + interceptor level (pure), and the wiring in
// App.tsx / top-nav.tsx is pinned by source checks, like the other client
// tests do.

const maria: AuthUser = { id: 1, email: "maria@example.com", displayName: "Maria", role: "admin" };
const ORIGIN = "http://localhost:3000";

describe("authReducer — the gate state machine", () => {
  it("starts loading; /me 200 → authenticated with the user", () => {
    expect(INITIAL_AUTH_STATE).toEqual({ status: "loading" });
    expect(authReducer(INITIAL_AUTH_STATE, { type: "me-ok", user: maria })).toEqual({ status: "authenticated", user: maria });
  });

  it("/me 401 on load → anonymous (the router renders the login page)", () => {
    expect(authReducer(INITIAL_AUTH_STATE, { type: "me-401" })).toEqual({ status: "anonymous" });
  });

  it("login-ok from anonymous → authenticated", () => {
    expect(authReducer({ status: "anonymous" }, { type: "login-ok", user: maria })).toEqual({ status: "authenticated", user: maria });
  });

  it("a 401 mid-session (unauthorized) → anonymous: back to the login page", () => {
    expect(authReducer({ status: "authenticated", user: maria }, { type: "unauthorized" })).toEqual({ status: "anonymous" });
  });

  it("logout → anonymous", () => {
    expect(authReducer({ status: "authenticated", user: maria }, { type: "logout" })).toEqual({ status: "anonymous" });
  });
});

describe("isSessionLost401 — which 401s mean 'session gone'", () => {
  it("same-origin /api/* 401 → yes (relative and absolute URLs alike)", () => {
    expect(isSessionLost401("/api/asins?startDate=x", 401, ORIGIN)).toBe(true);
    expect(isSessionLost401(`${ORIGIN}/api/refresh`, 401, ORIGIN)).toBe(true);
  });
  it("/api/auth/* 401s belong to the login form, not the gate", () => {
    expect(isSessionLost401("/api/auth/login", 401, ORIGIN)).toBe(false);
    expect(isSessionLost401("/api/auth/me", 401, ORIGIN)).toBe(false);
  });
  it("non-401, non-/api, and cross-origin never trigger", () => {
    expect(isSessionLost401("/api/asins", 403, ORIGIN)).toBe(false);
    expect(isSessionLost401("/api/asins", 200, ORIGIN)).toBe(false);
    expect(isSessionLost401("/health", 401, ORIGIN)).toBe(false);
    expect(isSessionLost401("https://api.goaura.com/listings", 401, ORIGIN)).toBe(false);
    expect(isSessionLost401("not a url at all ::", 401, "bad origin")).toBe(false);
  });
});

describe("installUnauthorizedInterceptor — option A, one global wrap", () => {
  function fakeWindow(status: number) {
    const calls: string[] = [];
    const win: any = {
      location: { origin: ORIGIN },
      fetch: vi.fn(async (input: any) => {
        calls.push(typeof input === "string" ? input : input.url);
        return { status, ok: status < 400 } as Response;
      }),
    };
    return { win, calls };
  }

  it("fires the callback on a same-origin /api 401 and still returns the response", async () => {
    const { win } = fakeWindow(401);
    const cb = vi.fn();
    const uninstall = installUnauthorizedInterceptor(cb, win);
    const res = await win.fetch("/api/asins");
    expect(res.status).toBe(401);
    expect(cb).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("does NOT fire for /api/auth/login 401 (wrong password is the form's business)", async () => {
    const { win } = fakeWindow(401);
    const cb = vi.fn();
    installUnauthorizedInterceptor(cb, win);
    await win.fetch("/api/auth/login", { method: "POST" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on 200s, and accepts Request/URL inputs", async () => {
    const { win } = fakeWindow(200);
    const cb = vi.fn();
    installUnauthorizedInterceptor(cb, win);
    await win.fetch(new URL("/api/asins", ORIGIN));
    await win.fetch({ url: `${ORIGIN}/api/tags` } as any);
    expect(cb).not.toHaveBeenCalled();
  });

  it("installs once: a second install swaps the callback instead of double-wrapping; uninstall restores the original", async () => {
    const { win } = fakeWindow(401);
    const original = win.fetch;
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const un1 = installUnauthorizedInterceptor(cb1, win);
    const wrappedOnce = win.fetch;
    installUnauthorizedInterceptor(cb2, win);
    expect(win.fetch).toBe(wrappedOnce); // not wrapped again
    await win.fetch("/api/asins");
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
    un1();
    expect(win.fetch).toBe(original);
  });
});

describe("fetchMe / loginRequest / error text", () => {
  const json = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

  it("fetchMe: 200 → user, 401 → null, 500 → throws", async () => {
    expect(await fetchMe(async () => json(200, { user: maria }))).toEqual(maria);
    expect(await fetchMe(async () => json(401, { error: "unauthenticated" }))).toBeNull();
    await expect(fetchMe(async () => json(500, {}))).rejects.toThrow(/500/);
  });

  it("loginRequest posts email/password/remember and maps 401/429", async () => {
    let sent: any = null;
    const f = vi.fn(async (_u: any, init: any) => { sent = JSON.parse(init.body); return json(200, { user: maria }); });
    expect(await loginRequest({ email: "maria@example.com", password: "pw", remember: true }, f as any)).toEqual({ ok: true, user: maria });
    expect(sent).toEqual({ email: "maria@example.com", password: "pw", remember: true });
    expect(await loginRequest({ email: "x", password: "y", remember: false }, (async () => json(401, {})) as any)).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await loginRequest({ email: "x", password: "y", remember: false }, (async () => json(429, {})) as any)).toEqual({ ok: false, reason: "too_many_requests" });
  });

  it("every credential rejection shows the ONE line; rate limit has its own", () => {
    expect(loginErrorText("invalid_credentials")).toBe(LOGIN_ERROR_TEXT);
    expect(LOGIN_ERROR_TEXT).toBe("Email or password is incorrect.");
    expect(loginErrorText("too_many_requests")).toBe(LOGIN_RATE_TEXT);
  });
});

describe("wiring (source checks)", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("App.tsx gates the Router behind AuthProvider and renders LoginScreen when anonymous", () => {
    const src = read("App.tsx");
    expect(src).toMatch(/<AuthProvider>/);
    expect(src).toMatch(/state\.status === "anonymous"\) return <LoginScreen \/>/);
    expect(src).toMatch(/state\.status === "loading"/);
    expect(src).toMatch(/<AuthGate \/>/);
  });

  it("the provider installs the interceptor once on mount and calls /me once", () => {
    const src = read("contexts/auth-context.tsx");
    expect(src).toMatch(/installUnauthorizedInterceptor\(\(\) => dispatch\(\{ type: "unauthorized" \}\)\), \[\]\)/);
    expect(src).toMatch(/fetchMe\(\)/);
  });

  it("the login page uses the context, not a hand-rolled fetch to a route that does not exist", () => {
    const src = read("components/login-screen.tsx");
    expect(src).toMatch(/useAuth\(\)/);
    expect(src).not.toMatch(/\/api\/login["']/);
    expect(src).toMatch(/Remember me/);
  });

  it("top nav shows the display name and a Log out item", () => {
    const src = read("components/layout/top-nav.tsx");
    expect(src).toMatch(/user\.displayName/);
    expect(src).toMatch(/Log out/);
    expect(src).toMatch(/void logout\(\)/);
  });
});
