import { canManageUsers, canModifyUser, type UserRole } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, authApi } from '../../api/client.js';
import { useSession } from '../../auth/SessionProvider.jsx';
import { DANGER_ITEM_CLASS, ITEM_CLASS, RowMenuShell } from '../../components/RowMenuShell.jsx';
import { Alert, Button, Modal, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';
import { SignInActivity } from './SignInActivity.jsx';

/**
 * Settings → Users.
 *
 * Two things, and they are not the same thing. **Your account** is yours
 * whatever role you hold — a display name is not a credential and nothing is
 * looked up by it. **The household** is user management, and every rule in it
 * is enforced in the domain layer rather than at the route, so it cannot be
 * forgotten. This screen mirrors those rules rather than reimplementing them:
 * a control that would certainly be refused is not offered, and anything else
 * that is refused shows the server's own reason.
 *
 * Creating and editing happen in a dialog. They used to be a permanent form at
 * the bottom of the page and a set of inline fields on every row, which meant
 * the common case — reading who has an account — was the hardest thing on the
 * screen to do.
 */

interface UserDto {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly hasTotp: boolean;
  readonly mustChangePassword: boolean;
  readonly archivedAt: string | null;
}

const ROLE_LABELS: Record<UserRole, string> = {
  user: 'User',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

const usersApi = {
  list: () => api.get<{ users: readonly UserDto[] }>('/api/users'),
  create: (input: {
    username: string;
    displayName: string | null;
    temporaryPassword: string;
    role: UserRole;
  }) => api.post<{ user: UserDto }>('/api/users', input),
  update: (
    id: string,
    input: { username?: string; displayName?: string | null; role?: UserRole },
  ) => api.patch<{ user: UserDto }>(`/api/users/${id}`, input),
  resetPassword: (id: string, temporaryPassword: string) =>
    api.post<{ user: UserDto }>(`/api/users/${id}/reset-password`, { temporaryPassword }),
  resetTwoFactor: (id: string) => api.post<{ user: UserDto }>(`/api/users/${id}/reset-two-factor`),
  archive: (id: string) => api.post<{ user: UserDto }>(`/api/users/${id}/archive`),
  restore: (id: string) => api.post<{ user: UserDto }>(`/api/users/${id}/restore`),
};

/**
 * Both lists this page shows, refreshed together.
 *
 * Every action here is one the activity card below records, so refreshing the
 * table without it would leave a password reset visible in one half of the
 * screen and absent from the other.
 */
function invalidateHousehold(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['users'] }),
    queryClient.invalidateQueries({ queryKey: ['auth-events'] }),
  ]).then(() => undefined);
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

// --- Your own account -------------------------------------------------------

/**
 * Everyone gets this, at any role.
 *
 * The username is an email address and reads as one everywhere it appears — in
 * the sidebar, against a manual adjustment in an envelope's history. A name is
 * what makes those lines legible, and it is nobody's business but yours.
 */
