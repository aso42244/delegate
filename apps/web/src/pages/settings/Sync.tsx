import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { backupsApi } from '../../api/backups.js';
import { StatusLine } from '../../components/layout.jsx';
import { describeBackupSchedule } from './backup-schedule.js';
import { ApiError, syncApi, type SyncStatus } from '../../api/client.js';
import { transactionsApi } from '../../api/transactions.js';
import { Alert, Button, Modal, TextField } from '../../components/ui.jsx';
import { EncryptionKey } from './EncryptionKey.jsx';
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
        text: 'Not connected.',
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
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <TextField
        width="lg"
        label="Setup token"
        value={setupToken}
        onChange={(event) => setSetupToken(event.target.value)}
        placeholder="Paste the token from bridge.simplefin.org"
        hint="Claimable once."
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
      span="third"
      title="Backups"
      description={
        backups.data
          ? describeBackupSchedule(
              backups.data.cron,
              backups.data.timezone,
              backups.data.retentionDays,
            )
          : 'A dump of the whole budget.'
      }
    >
      {backups.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : (
        <>
          <StatusLine tone={failing ? 'danger' : 'positive'}>
            {newest === null
              ? 'No backup has ever completed.'
              : `Newest ${new Date(newest).toLocaleString()} · ${backups.data?.count ?? 0} kept`}
          </StatusLine>

          {/* The path, because somebody chasing a missing dump needs to know
              which directory to look in — and because it is configuration
              rather than a secret.

              The host's name for it when compose passed one through, because
              that is the one you can act on. `BACKUP_DIR` inside the container
              is `/backups`, which is true and useless when you are standing on
              the NAS looking for the file. */}
          <p className="mt-1 font-mono text-label break-all text-faint">
            {backups.data?.hostDirectory ?? backups.data?.directory}
          </p>

          {failing && (
            <div className="mt-4">
              <Alert>
                Usually the backup directory is not writable by the container. Check it is owned by
                uid 1000 on the host.
              </Alert>
            </div>
          )}

          {/* `table-fixed`: a dump's name is a 30-character monospace string, and
              a content-sized table treats that as a minimum rather than as
              something to truncate. Fixed, the named columns take what they ask
              for and the name takes the rest — which is what keeps this inside
              the card at a third of a row. */}
          {(backups.data?.recent.length ?? 0) > 0 && (
            <table className="mt-4 w-full table-fixed border-t-2 border-ink">
              <thead>
                <tr className="text-label uppercase tracking-label text-muted">
                  <th className="row-cell pl-1 text-left font-normal">Dump</th>
                  <th className="hidden row-cell w-20 pr-2 text-right font-normal @lg:table-cell">
                    Size
                  </th>
                  <th className="row-cell w-24 pr-1 text-right font-normal @lg:w-40">Written</th>
                </tr>
              </thead>
              <tbody>
                {backups.data?.recent.map((file) => (
                  <tr key={file.name} className="border-b border-line last:border-0">
                    <td className="row-cell overflow-hidden pl-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-quiet text-ink">{file.name}</span>
                        {/* A dump with no checksum beside it never completed, and
                            saying so is the whole point of the sidecar. It sits
                            here rather than only in the size column, because that
                            column is not shown on a phone and this is the half of
                            it worth keeping at every width. */}
                        {!file.hasChecksum && (
                          <span className="shrink-0 text-label font-semibold text-warning @lg:hidden">
                            incomplete
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden row-cell w-20 pr-2 text-right text-quiet text-muted @lg:table-cell">
                      {file.hasChecksum ? (
                        readableSize(file.bytes)
                      ) : (
                        <span className="font-semibold text-warning">incomplete</span>
                      )}
                    </td>
                    <td className="row-cell w-24 pr-1 text-right text-quiet whitespace-nowrap text-muted @lg:w-40">
                      {/* The date alone in a narrow card. The time is worth
                          having and is not worth 90px of a 345px row — which is
                          what pushed this table past the card's border. It is
                          still on the row, in the title, for anyone chasing two
                          dumps written the same day. */}
                      <span
                        title={new Date(file.writtenAt).toLocaleString()}
                        className="@lg:hidden"
                      >
                        {new Date(file.writtenAt).toLocaleDateString()}
                      </span>
                      <span className="hidden @lg:inline">
                        {new Date(file.writtenAt).toLocaleString()}
                      </span>
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

/**
 * The way out.
 *
 * Beside the backups because it answers the other half of the same worry, and
 * differently: a dump restores this application and only this application. A CSV
 * is the household's own data in a form anything can read — a spreadsheet at tax
 * time, a cross-check against a statement, or a look at a year in a way this
 * application does not offer.
 *
 * Plain links rather than a fetch and a blob. A download is a navigation, the
 * session cookie goes with it, and the browser's own save dialog is better than
 * anything reimplemented here.
 */
function Export(): ReactNode {
  const files = [
    {
      href: '/api/export/transactions.csv',
      label: 'Transactions',
      hint: 'One row each.',
    },
    {
      href: '/api/export/delegation-events.csv',
      label: 'Delegation ledger',
      hint: 'Every movement.',
    },
    {
      href: '/api/export/snapshots.csv',
      label: 'Nightly snapshots',
      hint: 'Balances by day.',
    },
  ];

  return (
    <Card span="third" title="Export" description="The whole budget as CSV, for a spreadsheet.">
      <ul className="flex flex-col gap-2">
        {files.map((file) => (
          <li key={file.href} className="flex items-baseline gap-2 whitespace-nowrap">
            {/* Styled as a link rather than as a button: it navigates, and a
                control that looks like a button but leaves the page is the
                thing this design system spent an audit removing. */}
            <a
              href={file.href}
              download
              /* Named for what it does, not only for what it holds. "Transactions"
                 is also the sidebar's link and the register's page, and a bare
                 noun tells somebody using a screen reader nothing about the fact
                 that following it saves a file. The visible word is kept inside
                 the name, so the two agree. */
              aria-label={`Download ${file.label.toLowerCase()} as CSV`}
              className="shrink-0 text-quiet font-semibold text-accent underline"
            >
              {file.label}
            </a>
            <span className="truncate text-label text-muted">{file.hint}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SyncSection(): ReactNode {
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);

  const status = useQuery({ queryKey: ['sync', 'status'], queryFn: syncApi.status });

  /*
   * How much is in the register, asked for one row.
   *
   * The list endpoint reports the total alongside the page, so the cheapest way
   * to count is to ask for the smallest page there is. This is the figure that
   * used to sit under the Transactions title, where it was a status line above a
   * list somebody came to work through; here it is beside the connection that
   * produced it.
   */
  const register = useQuery({
    queryKey: ['transactions', 'count'],
    queryFn: () => transactionsApi.list({ limit: 1 }),
  });

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
        description="Balances and transactions, hourly."
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
              <Button onClick={() => setReplacing(true)}>New token</Button>
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
          <StatusLine tone={summary.tone === 'positive' ? 'positive' : 'warning'}>
            {summary.text}
          </StatusLine>
        )}

        {register.data !== undefined && (
          <p className="mt-1 text-quiet text-muted">
            {register.data.total.toLocaleString()}{' '}
            {register.data.total === 1 ? 'transaction' : 'transactions'} in the register.
          </p>
        )}

        {/* Before the first connection the token field *is* the page. */}
        {summary && !summary.connected && status.data?.credentialSource !== 'environment' && (
          <div className="mt-4 max-w-xl">
            <TokenField inDialog={false} />
          </div>
        )}

        {runs.length > 0 && (
          <div className="mt-4">
            <table className="w-full border-t-2 border-ink">
              <thead>
                <tr className="text-label uppercase tracking-label text-muted">
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

      <Export />

      {/* Beside the backups, because that is where its consequence lands: a dump
          without this key restores every transaction and no credential. */}
      <EncryptionKey />
    </>
  );
}
