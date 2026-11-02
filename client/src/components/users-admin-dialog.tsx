/**
 * Settings → Users (SPEC §25, commit 3). Admin only — the settings dialog
 * shows the entry point only for an admin, and the server 403s a member.
 *
 * Table of users (name, email, role, active, last login), Add user, per-row
 * edit (name, role, active toggle, reset password). NO delete — deactivate
 * only (decision 4). The signed-in admin's own row cannot be deactivated or
 * demoted here; the server enforces the same rule.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserPlus, Pencil } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import type { UserRole } from "@/lib/auth";
import {
  listUsers, createUser, updateUser, validateNewUser, validatePassword, type AdminUser,
} from "@/lib/admin-users-api";

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function UsersAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try { setUsers(await listUsers()); }
    catch (err: any) { setError(err?.message ?? "Could not load users."); }
  }, []);

  useEffect(() => { if (open) void reload(); }, [open, reload]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogId="users-admin" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Users</DialogTitle>
          <DialogDescription>
            Accounts that can sign in. Deactivate instead of deleting; a deactivated account is signed out everywhere.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{users ? `${users.length} account${users.length === 1 ? "" : "s"}` : "Loading…"}</p>
          <Button size="sm" onClick={() => setAdding(true)} data-testid="button-add-user">
            <UserPlus className="h-4 w-4 mr-1.5" /> Add user
          </Button>
        </div>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        {users && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} className={u.isActive ? "" : "opacity-60"} data-testid={`row-user-${u.id}`}>
                  <TableCell className="font-medium">
                    {u.displayName}
                    {me?.id === u.id && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">you</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell><Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge></TableCell>
                  <TableCell>{u.isActive ? "Yes" : "No"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{fmtDate(u.lastLoginAt)}</TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => setEditing(u)} data-testid={`button-edit-user-${u.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <AddUserDialog open={adding} onOpenChange={setAdding} onCreated={() => { setAdding(false); void reload(); }} />
        <EditUserDialog user={editing} isSelf={editing != null && me?.id === editing.id} onOpenChange={(v) => { if (!v) setEditing(null); }} onSaved={() => { setEditing(null); void reload(); }} />
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setEmail(""); setDisplayName(""); setPassword(""); setRole("member"); setErrors([]); } }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateNewUser({ email, displayName, password });
    if (v.length > 0) { setErrors(v); return; }
    setSaving(true);
    setErrors([]);
    try {
      await createUser({ email: email.trim(), displayName: displayName.trim(), password, role });
      onCreated();
    } catch (err: any) {
      setErrors([err?.message ?? "Could not create the user."]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogId="user-add" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Share the password with them directly; it is not emailed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-name">Display name</Label>
            <Input id="new-user-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus data-testid="input-new-user-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-email">Email</Label>
            <Input id="new-user-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-new-user-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-password">Password</Label>
            <Input id="new-user-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-new-user-password" />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
              <SelectTrigger data-testid="select-new-user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {errors.length > 0 && (
            <ul className="text-sm text-destructive space-y-0.5" role="alert">{errors.map((m) => <li key={m}>{m}</li>)}</ul>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving} data-testid="button-create-user">{saving ? "Creating…" : "Create user"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, isSelf, onOpenChange, onSaved }: {
  user: AdminUser | null; isSelf: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) { setDisplayName(user.displayName); setRole(user.role); setIsActive(user.isActive); setPassword(""); setError(null); }
  }, [user]);

  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: Parameters<typeof updateUser>[1] = {};
    if (displayName.trim() !== user.displayName) patch.displayName = displayName.trim();
    if (role !== user.role) patch.role = role;
    if (isActive !== user.isActive) patch.isActive = isActive;
    if (password) {
      const pwErr = validatePassword(password);
      if (pwErr) { setError(pwErr); return; }
      patch.password = password;
    }
    if (Object.keys(patch).length === 0) { onOpenChange(false); return; }
    setSaving(true);
    setError(null);
    try {
      await updateUser(user.id, patch);
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={onOpenChange}>
      <DialogContent dialogId="user-edit" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {user.displayName}</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-name">Display name</Label>
            <Input id="edit-user-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="input-edit-user-name" />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)} disabled={isSelf}>
              <SelectTrigger data-testid="select-edit-user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && <p className="text-[10px] text-muted-foreground">You cannot change your own role.</p>}
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="edit-user-active" className="text-sm">Active</Label>
              <p className="text-[10px] text-muted-foreground">{isSelf ? "You cannot deactivate your own account." : "Off signs the user out everywhere and blocks sign-in."}</p>
            </div>
            <Switch id="edit-user-active" checked={isActive} onCheckedChange={setIsActive} disabled={isSelf} data-testid="switch-edit-user-active" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-password">Reset password</Label>
            <Input id="edit-user-password" type="password" autoComplete="new-password" placeholder="Leave blank to keep the current one" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-edit-user-password" />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving} data-testid="button-save-user">{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
