import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, authApi } from '../api/client.js';
import { useSession } from '../auth/SessionProvider.jsx';
import { Alert, Button, TextField } from '../components/ui.jsx';

/**
 * Forced password change.
 *
 * An account created by an Admin starts with a temporary password and can reach
 * nothing else until it sets a real one — the server enforces that; this is the
 * only screen it can usefully render meanwhile.
 */
export function ChangePassword(): ReactNode {
  const navigate = useNavigate();
  const { user, refresh } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (newPassword !== confirmation) {
        throw new ApiError(400, 'password_mismatch', 'The two passwords do not match.');
      }
      return authApi.changePassword(currentPassword, newPassword);
    },
    onSuccess: async () => {
      setProblem(null);
      await refresh();
      void navigate('/', { replace: true });
    },
    onError: (error: unknown) => {
      setProblem(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    submit.mutate();
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-page font-bold text-ink">Set a new password</h1>
        <p className="mb-6 text-quiet text-muted">
          {user
            ? `You are signed in as ${user.username} with a temporary password.`
            : 'Your password is temporary and must be replaced.'}
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <TextField
            label="Temporary password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          <TextField
            label="New password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            hint="At least 12 characters. A passphrase is ideal."
            required
          />
          <TextField
            label="Confirm new password"
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            required
          />

          {problem && <Alert>{problem}</Alert>}

          <Button type="submit" variant="primary" disabled={submit.isPending}>
            {submit.isPending ? 'Saving…' : 'Set password'}
          </Button>
        </form>
      </div>
    </main>
  );
}
