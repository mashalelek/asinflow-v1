/**
 * Auth context (SPEC §25, commit 2).
 *
 * On mount: GET /api/auth/me once. 401 → the login page; 200 → the app with
 * the user available via useAuth(). A 401 from ANY later /api call (other
 * than /api/auth/*) means the session expired or was revoked: the global
 * fetch interceptor flips the state back to anonymous and the login page
 * replaces the app. All transitions go through the pure reducer in
 * lib/auth.ts, which is what the unit tests exercise.
 */
import { createContext, useContext, useEffect, useReducer, useCallback, type ReactNode } from "react";
import {
  authReducer, INITIAL_AUTH_STATE, fetchMe, loginRequest, logoutRequest,
  installUnauthorizedInterceptor,
  type AuthState, type AuthUser, type LoginResult,
} from "@/lib/auth";

interface AuthCtx {
  state: AuthState;
  /** The user when authenticated; null otherwise. */
  user: AuthUser | null;
  login: (input: { email: string; password: string; remember: boolean }) => Promise<LoginResult>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, INITIAL_AUTH_STATE);

  // Install the 401 interceptor FIRST, so even the initial /me and any
  // concurrent fetch are covered; uninstall on unmount.
  useEffect(() => installUnauthorizedInterceptor(() => dispatch({ type: "unauthorized" })), []);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user) => { if (!cancelled) dispatch(user ? { type: "me-ok", user } : { type: "me-401" }); })
      .catch(() => { if (!cancelled) dispatch({ type: "me-401" }); });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (input: { email: string; password: string; remember: boolean }) => {
    const r = await loginRequest(input);
    if (r.ok) dispatch({ type: "login-ok", user: r.user });
    return r;
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    dispatch({ type: "logout" });
  }, []);

  const value: AuthCtx = {
    state,
    user: state.status === "authenticated" ? state.user : null,
    login,
    logout,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
