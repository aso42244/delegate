import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, syncApi, type SyncStatus } from '../api/client.js';
import { Alert, Button, TextField } from '../components/ui.jsx';

/**
 * Settings.
 *
 * Only the Sync section so far. The rest — accounts, delegations, rules, users,
 * archived entities, reconcile — follows.
 */

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mb-4 text-quiet text-muted">{description}</p>
      {children}
    </section>
  );
}

function connectionSummary(status: SyncStatus): { tone: 'positive' | 'warning'; text: string } {
  if (status.credentialProblem) return { tone: 'warning', text: status.credentialProblem };

  switch (status.credentialSource) {
    case 'database':
      return {
        tone: 'positive',
        text: status.connectedAt
          ? `Connected in the app on ${new Date(status.connectedAt).toLocaleDateString()}.`
          : 'Connected in the app.',
      };
    case 'environment':
      return {
        tone: 'positive',
        text: 'Connected using SIMPLEFIN_ACCESS_URL from the environment.',
      };
    case 'none':
      return { tone: 'warning', text: 'Not connected. Sync is idle until you connect an account.' };
  }
}

function SyncSettings(): ReactNode {
  const queryClient = useQueryClient();
  const [setupToken, setSetupToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['sync', 'status'], queryFn: syncApi.status });

  const connect = useMutation({
    mutationFn: () => syncApi.connect(setupToken.trim()),
    onSuccess: async () => {
      // The token is single-use and now spent; clearing it stops a second
      // attempt that could only ever fail.
      setSetupToken('');
      setProblem(null);
      setDone('Connected. Run a sync to pull your accounts.');
      await queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (error: unknown) => {
      setDone(null);
      setProblem(error instanceof ApiError ? error.message : 'Could not connect to SimpleFIN.');
    },
  });

  const forget = useMutation({
    mutationFn: syncApi.disconnect,
    onSuccess: async () => {
      setDone('Disconnected.');
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    connect.mutate();
  }

  const summary = status.data ? connectionSummary(status.data) : null;

  return (
    <Card
      title="SimpleFIN"
      description="Connects your institutions so balances and transactions arrive automatically, hourly."
    >
      {summary && (
        <div className="mb-4">
          <Alert tone={summary.tone}>{summary.text}</Alert>
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <TextField
          label="Setup token"
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
          placeholder="Paste the token from bridge.simplefin.org"
          hint="A setup token can only be claimed once. If this fails, request a new one."
          autoComplete="off"
          spellCheck={false}
        />

        {problem && <Alert>{problem}</Alert>}
        {done && <Alert tone="positive">{done}</Alert>}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={connect.isPending || setupToken.trim() === ''}
          >
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </Button>

          {status.data?.credentialSource === 'database' && (
            <Button
              type="button"
              variant="danger"
              onClick={() => forget.mutate()}
              disabled={forget.isPending}
            >
              Disconnect
            </Button>
          )}
        </div>
      </form>

      {status.data && status.data.runs.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-quiet font-semibold text-ink">Recent syncs</h3>
          <ul className="flex flex-col gap-1">
            {status.data.runs.slice(0, 5).map((run) => (
              <li key={run.id} className="flex items-baseline gap-3 text-quiet">
                <span
                  className={
                    run.status === 'failed'
                      ? 'font-semibold text-danger'
                      : run.status === 'running'
                        ? 'text-muted'
                        : 'text-positive'
                  }
                >
                  {run.status}
                </span>
                <span className="text-muted">{new Date(run.startedAt).toLocaleString()}</span>
                {/* Errors are surfaced, never left in the log alone. */}
                {run.error && <span className="text-danger">{run.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function Settings(): ReactNode {
  return (
    <div>
      <h1 className="text-page font-bold text-ink">Settings</h1>
      <p className="mt-1 mb-6 text-quiet text-muted">
        Connections, accounts and how the budget behaves.
      </p>

      <div className="flex flex-col gap-4">
        <SyncSettings />
      </div>
    </div>
  );
}
