import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { backupsApi } from '../../api/backups.js';
import { ApiError, syncApi, type SyncStatus } from '../../api/client.js';
import { Alert, Button, Modal, TextField } from '../../components/ui.jsx';
import { SettingsCard as Card } from './SettingsCard.jsx';

/** Settings → Sync: the SimpleFIN connection, its history, and a manual run. */

type Connection = { tone: 'positive' | 'warning'; text: string; connected: boolean };

function connectionSummary(status: SyncStatus): Connection {
  if (status.credentialProblem) {
    return { tone: 'warning', text: status.credentialProblem, connected: false };
  }

  switch (status.credentialSource) {
    case 'database':
      return {
        tone: 'positive',
        connected: true,
        text: status.connectedAt
          ? `Connected on ${new Date(status.connectedAt).toLocaleDateString()}`
          : 'Connected',
      };
    case 'environment':
      return {
        tone: 'positive',
        connected: false,
        text: 'Connected from the environment',
      };
    case 'none':
      return {
        tone: 'warning',
        connected: false,
        text: 'Not connected — sync is idle until you connect an account',
      };
  }
}

/**
 * The setup-token field, behind a dialog once there is a connection.
 *
 * A token is a one-time thing: claimed once, spent, and then never wanted again
 * unless the connection is being replaced. Leaving the field open afterwards
 * gave a working connection a permanent empty box asking to be filled, which
 * reads as unfinished. Before the first connection it is the whole point of the
 * page, so it stays inline then.
 */