export function YourAccount(): ReactNode {
  const { user, refresh } = useSession();
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  /*
   * A plain handler rather than a mutation, and `finally` rather than the
   * success path.
   *
   * React Query would retry a failed logout, which is a request to end a session
   * the server may already have destroyed. And if it failed outright the browser
   * is in an unknown state — which is the last moment to leave somebody's budget
   * on screen.
   */
  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await authApi.logout();
    } finally {
      window.location.assign('/login');
    }
  }

  // Null means "not edited yet", so the server's value shows until it is.
  const value = name ?? user?.displayName ?? '';

  const save = useMutation({
    mutationFn: () => authApi.setDisplayName(value.trim() === '' ? null : value),
    onSuccess: async () => {
      setProblem(null);
      setSaved(true);
      setName(null);
      await refresh();
    },
    onError: (error: unknown) => {
      setSaved(false);
      setProblem(messageOf(error));
    },
  });

  return (
    <SettingsCard span="third" title="Your account" description="What this budget calls you.">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          width="md"
          label="Display name"
          value={value}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder={user?.username ?? ''}
          hint="Empty uses your username."
        />

        <p className="text-quiet text-muted">
          Signed in as <span className="text-ink">{user?.username}</span> ·{' '}
          {user ? ROLE_LABELS[user.role] : ''}
        </p>

        {problem && <Alert>{problem}</Alert>}
        {saved && <Alert tone="positive">Saved.</Alert>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>

          {/*
            Sign out, which lived only in the sidebar — and the sidebar is not on
            screen at all on a phone. Beside the account it ends the session for,
            which is a better home than a corner of the navigation anyway.
          */}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

// --- The household ----------------------------------------------------------

/** Creating an account, or editing one. The same fields either way. */
function UserDialog({
  editing,
  actorRole,
  onClose,
}: {
  /** The account being edited, or null to create one. */
  readonly editing: UserDto | null;
  readonly actorRole: UserRole;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(editing?.username ?? '');
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [role, setRole] = useState<UserRole>(editing?.role ?? 'user');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const name = displayName.trim() === '' ? null : displayName.trim();
      if (editing) {
        return usersApi.update(editing.id, { username: username.trim(), displayName: name, role });
      }
      return usersApi.create({
        username: username.trim(),
        displayName: name,
        temporaryPassword,
        role,
      });
    },
    onSuccess: async () => {
      await invalidateHousehold(queryClient);
      onClose();
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const incomplete =
    username.trim() === '' || (editing === null && temporaryPassword.trim().length < 12);

  return (
    <Modal
      label={editing ? `Edit ${editing.username}` : 'Create an account'}
      title={editing ? 'Edit account' : 'Create an account'}
      description={
        editing
          ? 'Everyone sees the whole budget. Only account management is restricted.'
          : 'They will have to change the temporary password before they can reach anything, and set up two-factor before that.'
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-2"
      >
        <TextField
          width="full"
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          required
        />

        <TextField
          width="full"
          label="Display name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={60}
          hint="Optional. They can change this themselves."
        />

        {editing === null && (
          <TextField
            width="full"
            label="Temporary password"
            value={temporaryPassword}
            onChange={(event) => setTemporaryPassword(event.target.value)}
            autoComplete="new-password"
            hint="At least 12 characters. They must replace it at first sign-in."
            required
          />
        )}

        <SelectField
          width="full"
          label="Role"
          value={role}
          onChange={(next) => setRole(next as UserRole)}
        >
          {(['user', 'admin', 'super_admin'] as const)
            // Offering a role the server would refuse is a dead control.
            .filter((option) => canModifyUser(actorRole, option))
            .map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
        </SelectField>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={incomplete || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Handing somebody a new temporary password. */
function ResetPasswordDialog({
  user,
  onClose,
}: {
  readonly user: UserDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id, temporaryPassword),
    onSuccess: async () => {
      await invalidateHousehold(queryClient);
      onClose();
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  return (
    <Modal
      label={`Reset the password for ${user.username}`}
      title="Reset password"
      description="Every session that account holds ends, and it must set a new password at the next sign-in."
      onClose={onClose}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          reset.mutate();
        }}
        className="flex flex-col gap-2"
      >
        <TextField
          width="full"
          label={`Temporary password for ${user.username}`}
          value={temporaryPassword}
          onChange={(event) => setTemporaryPassword(event.target.value)}
          autoComplete="new-password"
          hint="At least 12 characters."
          required
        />

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={temporaryPassword.trim().length < 12 || reset.isPending}
          >
            {reset.isPending ? 'Working…' : 'Reset password'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function UserRow({
  user,
  actorRole,
  isSelf,
  onEdit,
  onResetPassword,
}: {
  readonly user: UserDto;
  readonly actorRole: UserRole;
  readonly isSelf: boolean;
  readonly onEdit: () => void;
  readonly onResetPassword: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const act = (run: () => Promise<unknown>): void => runRowAction(run, queryClient, setProblem);

  const archived = user.archivedAt !== null;
  // Mirrors the domain rule rather than restating it: an Admin cannot touch a
  // Super Admin, and nobody archives themselves.
  const mayModify = canModifyUser(actorRole, user.role);

  return (
    <>
      <tr className="group border-b border-line last:border-0 hover:bg-surface">
        <td className="row-cell overflow-hidden pl-1">
          <div className="flex items-baseline gap-2 overflow-hidden">
            <span className="truncate text-ink">{user.displayName ?? user.username}</span>
            {user.displayName !== null && (
              <span className="truncate text-quiet text-faint">{user.username}</span>
            )}
          </div>
        </td>

        <td className="hidden row-cell w-32 text-quiet text-muted sm:table-cell">
          {ROLE_LABELS[user.role]}
        </td>

        <td className="hidden row-cell w-32 text-quiet sm:table-cell">
          {user.hasTotp ? (
            <span className="text-muted">On</span>
          ) : (
            <span className="text-warning">Not set up</span>
          )}
        </td>

        <td className="hidden row-cell w-40 text-quiet text-muted sm:table-cell">
          {archived ? 'Archived' : user.mustChangePassword ? 'Temporary password' : 'Active'}
        </td>

        {/*
          One menu rather than up to four buttons. A row could carry Edit, Reset
          password, Reset two-factor and Archive at once — four controls of equal
          weight, one of them destructive, on every row of a table read far more
          often than it is acted on.
        */}
        <td className="hold-to-open-cell row-cell">
          {mayModify && (
            <RowMenuShell name={user.displayName ?? user.username}>
              {(controls) => (
                <>
                  {!archived && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className={ITEM_CLASS}
                        onClick={() => {
                          onEdit();
                          controls.close();
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={ITEM_CLASS}
                        onClick={() => {
                          onResetPassword();
                          controls.close();
                        }}
                      >
                        Reset password
                      </button>
                      {user.hasTotp && (
                        <button
                          type="button"
                          role="menuitem"
                          className={ITEM_CLASS}
                          onClick={() => {
                            act(() => usersApi.resetTwoFactor(user.id));
                            controls.close();
                          }}
                        >
                          Reset two-factor
                        </button>
                      )}
                    </>
                  )}

                  {!isSelf && (
                    <>
                      <div className="my-1 border-t border-line" />
                      <button
                        type="button"
                        role="menuitem"
                        className={archived ? ITEM_CLASS : DANGER_ITEM_CLASS}
                        onClick={() => {
                          act(() =>
                            archived ? usersApi.restore(user.id) : usersApi.archive(user.id),
                          );
                          controls.close();
                        }}
                      >
                        {archived ? 'Restore' : 'Archive'}
                      </button>
                    </>
                  )}
                </>
              )}
            </RowMenuShell>
          )}
        </td>
      </tr>

      {problem && (
        <tr>
          <td colSpan={5} className="pb-2">
            <Alert>{problem}</Alert>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Runs a one-off row action and reports the server's refusal where the button is.
 *
 * A plain function rather than a mutation hook: hooks have to be declared
 * unconditionally, and these are chosen at click time. Deliberately not named
 * `use…` for the same reason.
 */
function runRowAction(
  run: () => Promise<unknown>,
  queryClient: ReturnType<typeof useQueryClient>,
  setProblem: (message: string | null) => void,
): void {
  setProblem(null);
  void run()
    .then(() => invalidateHousehold(queryClient))
    .catch((error: unknown) => setProblem(messageOf(error)));
}

/**
 * The household's accounts, and what has happened to credentials.
 *
 * Separated from `YourAccount` and `TwoFactorCard` so the Access tab can lay
 * them out: those two are about you and are the size of a form, these two are
 * about everybody and are tables.
 *
 * The table below is **not** `table-fixed`. This card is half a row now, and a
 * fixed layout hands the unsized column whatever the stated widths leave — which
 * at this width was nothing, so the name collapsed to zero and vanished. Every
 * column here is short and bounded; the name is the longest and is the one that
 * should take the slack.
 */
export function UsersSection(): ReactNode {
  const { user: actor } = useSession();
  const mayManage = actor ? canManageUsers(actor.role) : false;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [resetting, setResetting] = useState<UserDto | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    // The route refuses anyone without the capability; not asking is quieter
    // than asking and being turned away.
    enabled: mayManage,
  });

  return (
    <>
      {!mayManage ? (
        <SettingsCard
          span="half"
          title="The household"
          description="Who else can sign in to this budget."
        >
          <p className="text-quiet text-muted">
            Only an administrator can manage accounts. Everything else in this application is
            shared.
          </p>
        </SettingsCard>
      ) : (
        <SettingsCard
          span="half"
          title="The household"
          description="Everyone sees the whole budget."
          action={<Button onClick={() => setCreating(true)}>New person</Button>}
        >
          {users.isLoading ? (
            <p className="text-quiet text-muted">Loading accounts…</p>
          ) : (
            <table className="w-full border-t-2 border-ink">
              <thead>
                <tr className="text-label uppercase tracking-[0.05em] text-muted">
                  <th className="row-cell pl-1 text-left font-normal">Name</th>
                  {/* The phone column policy: a name, and the menu that acts on
                      it. Role, the second factor and whether the account is
                      active are all reachable from that menu, and three fixed
                      columns of them came to 456px in a 326px card — the headers
                      drew on top of each other. */}
                  <th className="hidden row-cell w-32 text-left font-normal sm:table-cell">Role</th>
                  <th className="hidden row-cell w-32 text-left font-normal sm:table-cell">
                    Two-factor
                  </th>
                  <th className="hidden row-cell w-40 text-left font-normal sm:table-cell">
                    Status
                  </th>
                  <th className="hold-to-open-cell row-cell" />
                </tr>
              </thead>
              <tbody>
                {users.data?.users.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    actorRole={actor?.role ?? 'user'}
                    isSelf={user.id === actor?.id}
                    onEdit={() => setEditing(user)}
                    onResetPassword={() => setResetting(user)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </SettingsCard>
      )}

      {/* Last, and administrator-only like the table above it: it is read about
          the household rather than about yourself. */}
      {mayManage && <SignInActivity />}

      {creating && (
        <UserDialog
          editing={null}
          actorRole={actor?.role ?? 'user'}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <UserDialog
          editing={editing}
          actorRole={actor?.role ?? 'user'}
          onClose={() => setEditing(null)}
        />
      )}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
    </>
  );
}
