import { routeFor } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { nodeApi } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';

/**
 * Settings → Bitcoin → where address data comes from.
 *
 * One box, and the address decides everything else. A scheme, the `/api` path
 * and whether to use Tor were three separate things to get right, and every one
 * of them is something the program can work out from what was typed:
 *
 *  * a LAN address goes direct — Tor would route around the house to get back
 *    into it, and hide nothing from anybody already inside;
 *  * an onion address goes over Tor, which is its only route in existence;
 *  * anything else prefers Tor and falls back to a direct connection, so a
 *    hidden IP address is not paid for with a missing balance.
 *
 * The fallback is reported rather than assumed. "Reached directly, Tor was not
 * available" is a different fact from "reached over Tor", and only one of them
 * is what was wanted.
 */

const ROUTE_NOTE: Record<'direct' | 'tor' | 'prefer-tor', string> = {
  direct: 'On your own network, so it is reached directly. Nothing leaves the house.',
  tor: 'An onion address, so it goes over Tor. That is its only route.',
  'prefer-tor':
    'On the public internet. Delegate will try Tor first to hide which household is asking, and connect directly if Tor is unavailable — it says which happened.',
};

export function BitcoinNodeSection(): ReactNode {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'positive' | 'danger'; text: string } | null>(null);

  const node = useQuery({ queryKey: ['bitcoin', 'node'], queryFn: nodeApi.get });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'node'] });
  };

  const describe = (route: string | null, height: number | null): string => {
    const where = route === 'tor' ? 'over Tor' : 'directly';
    return `Answered ${where}. The chain is at block ${height?.toLocaleString() ?? '—'}.`;
  };

  const save = useMutation({
    mutationFn: (baseUrl: string) =>
      nodeApi.save(baseUrl === '' ? { mode: 'none' } : { mode: 'esplora', baseUrl }),
    onSuccess: async (saved) => {
      setProblem(null);
      setTyped(null);
      setResult(
        saved.baseUrl === null
          ? null
          : saved.reached
            ? {
                tone: 'positive',
                text: `${describe(saved.route, saved.height)} Using ${saved.baseUrl}.`,
              }
            : {
                tone: 'danger',
                // Saved anyway: being unable to configure a node because it
                // happens to be down would be worse than saying so.
                text: `Saved, but it did not answer: ${saved.error ?? 'no reason given'}`,
              },
      );
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  const check = useMutation({
    mutationFn: nodeApi.check,
    onSuccess: async (checked) => {
      setResult(
        checked.ok
          ? { tone: 'positive', text: describe(checked.route, checked.height) }
          : { tone: 'danger', text: checked.error ?? 'It did not answer.' },
      );
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not reach it.'),
  });

  const data = node.data;
  const value = typed ?? data?.baseUrl ?? '';
  // Worked out as it is typed, so what will happen is visible before saving.
  const route =
    value.trim() === '' ? null : routeFor(value.includes('://') ? value : `https://${value}`);

  function submit(event: FormEvent): void {
    event.preventDefault();
    save.mutate(value.trim());
  }

  return (
    /*
     * The fields, without a card of their own.
     *
     * Where address data comes from is a property of the Bitcoin holdings it
     * serves, not a second subject — it was a card beside them saying so at the
     * same weight. It sits inside that card now, under a rule.
     */
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-quiet font-semibold text-ink">Where address data comes from</h3>
      <p className="mb-4 text-quiet text-muted">Needed to watch a wallet.</p>

      {problem && <Alert tone="danger">{problem}</Alert>}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <TextField
          width="lg"
          label="Node address"
          value={value}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="192.168.1.50:3002 · mempool.space · abc…xyz.onion"
          hint="A LAN address, a domain name, or an onion address."
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Checking…' : 'Save'}
          </Button>
          <Button
            onClick={() => check.mutate()}
            disabled={check.isPending || data?.mode === 'none'}
          >
            {check.isPending ? 'Asking…' : 'Test it'}
          </Button>
        </div>
      </form>

      {route && <p className="mt-2 text-quiet text-muted">{ROUTE_NOTE[route]}</p>}

      {/* Said where the endpoint is chosen, not in a footnote: this is the
          decision that costs something, and it is not reversible afterwards. */}
      {route === 'prefer-tor' && (
        <p className="mt-1 text-quiet text-muted">
          A public server sees every address you look up. Tor hides who is asking, not what is asked
          — only your own node answers that.
        </p>
      )}

      {result && <Alert tone={result.tone}>{result.text}</Alert>}

      {data && data.mode !== 'none' && !result && (
        <p className="mt-2 text-quiet text-muted">
          {data.lastCheckedAt === null
            ? 'Not tried yet.'
            : data.lastError
              ? `Last tried ${data.lastCheckedAt.slice(0, 10)} and failed: ${data.lastError}`
              : `Last answered ${data.lastRoute === 'tor' ? 'over Tor' : 'directly'}, at block ${data.lastHeight?.toLocaleString() ?? '—'}.`}
        </p>
      )}

      {data && data.suggestions.length > 0 && (
        <div className="mt-4">
          <p className="text-label uppercase tracking-[0.05em] text-muted">Public options</p>
          <ul className="mt-1 flex flex-col gap-1">
            {data.suggestions.map((suggestion) => (
              <li key={suggestion.url} className="text-quiet">
                <button
                  type="button"
                  onClick={() => setTyped(suggestion.url)}
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
    </div>
  );
}
