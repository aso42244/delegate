import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { apiTokensApi, type ApiTokenDto } from '../../api/api-tokens.js';
import { CopyButton } from '../../components/CopyButton.jsx';
import { EmptyState } from '../../components/layout.jsx';
import { DANGER_ITEM_CLASS, RowMenuShell } from '../../components/RowMenuShell.jsx';
import { Alert, Button, Modal, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Access → API tokens (ADR 071).
 *
 * A token is a credential for a program that reads this budget as you — the
 * door Eventide comes through. Two things this card exists to make visible,
 * because the visibility is half of why the credential shape is safe at all:
 * **when each token was last used, and from where.** A machine nobody is
 * running any more is obvious here before anybody has to wonder about it.
 *
 * The secret is shown once, at creation, in the dialog that made it. Delegate
 * keeps a hash and cannot show it again, and the dialog says so rather than
 * assuming anybody reads a subtitle. It is deliberately not `dismissible`: a
 * stray click beside the card would lose the only copy.
 *
 * A card on Access rather than a section of its own: Settings is grouped by the
 * question somebody came to answer, Access is "who gets in and how", and a
 * section holding a single card is exactly what v0.46 removed twelve tabs down
 * to eight to stop.
 */

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

/** Creating one, then holding the only copy of its secret until Done. */
function NewTokenDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const secretRef = useRef<HTMLParagraphElement>(null);

  const create = useMutation({
    mutationFn: () => apiTokensApi.create(name.trim()),
    onSuccess: async ({ token, secret }) => {
      setProblem(null);
      setIssued({ name: token.name, secret });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-events'] }),
      ]);
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  if (issued) {
    return (
      <Modal
        label={`Token for ${issued.name}`}
        title={`Token for ${issued.name}`}
        description="Shown once. Copy it now — Delegate keeps only a hash and cannot show it again."
        onClose={onClose}
      >
        <div className="flex flex-col gap-2">
          <p
            ref={secretRef}
            className="rounded border border-line bg-surface-2 p-3 font-mono text-quiet break-all text-ink"
          >
            {issued.secret}
          </p>
          <CopyButton value={issued.secret} displayRef={secretRef} describes="Copy the token" />
          <p className="text-quiet text-muted">
            Sent as <span className="font-mono">Authorization: Bearer …</span>. It reads the budget
            as you and nothing else.
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      label="New token"
      title="New token"
      description="Named for the application that will hold it. It reads the budget as you, and only reads."
      onClose={onClose}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-2"
      >
        <TextField
          width="full"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="Eventide"
          autoComplete="off"
          required
        />

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? 'Working…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TokenRow({ token }: { readonly token: ApiTokenDto }): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const revoked = token.revokedAt !== null;

  const revoke = useMutation({
    mutationFn: () => apiTokensApi.revoke(token.id),
    onSuccess: async () => {
      setProblem(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-events'] }),
      ]);
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  return (
    <>
      <tr className="group border-b border-line last:border-0 hover:bg-surface">
        <td className={`row-cell overflow-hidden pl-1 ${revoked ? 'text-faint' : 'text-ink'}`}>
          <span className="block truncate">{token.name}</span>
        </td>

        {/* The phone column policy: the name and its state, and the rest only
            where the card has room. Measured against the card, not the window
            (ui-system.md §6). */}
        <td className="hidden row-cell w-40 text-quiet text-muted @sm:table-cell">
          {token.lastUsedAt === null ? 'Never' : new Date(token.lastUsedAt).toLocaleString()}
        </td>

        <td className="hidden row-cell w-32 truncate text-quiet text-faint @md:table-cell">
          {token.lastUsedFrom ?? '—'}
        </td>

        <td className="row-cell w-20 text-quiet text-muted">{revoked ? 'Revoked' : 'Active'}</td>

        <td className="hold-to-open-cell row-cell">
          {!revoked && (
            <RowMenuShell name={token.name}>
              {(controls) => (
                <button
                  type="button"
                  role="menuitem"
                  className={DANGER_ITEM_CLASS}
                  onClick={() => {
                    revoke.mutate();
                    controls.close();
                  }}
                >
                  Revoke
                </button>
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

export function ApiTokensCard(): ReactNode {
  const [creating, setCreating] = useState(false);
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: apiTokensApi.list });

  return (
    <>
      <SettingsCard
        span="half"
        title="API tokens"
        description="Read-only access to your budget for another application."
        action={<Button onClick={() => setCreating(true)}>New token</Button>}
      >
        {tokens.isLoading ? (
          <p className="text-quiet text-muted">Loading tokens…</p>
        ) : (tokens.data?.tokens.length ?? 0) === 0 ? (
          <EmptyState>No tokens yet.</EmptyState>
        ) : (
          <table className="w-full border-t-2 border-ink">
            <thead>
              <tr className="text-label uppercase tracking-label text-muted">
                <th className="row-cell pl-1 text-left font-normal">Name</th>
                <th className="hidden row-cell w-40 text-left font-normal @sm:table-cell">
                  Last used
                </th>
                <th className="hidden row-cell w-32 text-left font-normal @md:table-cell">From</th>
                <th className="row-cell w-20 text-left font-normal">Status</th>
                <th className="hold-to-open-cell row-cell" />
              </tr>
            </thead>
            <tbody>
              {tokens.data?.tokens.map((token) => (
                <TokenRow key={token.id} token={token} />
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

      {creating && <NewTokenDialog onClose={() => setCreating(false)} />}
    </>
  );
}
