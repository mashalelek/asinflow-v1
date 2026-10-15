// Client auth (SPEC §25, commit 2). Pure pieces live here so the gate logic
// and the 401 interceptor are unit-tested in node without a DOM: the
// provider in contexts/auth-context.tsx is a thin React wrapper over these.

export type UserRole = "admin" | "member";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
}

// ── Gate state machine ───────────────────────────────────────────────────────
//
//   loading ──me-ok──▶ authenticated ──unauthorized/logout──▶ anonymous
//      └────me-401──▶ anonymous ──login-ok──▶ authenticated
//
// `unauthorized` is what the fetch interceptor raises when ANY later /api
// call (other than /api/auth/*) answers 401: the session expired or was
// revoked, so the app returns to the login page (patch: "a 401 from any
// later API call clears the context and shows the login page").

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthUser };

export type AuthEvent =
  | { type: "me-ok"; user: AuthUser }
  | { type: "me-401" }
  | { type: "login-ok"; user: AuthUser }
  | { type: "unauthorized" }
  | { type: "logout" };

export const INITIAL_AUTH_STATE: AuthState = { status: "loading" };

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "me-ok":
    case "login-ok":
      return { status: "authenticated", user: event.user };
    case "me-401":
    case "unauthorized":
    case "logout":
      return { status: "anonymous" };
    default:
      return state;
  }
}

// ── 401 interceptor predicate ────────────────────────────────────────────────
//
// Only a same-origin /api/ response (not /api/auth/*, whose own 401s are the
// login form's business) with status 401 means "session gone".

export function isSessionLost401(
  url: string,
  status: number,
  origin: string,
): boolean {
  if (status !== 401) return false;
  let path: string;
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return false;
    path = u.pathname;
  } catch {
    return false;
  }
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/auth/")) return false;
  return true;
}

/**
 * Option A (decided 2026-10-14): wrap window.fetch ONCE instead of migrating
 * the 67 raw fetch() call sites. Every same-origin /api call — raw fetch,
 * fetchLongSync, the NDJSON streams — passes through here. Returns an
 * uninstaller. Idempotent: a second install replaces the first callback
 * rather than wrapping twice.
 */
const INSTALLED = Symbol.for("asinflow.auth.fetch-interceptor");

export function installUnauthorizedInterceptor(
  onUnauthorized: () => void,
  win: { fetch: typeof fetch; location: { origin: string } } & Record<PropertyKey, any> = window as any,
): () => void {
  const existing = win[INSTALLED] as { setCallback: (cb: () => void) => void } | undefined;
  if (existing) {
    existing.setCallback(onUnauthorized);
    return () => existing.setCallback(() => {});
  }
  let callback = onUnauthorized;
  const original = win.fetch; // the very reference, so uninstall restores it exactly
  const wrapped: typeof fetch = async (input, init) => {
    const res = await original.call(win, input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isSessionLost401(url, res.status, win.location.origin)) callback();
    } catch {
      // Never let the interceptor break a response.
    }
    return res;
  };
  win.fetch = wrapped;
  win[INSTALLED] = { setCallback: (cb: () => void) => { callback = cb; } };
  return () => {
    win.fetch = original;
    delete win[INSTALLED];
  };
}

// ── API calls ────────────────────────────────────────────────────────────────

/** GET /api/auth/me → the user, or null on 401. Throws on anything else. */
export async function fetchMe(fetchFn: typeof fetch = fetch): Promise<AuthUser | null> {
  const res = await fetchFn("/api/auth/me", { credentials: "same-origin" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me ${res.status}`);
  const body = await res.json();
  return body.user as AuthUser;
}

export type LoginResult = { ok: true; user: AuthUser } | { ok: false; reason: "invalid_credentials" | "too_many_requests" | "error" };

export async function loginRequest(
  input: { email: string; password: string; remember: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<LoginResult> {
  const res = await fetchFn("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (res.ok) {
    const body = await res.json();
    return { ok: true, user: body.user as AuthUser };
  }
  if (res.status === 401) return { ok: false, reason: "invalid_credentials" };
  if (res.status === 429) return { ok: false, reason: "too_many_requests" };
  return { ok: false, reason: "error" };
}

export async function logoutRequest(fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    await fetchFn("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // The client goes to the login page regardless; the server row is
    // revoked on its own schedule if this call did not land.
  }
}

/** The one line every rejection shows (patch: locked and disabled see it too). */
export const LOGIN_ERROR_TEXT = "Email or password is incorrect.";
export const LOGIN_RATE_TEXT = "Too many attempts from this network. Try again in 15 minutes.";
export const LOGIN_GENERIC_TEXT = "Could not sign in. Try again.";

export function loginErrorText(reason: Exclude<LoginResult, { ok: true }>["reason"]): string {
  if (reason === "too_many_requests") return LOGIN_RATE_TEXT;
  if (reason === "invalid_credentials") return LOGIN_ERROR_TEXT;
  return LOGIN_GENERIC_TEXT;
}
