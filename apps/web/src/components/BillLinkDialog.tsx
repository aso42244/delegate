import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { recurringApi, type BillDto } from '../api/recurring.js';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * Telling a bill that its charge did arrive.
 *
 * Every bill on that page is worked out from the register, and the detection
 * connects charges by merchant name. Two things it cannot reach, both from the
 * first real run: a payment still **pending** — excluded on purpose, because a
 * pending date moves when it settles — and a merchant that **renamed itself**,
 * whose new charges land under a key the old bill has never seen. Either way the
 * money has plainly gone and the row says Overdue.
 *
 * So: point at the charge. The bill's last-seen date moves to it and its next
 * date moves with it. **The cadence does not change** — a link is a correction,
 * not evidence about the schedule, and letting one into the interval arithmetic
 * could put a gap in the history that no longer fits and drop the bill off the
 * page altogether.
 */

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function BillLinkDialog({
  bill,
  onClose,
}: {
  readonly bill: BillDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ['bill-link-candidates', bill.key, search],
    queryFn: () =>
      recurringApi.linkCandidates({
        expectedNextAt: bill.expectedNextAt,
        typicalAmountCents: bill.typicalAmountCents,
        search,
      }),
  });

  const existing = useQuery({
    queryKey: ['bill-links', bill.key],
    queryFn: () => recurringApi.links(bill.key),
  });

  /** Both mutations answer the same way: the page's reading of it has changed. */
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['recurring'] });
    await queryClient.invalidateQueries({ queryKey: ['bill-links', bill.key] });
    await queryClient.invalidateQueries({ queryKey: ['bill-link-candidates', bill.key] });
    // A bill that is no longer overdue raises nothing, so the pill may have gone.
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const link = useMutation({
    mutationFn: (transactionId: string) => recurringApi.link(bill.key, transactionId),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That charge could not be attached.'),
  });

  const unlink = useMutation({
    mutationFn: (transactionId: string) => recurringApi.unlink(transactionId),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That charge could not be detached.'),
  });

  const attached = existing.data?.links ?? [];
  const offered = candidates.data?.candidates ?? [];

  return (
    <Modal
      label={`Attach a charge to ${bill.name}`}
      title="The charge did arrive"
      description="Point at the payment. This bill's last-seen date moves to it; its cadence does not change."
      // Wide, because the whole job here is reading feed descriptions and
      // deciding which one is the payment. At `md` they truncate to about
      // twenty characters, which is the one thing this dialog must not do.
      width="lg"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {attached.length > 0 && (
          <section>
            <h3 className="text-quiet font-semibold text-ink">Already attached</h3>
            <ul className="mt-1 flex flex-col">
              {attached.map((charge) => (
                <li
                  key={charge.transactionId}
                  className="flex items-center gap-2 border-b border-line py-2 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-quiet text-ink" title={charge.description}>
                      {charge.description}
                    </p>
                    <p className="text-label text-muted">
                      {shortDate(charge.postedAt)}
                      {charge.pending && ' · pending'}
                    </p>
                  </div>
                  <span className="money shrink-0 text-quiet text-ink">
                    {formatCents(BigInt(charge.amountCents))}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => unlink.mutate(charge.transactionId)}
                    disabled={unlink.isPending}
                    aria-label={`Detach ${charge.description} from ${bill.name}`}
                  >
                    Detach
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <TextField
          label="Search the register"
          width="full"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Charges near ${shortDate(bill.expectedNextAt)}`}
          autoComplete="off"
        />

        {problem && <Alert>{problem}</Alert>}

        {candidates.isLoading ? (
          <p className="text-quiet text-muted">Loading…</p>
        ) : offered.length === 0 ? (
          <p className="text-quiet text-muted">
            {search === ''
              ? 'No charges around the date this was expected. Search to reach the whole register.'
              : 'Nothing in the register matches that.'}
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col overflow-y-auto">
            {offered.map((candidate) => (
              <li
                key={candidate.id}
                className="flex items-center gap-2 border-b border-line py-2 last:border-0"
              >
                {/* Two lines rather than one: a feed description is long, and
                    the amount and date beside it are short. On one line the
                    description is the only thing that can give way, and it gives
                    way to about twenty characters — which is the one thing this
                    list must not do, since reading it is the entire task. */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-quiet text-ink" title={candidate.description}>
                    {candidate.description}
                  </p>
                  <p className="text-label text-muted">
                    {shortDate(candidate.postedAt)}
                    {candidate.pending && ' · pending'} · {candidate.accountName}
                    {/* Said here rather than found out afterwards: attaching
                        this takes it off whatever bill it is on now. */}
                    {candidate.linkedElsewhere && (
                      <span className="ml-2 text-warning">on another bill</span>
                    )}
                  </p>
                </div>
                <span className="money shrink-0 text-quiet text-ink">
                  {formatCents(BigInt(candidate.amountCents))}
                </span>
                <Button
                  onClick={() => link.mutate(candidate.id)}
                  disabled={link.isPending}
                  aria-label={`Attach ${candidate.description} to ${bill.name}`}
                >
                  This one
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
