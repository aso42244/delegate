import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import {
  downloadConnector,
  tokensApi,
  type ApiTokenDto,
  type TokenScope,
} from '../../api/tokens.js';
import { Alert, Button, SelectField, Tag, TextField, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Connections. The tokens a program signs in with.
 *
 * The audience for this page is somebody connecting Claude to their own budget,
 * not somebody who knows what a bearer token is. So the copy says what a
 * connection can *do* — read the numbers, sort transactions — and never what
 * HTTP method it may use.
 *
 * Like the recovery codes on the Security page, the token is shown exactly
 * once. That is a property of the server rather than a choice made here: only a
 * digest is stored, so this screen is the single opportunity to copy it.
 */

const EXPIRY_CHOICES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
  { value: 'never', label: 'Never' },
] as const;

export function ConnectionsSection(): ReactNode {
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: tokensApi.list });

  const [name, setName] = useState('');
  const [allowChanges, setAllowChanges] = useState(false);
  const [expiry, setExpiry] = useState<string>('365');
  const [issued, setIssued] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      tokensApi.create({
        name,
        scope: (allowChanges ? 'read_write' : 'read') satisfies TokenScope,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      }),
    onSuccess: async (result) => {
      setProblem(null);
      setName('');
      setAllowChanges(false);
      setIssued(result.secret);
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => tokensApi.revoke(id),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const rows = tokens.data?.tokens ?? [];

  return (
    <>
      <SettingsCard
        title="New connection"
        description="A key that lets a program — an AI assistant, a script — read this budget."
      >
        {problem && <Alert>{problem}</Alert>}

        {issued ? (
          <IssuedToken secret={issued} onDone={() => setIssued(null)} />
        ) : (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              create.mutate();
            }}
            className="flex max-w-md flex-col gap-4"
          >
            <TextField
              label="What is connecting?"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="Shown in the list below, so you can tell which one to switch off later."
              placeholder="Claude on the laptop"
              maxLength={60}
              required
            />

            <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface-2 p-3">
              <div>
                <p className="text-quiet font-medium text-ink">Allow changes</p>
                <p className="mt-1 text-quiet text-muted">
                  {allowChanges
                    ? 'It can also sort transactions into delegations and edit the rules that do that automatically.'
                    : 'Read-only. It can see the budget and nothing else.'}
                </p>
              </div>
              <Toggle
                checked={allowChanges}
                onChange={setAllowChanges}
                label="Allow this connection to make changes"
              />
            </div>

            <SelectField label="Expires" value={expiry} onChange={setExpiry}>
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </SelectField>

            <div>
              <Button type="submit" variant="primary" disabled={create.isPending}>
                {create.isPending ? 'Working…' : 'Create connection'}
              </Button>
            </div>
          </form>
        )}
      </SettingsCard>

      <SettingsCard
        title="What a connection can never do"
        description="These hold whichever way the switch above is set."
      >
        <ul className="flex list-disc flex-col gap-1 pl-5 text-quiet text-muted">
          <li>Move money — no delegate run, no transfer, no manual adjustment, no reconciling.</li>
          <li>Archive anything, or restore it.</li>
          <li>
            Apply a rule to past transactions. It can write a rule; running one over history
            overwrites categorizations made by hand, and that stays a decision you make here.
          </li>
          <li>Read or change settings, users, two-factor, remote access, sync or Bitcoin.</li>
          <li>Create another connection, or revoke this one.</li>
        </ul>
      </SettingsCard>

      <ConnectorCard />

      <SettingsCard
        title="Connections"
        description="Everything that has ever been issued, including what has been switched off."
      >
        {rows.length === 0 ? (
          <p className="text-quiet text-muted">Nothing is connected.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                onRevoke={() => revoke.mutate(token.id)}
                pending={revoke.isPending}
              />
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

/**
 * Installing the connector, without a terminal anywhere in it.
 *
 * The address is shown rather than assumed. Whatever this page was reached on
 * is, by definition, an address that reaches the budget from this machine — so
 * it is the right thing to paste, and guessing at a LAN IP would not be.
 */
function ConnectorCard(): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const address = window.location.origin;

  const download = useMutation({
    mutationFn: downloadConnector,
    onSuccess: () => setProblem(null),
    onError: (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'The connector could not be downloaded.'),
  });

  async function copyAddress(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SettingsCard
      title="Set up Claude Desktop"
      description="Install the connector, then paste the two things it asks for."
    >
      {problem && <Alert>{problem}</Alert>}

      <ol className="flex list-decimal flex-col gap-3 pl-5 text-quiet text-muted">
        <li>Create a connection above and copy the key.</li>
        <li>
          Download the connector.
          <div className="mt-2">
            <Button
              type="button"
              variant="primary"
              onClick={() => download.mutate()}
              disabled={download.isPending}
            >
              {download.isPending ? 'Preparing…' : 'Download connector'}
            </Button>
          </div>
        </li>
        <li>
          In Claude Desktop, open <strong>Settings → Extensions</strong> and drag{' '}
          <code className="font-mono">delegate.mcpb</code> onto the page.
        </li>
        <li>
          It will ask for two things. The key you copied, and this address:
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-quiet text-ink">
              {address}
            </code>
            <Button type="button" onClick={() => void copyAddress()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </li>
      </ol>

      <p className="mt-4 text-quiet text-muted">
        Then ask Claude what the balance on your budget is. If nothing happens, the address above
        has to be one the computer running Claude can reach — the same one you are reading this page
        on will do.
      </p>
    </SettingsCard>
  );
}

/** The one and only sight of the token. */
function IssuedToken({
  secret,
  onDone,
}: {
  readonly secret: string;
  readonly onDone: () => void;
}): ReactNode {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Copy, or fall back to selecting it.
   *
   * `navigator.clipboard` does not exist outside a secure context, and the LAN
   * address is plain http by decision (ADR 017) — so on the very deployment
   * this was written for, the obvious implementation is `undefined`. Selecting
   * the text leaves one keystroke to do, which beats a button that silently
   * does nothing.
   */
  async function copy(): Promise<void> {
    field.current?.select();
    try {
      await navigator.clipboard?.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning">
        Copy this now. It is not stored anywhere it can be read back, so this is the only time it
        will be shown.
      </Alert>

      <input
        ref={field}
        readOnly
        value={secret}
        aria-label="The new connection key"
        onFocus={(event) => event.target.select()}
        className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-quiet text-ink"
      />

      <div className="flex items-center gap-2">
        <Button type="button" variant="primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

function TokenRow({
  token,
  onRevoke,
  pending,
}: {
  readonly token: ApiTokenDto;
  readonly onRevoke: () => void;
  readonly pending: boolean;
}): ReactNode {
  const dead = token.revokedAt !== null || isExpired(token);

  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className={dead ? 'opacity-60' : ''}>
        <div className="flex items-center gap-2">
          <span className="text-quiet font-medium text-ink">{token.name}</span>
          <Tag>{token.scope === 'read_write' ? 'Can make changes' : 'Read-only'}</Tag>
          {token.revokedAt !== null && <Tag>Switched off</Tag>}
          {token.revokedAt === null && isExpired(token) && <Tag>Expired</Tag>}
        </div>
        <p className="mt-1 text-quiet text-muted">{describe(token)}</p>
      </div>

      {!dead && (
        <Button type="button" onClick={onRevoke} disabled={pending}>
          Switch off
        </Button>
      )}
    </li>
  );
}

function isExpired(token: ApiTokenDto): boolean {
  return token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
}

/** One line of plain English, rather than four labelled timestamps. */
function describe(token: ApiTokenDto): string {
  const parts = [`Created by ${token.username} on ${day(token.createdAt)}`];

  parts.push(token.lastUsedAt === null ? 'never used' : `last used ${day(token.lastUsedAt)}`);

  if (token.revokedAt !== null) parts.push(`switched off ${day(token.revokedAt)}`);
  else if (token.expiresAt === null) parts.push('does not expire');
  else parts.push(`${isExpired(token) ? 'expired' : 'expires'} ${day(token.expiresAt)}`);

  return `${parts.join(' · ')}.`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}
