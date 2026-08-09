import { canManageUsers, type UserRole } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client.js';
import { useSession } from '../../auth/SessionProvider.jsx';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Users.
 *
 * The whole permission model is one capability check plus Super Admin immunity,
 * and both are enforced on the server — the domain layer refuses rather than the
 * route, so it cannot be forgotten. This screen mirrors that rather than
 * reimplementing it: controls that would certainly fail are not offered, and
 * anything else that is refused shows the server's reason.
 */

interface UserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
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
  create: (username: string, temporaryPassword: string, role: UserRole) =>
    api.post<{ user: UserDto }>('/api/users', { username, temporaryPassword, role }),
  update: (id: string, input: { username?: string; role?: UserRole }) =>
    api.patch<{ user: UserDto }>(`/api/users/${id}`, input),
  resetPassword: (id: string, temporaryPassword: string) =>
    api.post<{ user: UserDto }>(`/api/users/${id}/reset-password`, { temporaryPassword }),
  archive: (id: string) => api.post<{ user: UserDto }>(`/api/users/${id}/archive`),
  restore: (id: string) => api.post<{ user: UserDto }>(`/api/users/${id}/restore`),
};

function UserRow({
  user,
  actorRole,
  isSelf,
}: {
  readonly user: UserDto;
  readonly actorRole: UserRole;
  readonly isSelf: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const onError = (error: unknown): void => {
    setDone(null);
    setProblem(error instanceof ApiError ? error.message : 'Could not change this account.');
  };

  const update = useMutation({
    mutationFn: (input: { username?: string; role?: UserRole }) => usersApi.update(user.id, input),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const reset = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id, temporaryPassword),
    onSuccess: async () => {
      setProblem(null);
      setResetting(false);
      setTemporaryPassword('');
      // Their sessions are revoked immediately, so say so rather than leaving
      // them to discover it.
      setDone(`${user.username} must set a new password at their next sign-in.`);
      await refresh();
    },
    onError,
  });

  const archive = useMutation({
    mutationFn: () => (user.archivedAt ? usersApi.restore(user.id) : usersApi.archive(user.id)),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  // Only a Super Admin may modify a Super Admin. Offering the control to anyone
  // else would only produce a refusal.
  const mayModify = user.role !== 'super_admin' || actorRole === 'super_admin';

  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <span className="text-ink">{user.username}</span>
          {isSelf && <span className="ml-2 text-quiet text-muted">(you)</span>}
          {user.archivedAt && (
            <span className="ml-2 text-label font-semibold text-warning">archived</span>
          )}
          {user.mustChangePassword && (
            <span className="ml-2 text-label font-semibold text-muted">must change password</span>
          )}
        </div>

        <div className="w-40">
          <SelectField
            label={`Role of ${user.username}`}
            value={user.role}
            onChange={(value) => update.mutate({ role: value as UserRole })}
          >
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value} disabled={!mayModify}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>

        {mayModify && (
          <Button
            onClick={() => setResetting(!resetting)}
            aria-label={`Reset ${user.username}'s password`}
          >
            Reset password
          </Button>
        )}

        {mayModify && !isSelf && (
          <Button
            variant={user.archivedAt ? 'default' : 'danger'}
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
            aria-label={`${user.archivedAt ? 'Restore' : 'Archive'} ${user.username}`}
          >
            {user.archivedAt ? 'Restore' : 'Archive'}
          </Button>
        )}
      </div>

      {resetting && (
        <div className="mt-3 flex items-end gap-2 rounded-lg bg-surface p-3">
          <div className="flex-1">
            <TextField
              label={`Temporary password for ${user.username}`}
              value={temporaryPassword}
              onChange={(event) => setTemporaryPassword(event.target.value)}
              autoComplete="off"
              hint="They must change it the first time they sign in, and their existing sessions end straight away."
            />
          </div>
          <Button
            variant="primary"
            onClick={() => reset.mutate()}
            disabled={temporaryPassword.trim() === '' || reset.isPending}
          >
            {reset.isPending ? 'Setting…' : 'Set'}
          </Button>
        </div>
      )}

      {problem && (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      )}
      {done && (
        <div className="mt-2">
          <Alert tone="positive">{done}</Alert>
        </div>
      )}
    </div>
  );
}

function AddUserForm(): ReactNode {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => usersApi.create(username.trim(), temporaryPassword, role),
    onSuccess: async () => {
      setUsername('');
      setTemporaryPassword('');
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the account.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3 rounded-lg bg-surface p-3">
      <TextField
        label="Username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="off"
      />
      <TextField
        label="Temporary password"
        value={temporaryPassword}
        onChange={(event) => setTemporaryPassword(event.target.value)}
        autoComplete="off"
        hint="At least 12 characters. They will have to change it before they can reach anything."
      />
      <SelectField label="Role" value={role} onChange={(value) => setRole(value as UserRole)}>
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </SelectField>

      {problem && <Alert>{problem}</Alert>}

      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={username.trim() === '' || temporaryPassword.trim() === '' || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}

export function UsersSection(): ReactNode {
  const { user: actor } = useSession();
  const mayManage = actor ? canManageUsers(actor.role) : false;

  const users = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    // The route refuses anyone without the capability; not asking is quieter
    // than asking and being turned away.
    enabled: mayManage,
  });

  if (!mayManage) {
    return (
      <SettingsCard title="Users" description="Who can sign in to this budget.">
        <p className="text-quiet text-muted">
          Only an Admin can manage accounts. Everything else in this application is shared.
        </p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title="Users"
      description="Who can sign in. Everyone sees the whole budget; only account management is restricted."
    >
      {users.isLoading ? (
        <p className="text-quiet text-muted">Loading accounts…</p>
      ) : (
        <div>
          {users.data?.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              actorRole={actor?.role ?? 'user'}
              isSelf={user.id === actor?.id}
            />
          ))}
        </div>
      )}

      <AddUserForm />
    </SettingsCard>
  );
}
