import { formatBitcoin } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { walletsApi } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';

/**
 * Wallets watched by extended public key or descriptor.
 *
 * The key goes in and never comes back out: it is stored encrypted and the
 * interface identifies a wallet by its first address instead. That address is
 * public — it is the one people send to — so showing it costs nothing, while
 * showing the key back would put every address the wallet will ever use on the
 * screen and into any screenshot of it.
 */

export function WatchedWallets({ accountId }: { readonly accountId: string }): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');

  const wallets = useQuery({
    queryKey: ['bitcoin', 'wallets', accountId],
    queryFn: () => walletsApi.list(accountId),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const add = useMutation({
    mutationFn: () => walletsApi.add(accountId, { label: label.trim(), key: key.trim() }),
    onSuccess: async () => {
      setProblem(null);
      setLabel('');
      // Cleared immediately: there is no reason for it to sit on screen.
      setKey('');
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not add that wallet.'),
  });

  const scan = useMutation({
    mutationFn: walletsApi.scan,
    onSuccess: async (result) => {
      setProblem(null);
      setDone(
        `Looked at ${result.addressesChecked} addresses, ${result.used} used. ${
          result.recorded ? 'The holding was updated.' : 'Nothing had changed.'
        }`,
      );
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'The scan failed.'),
  });

  const archive = useMutation({
    mutationFn: walletsApi.archive,
    onSuccess: refresh,
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not stop watching that.'),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (label.trim() === '' || key.trim() === '') {
      setProblem('Both a name and a key are needed.');
      return;
    }
    add.mutate();
  }

  const list = wallets.data?.wallets ?? [];

  return (
    <div className="mt-3">
      <p className="text-label uppercase tracking-[0.05em] text-muted">Watched wallets</p>

      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && <Alert tone="positive">{done}</Alert>}

      {list.length > 0 && (
        <table className="mt-2 w-full">
          <tbody>
            {list.map((wallet) => (
              <tr key={wallet.id} className="border-b border-line last:border-0">
                <td className="row-cell pl-1">
                  <span className="text-ink">{wallet.label}</span>
                  <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
                    {wallet.kind}
                  </span>
                  {/* How the owner recognises it, without the key on screen. */}
                  <div className="text-label text-muted">
                    from {wallet.firstAddress.slice(0, 12)}…{wallet.firstAddress.slice(-6)}
                  </div>
                </td>
                <td className="money row-cell pr-2 text-right text-ink">
                  {wallet.lastBalanceSats === null ? (
                    <span className="text-faint">not scanned</span>
                  ) : (
                    formatBitcoin(BigInt(wallet.lastBalanceSats))
                  )}
                </td>
                <td className="row-cell text-quiet text-muted">
                  {wallet.lastError
                    ? `failed: ${wallet.lastError}`
                    : wallet.lastScannedAt
                      ? `${wallet.addressesSeen} addresses`
                      : ''}
                </td>
                <td className="row-cell text-right">
                  <button
                    type="button"
                    onClick={() => scan.mutate(wallet.id)}
                    disabled={scan.isPending}
                    className="mr-3 text-quiet text-accent underline"
                  >
                    {scan.isPending ? 'Scanning…' : 'Scan now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => archive.mutate(wallet.id)}
                    aria-label={`Stop watching ${wallet.label}`}
                    className="text-quiet text-muted underline"
                  >
                    Stop watching
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-3">
        <TextField
          label="Wallet name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Cold storage"
        />
        <div className="min-w-96 flex-1">
          <TextField
            label="Extended public key or descriptor"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="zpub… or wsh(sortedmulti(2,…))"
            hint="xpub, ypub, zpub, or a descriptor for a multisig. It is stored encrypted and never shown again."
          />
        </div>
        <div className="pb-1">
          <Button type="submit" disabled={add.isPending}>
            Watch
          </Button>
        </div>
      </form>
    </div>
  );
}
