import { nodeUrlProblem, reachOf } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { nodeApi } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Bitcoin → where address data comes from.
 *
 * The choice that matters here is not which endpoint is fastest. It is that a
 * public one learns every address in the wallet, permanently, and that fact
 * belongs beside the choice rather than in a footnote somewhere.
 */

const REACH_NOTE: Record<'public' | 'lan' | 'tor', string> = {
  public:
    'A public server. It will see every address Delegate asks about, and can keep them — which is the whole of your wallet, forever. Your own node is the only real answer to that.',
  lan: 'A node on your own network. Nothing leaves the house.',
  tor: 'An onion service. The address is itself a public key, so the connection is already encrypted and authenticated — plain http here is correct rather than a downgrade.',
};

export function BitcoinNodeSection(): ReactNode {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [torChoice, setTorChoice] = useState<boolean | null>(null);

  const node = useQuery({ queryKey: ['bitcoin', 'node'], queryFn: nodeApi.get });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'node'] });
  };

  const save = useMutation({
    mutationFn: (input: { mode: 'none' | 'esplora'; baseUrl?: string | null; useTor?: boolean }) =>
      nodeApi.save(input),
    onSuccess: async () => {
      setProblem(null);
      setChecked(null);
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  const check = useMutation({
    mutationFn: nodeApi.check,
    onSuccess: async (result) => {
      setChecked(
        result.ok
          ? `Answered. The chain is at block ${result.height?.toLocaleString() ?? '—'}.`
          : (result.error ?? 'It did not answer.'),
      );
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not reach it.'),
  });

  const data = node.data;
  const value = url ?? data?.baseUrl ?? '';
  // Checked as it is typed, so the reason arrives before the save is attempted.
  const typedProblem = value.trim() === '' ? null : nodeUrlProblem(value);
  const reach = typedProblem ? null : reachOf(value);
  // An onion address has no route except through the proxy, so the choice is
  // made for it rather than offered and then refused on save.
  const tor = reach === 'tor' ? true : (torChoice ?? data?.useTor ?? false);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (value.trim() === '') {
      save.mutate({ mode: 'none' });
      return;
    }
    const found = nodeUrlProblem(value);
    if (found) {
      setProblem(found.message);
      return;
    }
    save.mutate({ mode: 'esplora', baseUrl: value.trim(), useTor: tor });
  }

  return (
    <SettingsCard
      title="Where address data comes from"
      description="Needed to watch a wallet. Nothing here is used until one is set."
    >
      {problem && <Alert tone="danger">{problem}</Alert>}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-80 flex-1">
          <TextField
            label="Node URL"
            value={value}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mempool.space/api"
            hint="Leave blank to use no node at all."
          />
        </div>
        <div className="pb-1 flex gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
          <Button
            onClick={() => check.mutate()}
            disabled={check.isPending || data?.mode === 'none'}
          >
            {check.isPending ? 'Asking…' : 'Test it'}
          </Button>
        </div>
      </form>

      {/* The refusal explains itself as it is typed, rather than after a save. */}
      {typedProblem && <Alert tone="warning">{typedProblem.message}</Alert>}

      {reach && <p className="mt-2 text-quiet text-muted">{REACH_NOTE[reach]}</p>}

      <label className="mt-2 flex items-center gap-2 text-quiet text-ink">
        <input
          type="checkbox"
          checked={tor}
          disabled={reach === 'tor'}
          onChange={(event) => setTorChoice(event.target.checked)}
        />
        Reach it over Tor
        {reach === 'tor' && <span className="text-muted">— required for an onion address</span>}
      </label>
      <p className="text-label text-muted">
        Needs a Tor proxy alongside Delegate. The bundled <code>tor</code> service provides one; see
        the deployment notes.
      </p>

      {checked && <Alert tone={check.data?.ok ? 'positive' : 'danger'}>{checked}</Alert>}

      {data && data.mode !== 'none' && !checked && (
        <p className="mt-2 text-quiet text-muted">
          {data.lastCheckedAt === null
            ? 'Not tried yet.'
            : data.lastError
              ? `Last tried ${data.lastCheckedAt.slice(0, 10)} and failed: ${data.lastError}`
              : `Last answered at block ${data.lastHeight?.toLocaleString() ?? '—'}.`}
        </p>
      )}

      {data && data.suggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-label uppercase tracking-[0.05em] text-muted">Public options</p>
          <ul className="mt-1 flex flex-col gap-1">
            {data.suggestions.map((suggestion) => (
              <li key={suggestion.url} className="text-quiet">
                <button
                  type="button"
                  onClick={() => setUrl(suggestion.url)}
                  className="font-semibold text-accent underline"
                >
                  {suggestion.label}
                </button>
                <span className="ml-2 text-muted">{suggestion.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsCard>
  );
}
