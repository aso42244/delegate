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
 *
 * When the account has a second factor, the password step returns a challenge
 * instead of a session and this screen asks for a code. Holding the challenge in
 * component state rather than anywhere durable is deliberate — a reload starts
 * the sign-in over, which is the correct outcome for a half-finished one.
 */
export function SignIn({ appName }: { appName: string }): ReactNode {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const setupState = useQuery({ queryKey: ['setup-state'], queryFn: authApi.setupState });
  const needsSetup = setupState.data?.needsSetup === true;
  const needsSetupToken = setupState.data?.needsSetupToken === true;

  async function enter(): Promise<void> {
    setProblem(null);
    await refresh();
    void navigate('/', { replace: true });
  }

  function report(error: unknown): void {
    setProblem(
      error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
    );
  }

  const submit = useMutation({
    mutationFn: async () => {
      if (needsSetup) {
        if (password !== confirmation) {
          throw new ApiError(400, 'password_mismatch', 'The two passwords do not match.');
        }
        return authApi.setup(username, password, setupToken);
      }
      return authApi.login(username, password);
    },
    onSuccess: async (result) => {
      if ('secondFactorRequired' in result && result.secondFactorRequired) {
        setProblem(null);
        setPassword('');
        setChallenge(result.challenge);
        return;
      }
      await enter();
    },
    onError: report,
  });

  const finish = useMutation({
    mutationFn: () => authApi.secondFactor(challenge!, code),
    onSuccess: enter,
    onError: (error: unknown) => {
      setCode('');
      // The challenge outlives a wrong code but not an expired one, and the
      // server says which by refusing the challenge rather than the code.
      if (error instanceof ApiError && error.code === 'challenge_invalid') setChallenge(null);
      report(error);
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (challenge) finish.mutate();
    else submit.mutate();
  }

  const pending = submit.isPending || finish.isPending;

  return (
    <main className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-page font-bold text-ink">{appName}</h1>
        <p className="mb-6 text-quiet text-muted">
          {challenge
            ? 'Enter the code from your authenticator app.'
            : needsSetup
              ? 'Create the first account. It becomes the Super Admin.'
              : 'Sign in to continue.'}
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {challenge ? (
            <TextField
              width="full"
              label="Authentication code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              // The one-time-code hint is what makes iOS and Android offer the
              // code straight from the notification.
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              required
              hint="Or one of your recovery codes, if you cannot reach the app."
            />
          ) : (
            <>
              <TextField
                width="full"
                label="Username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
              <TextField
                width="full"
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
                  width="full"
                  label="Confirm password"
                  type="password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              )}
              {/*
                The code that proves whoever is claiming this budget can read
                the machine it runs on. Creating the first account cannot be
                authenticated — there is nobody to authenticate as — so this is
                what stands in for it once the address might be a public one.

                The hint names where to find it, because a code somebody cannot
                locate is a deployment they cannot use.
              */}
              {needsSetup && needsSetupToken && (
                <TextField
                  width="full"
                  label="Setup code"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  autoComplete="off"
                  hint="Printed in the server's logs: docker compose logs app"
                  required
                />
              )}
            </>
          )}

          {problem && <Alert>{problem}</Alert>}

          <Button type="submit" variant="primary" disabled={pending}>
            {pending
              ? 'Working…'
              : challenge
                ? 'Verify'
                : needsSetup
                  ? 'Create account'
                  : 'Sign in'}
          </Button>

          {challenge && (
            <Button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setProblem(null);
              }}
            >
              Start over
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
