import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, authApi } from '../api/client.js';
import { useSession } from '../auth/SessionProvider.jsx';
import { Alert, Button, TextField } from '../components/ui.jsx';

/**
 * Sign in, and first-run setup.
 *
 * One screen for both: the server says which is needed, so an empty database
 * offers to create the first account rather than presenting a login nobody can
 * satisfy. The first account created becomes Super Admin.
 */
export function SignIn({ appName }: { appName: string }): ReactNode {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const setupState = useQuery({ queryKey: ['setup-state'], queryFn: authApi.setupState });
  const needsSetup = setupState.data?.needsSetup === true;

  const submit = useMutation({
    mutationFn: async () => {
      if (needsSetup) {
        if (password !== confirmation) {
          throw new ApiError(400, 'password_mismatch', 'The two passwords do not match.');
        }
        return authApi.setup(username, password);
      }
      return authApi.login(username, password);
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
        <h1 className="mb-1 text-page font-bold text-ink">{appName}</h1>
        <p className="mb-6 text-quiet text-muted">
          {needsSetup
            ? 'Create the first account. It becomes the Super Admin.'
            : 'Sign in to continue.'}
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <TextField
            label="Username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            required
            {...(needsSetup ? { hint: 'At least 12 characters. A passphrase is ideal.' } : {})}
          />
          {needsSetup && (
            <TextField
              label="Confirm password"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              required
            />
          )}

          {problem && <Alert>{problem}</Alert>}

          <Button type="submit" variant="primary" disabled={submit.isPending}>
            {submit.isPending ? 'Working…' : needsSetup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