function TokenField({
  onDone,
  inDialog,
}: {
  readonly onDone?: () => void;
  readonly inDialog: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [setupToken, setSetupToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () => syncApi.connect(setupToken.trim()),
    onSuccess: async () => {
      // The token is single-use and now spent; clearing it stops a second
      // attempt that could only ever fail.
      setSetupToken('');
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['sync'] });
      onDone?.();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not connect to SimpleFIN.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    connect.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <TextField
        label="Setup token"
        value={setupToken}
        onChange={(event) => setSetupToken(event.target.value)}
        placeholder="Paste the token from bridge.simplefin.org"
        hint="A setup token can only be claimed once. If this fails, request a new one."
        autoComplete="off"
        spellCheck={false}
        autoFocus={inDialog}
      />

      {problem && <Alert>{problem}</Alert>}

      <div className={`flex gap-2 ${inDialog ? 'justify-end' : ''}`}>
        {inDialog && (
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={connect.isPending || setupToken.trim() === ''}
        >
          {connect.isPending ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

/** What a run actually did, which is the only reason to look at the list. */
function runSummary(run: SyncStatus['runs'][number]): string {
  if (run.status === 'running') return 'in progress';
  if (run.status === 'failed') return 'no transactions imported';

  const parts: string[] = [];
  if (run.transactionsAdded > 0) {
    parts.push(`${run.transactionsAdded} imported`);
  }
  if (run.transactionsUpdated > 0) parts.push(`${run.transactionsUpdated} updated`);
  if (run.transactionsReversed > 0) parts.push(`${run.transactionsReversed} reversed`);

  // "Nothing new" rather than "0 imported": on an hourly schedule that is the
  // ordinary result, and a column of zeroes reads as a fault.
  return parts.length === 0 ? 'nothing new' : parts.join(', ');
}

/** Bytes as something a person reads, which for a dump means MB. */
function readableSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Whether there is a backup, which is a different question from whether the
 * last attempt succeeded.
 *
 * This card exists because the answer used to require an SSH session. The
 * nightly dump on this deployment failed with a permission error every night
 * from go-live, logged at error level each time, and nothing anywhere read the
 * log — so the application was green, the owner assumed backups were running,
 * and neither impression was reachable from the other.
 *
 * A dump only counts with its checksum beside it. `backup.sh` writes to a
 * `.partial` name and renames both files on success, so a dump without its
 * sidecar is the wreckage of a failed run rather than a backup.
 */
function Backups(): ReactNode {
  const backups = useQuery({ queryKey: ['backups'], queryFn: backupsApi.status });

  const newest = backups.data?.newestAt ?? null;
  const hours =
    newest === null ? null : (Date.now() - new Date(newest).getTime()) / (60 * 60 * 1000);
  // Nightly, so one missed run is a hiccup and two is a pattern.
  const failing = backups.data !== undefined && (hours === null || hours > 48);

  return (
    <Card
      title="Backups"
      description="A dump of the whole budget, nightly at 02:30 UTC, kept for 30 days."
    >
      {backups.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-quiet">
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${failing ? 'bg-danger-dot' : 'bg-positive'}`}
            />
            <span className={failing ? 'font-semibold text-danger' : 'text-muted'}>
              {newest === null
                ? 'No backup has ever completed.'
                : `Newest ${new Date(newest).toLocaleString()} · ${backups.data?.count ?? 0} kept`}
            </span>
          </p>

          {/* The path, because somebody chasing a missing dump needs to know
              which directory to look in — and because it is configuration
              rather than a secret. */}
          <p className="mt-1 font-mono text-label break-all text-faint">
            {backups.data?.directory}
          </p>

          {failing && (
            <div className="mt-3">
              <Alert>
                Everything in this budget exists in one place. The commonest cause is the backup
                directory not being writable by the container, which runs unprivileged — check that
                it is owned by uid 1000 on the host.
              </Alert>
            </div>
          )}

          {(backups.data?.recent.length ?? 0) > 0 && (
            <table className="mt-4 w-full border-t-2 border-ink">
              <thead>
                <tr className="text-label uppercase tracking-[0.05em] text-muted">
                  <th className="row-cell pl-1 text-left font-normal">Dump</th>
                  <th className="row-cell w-28 pr-2 text-right font-normal">Size</th>
                  <th className="row-cell w-48 pr-1 text-right font-normal">Written</th>
                </tr>
              </thead>
              <tbody>
                {backups.data?.recent.map((file) => (
                  <tr key={file.name} className="border-b border-line last:border-0">
                    <td className="row-cell overflow-hidden pl-1">
                      <span className="block truncate font-mono text-quiet text-ink">
                        {file.name}
                      </span>
                    </td>
                    <td className="row-cell w-28 pr-2 text-right text-quiet text-muted">
                      {/* A dump with no checksum beside it never completed, and
                          saying "incomplete" is the whole point of the sidecar. */}
                      {file.hasChecksum ? (
                        readableSize(file.bytes)
                      ) : (
                        <span className="font-semibold text-warning">incomplete</span>
                      )}
                    </td>
                    <td className="row-cell w-48 pr-1 text-right text-quiet whitespace-nowrap text-muted">
                      {new Date(file.writtenAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

export function SyncSection(): ReactNode {
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);

  const status = useQuery({ queryKey: ['sync', 'status'], queryFn: syncApi.status });

  const forget = useMutation({
    mutationFn: syncApi.disconnect,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
  });

  /*
   * Running a sync by hand.
   *
   * It existed only in the sidebar, which is not on screen at all on a phone —
   * so the page named after the connection could report on it and not run it.
   * It belongs here whatever the width.
   */
  const run = useMutation({
    mutationFn: syncApi.run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
  });

  const summary = status.data ? connectionSummary(status.data) : null;
  const runs = status.data?.runs.slice(0, 5) ?? [];

  return (
    <>
      <Card
        title="SimpleFIN"
        description="Connects your institutions so balances and transactions arrive automatically, hourly."
        action={
          summary?.connected ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => run.mutate()}
                disabled={run.isPending || status.data?.syncing === true}
              >
                {run.isPending || status.data?.syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              <Button onClick={() => setReplacing(true)}>Set up new token</Button>
              <Button variant="danger" onClick={() => forget.mutate()} disabled={forget.isPending}>
                Disconnect
              </Button>
            </div>
          ) : undefined
        }
      >
        {/*
        A line, not a bar. The state is one fact and the full-width panel it used
        to sit in said it at the size of a warning on the day nothing was wrong,
        which is most days.
      */}
        {summary && (
          <p className="flex items-center gap-2 text-quiet">
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${
                summary.tone === 'positive' ? 'bg-positive' : 'bg-warning-dot'
              }`}
            />
            <span className={summary.tone === 'positive' ? 'text-muted' : 'text-warning'}>
              {summary.text}
            </span>
          </p>
        )}

        {/* Before the first connection the token field *is* the page. */}
        {summary && !summary.connected && status.data?.credentialSource !== 'environment' && (
          <div className="mt-4 max-w-xl">
            <TokenField inDialog={false} />
          </div>
        )}

        {runs.length > 0 && (
          <div className="mt-5">
            <table className="w-full border-t-2 border-ink">
              <thead>
                <tr className="text-label uppercase tracking-[0.05em] text-muted">
                  <th className="row-cell pl-1 text-left font-semibold text-ink">Recent syncs</th>
                  <th className="row-cell text-left font-normal">Result</th>
                  <th className="row-cell pr-1 text-right font-normal">When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-line last:border-0">
                    <td className="row-cell w-24 pl-1">
                      <span
                        className={
                          run.status === 'failed'
                            ? 'text-quiet font-semibold text-danger'
                            : run.status === 'running'
                              ? 'text-quiet text-muted'
                              : 'text-quiet text-positive'
                        }
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="row-cell text-quiet text-muted">
                      {/* Errors are surfaced, never left in the log alone. */}
                      {run.error ? (
                        <span className="text-danger">{run.error}</span>
                      ) : (
                        runSummary(run)
                      )}
                    </td>
                    <td className="row-cell w-48 pr-1 text-right text-quiet whitespace-nowrap text-muted">
                      {new Date(run.startedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {replacing && (
          <Modal
            label="Connect a new SimpleFIN setup token"
            title="Set up new token"
            description="Replaces the connection this budget is using. The old one stops working."
            onClose={() => setReplacing(false)}
          >
            <TokenField inDialog onDone={() => setReplacing(false)} />
          </Modal>
        )}
      </Card>

      <Backups />
    </>
  );
}
