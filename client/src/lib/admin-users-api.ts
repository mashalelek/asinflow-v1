// Settings → Users client API + pure form validation (SPEC §25, commit 3).
// Admin-only on the server (403 for a member); the UI hides the section for
// members and the server is the real gate.
import type { UserRole } from "./auth";

export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/** One line per failed rule, in display order. Empty = valid. */
export function validateNewUser(input: { email: string; displayName: string; password: string }): string[] {
  const errors: string[] = [];
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) errors.push("Enter a valid email address.");
  if (!input.displayName.trim()) errors.push("Display name is required.");
  if (input.password.length < MIN_PASSWORD_LENGTH) errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  return errors;
}

export function validatePassword(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` : null;
}

/** The server's error codes, rendered for the dialog. */
export function adminErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case "email_taken": return "That email already has an account.";
    case "cannot_modify_self": return "You cannot deactivate or demote your own account.";
    case "password_too_short": return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "invalid_email": return "Enter a valid email address.";
    case "display_name_required": return "Display name is required.";
    case "invalid_role": return "Role must be admin or member.";
    case "forbidden": return "Only an admin can manage users.";
    case "not_found": return "That user no longer exists.";
    default: return status === 401 ? "Your session ended. Sign in again." : "Something went wrong. Try again.";
  }
}

class ApiError extends Error {
  constructor(public status: number, public code: string | undefined) { super(adminErrorText(code, status)); }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as any)?.error);
  return body as T;
}

export async function listUsers(fetchFn: typeof fetch = fetch): Promise<AdminUser[]> {
  const body = await parse<{ users: AdminUser[] }>(await fetchFn("/api/admin/users", { credentials: "same-origin" }));
  return body.users;
}

export async function createUser(
  input: { email: string; displayName: string; password: string; role: UserRole },
  fetchFn: typeof fetch = fetch,
): Promise<AdminUser> {
  const body = await parse<{ user: AdminUser }>(await fetchFn("/api/admin/users", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
  return body.user;
}

export async function updateUser(
  id: number,
  patch: { displayName?: string; role?: UserRole; isActive?: boolean; password?: string },
  fetchFn: typeof fetch = fetch,
): Promise<AdminUser> {
  const body = await parse<{ user: AdminUser }>(await fetchFn(`/api/admin/users/${id}`, {
    method: "PATCH", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  return body.user;
}
