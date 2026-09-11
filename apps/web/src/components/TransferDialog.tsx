import { formatCents } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { budgetApi, type BudgetSectionDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal, SelectField, TextField } from './ui.jsx';

/**
 * Moving money between envelopes.
 *
 * It lived in `pages/MainBudget.tsx` while the Budget page was the only screen
 * that could open it. The `New …` menu already imported it from there (ADR 057
 * keeps a dialog with the screen that owns the thing it makes), and the Overview
 * band's row menu now offers it too — so the screen that owns it is no longer a
 * page, and a dialog imported out of a page by two other files is a dialog that
 * has outgrown its home.
 */
/**
 * The options, grouped exactly as the page beneath is grouped.
 *
 * A flat alphabetical list meant finding "Fuel" in the dialog was a different
 * act from finding it on the page — and this dialog is always opened while
 * looking at that page. Groupings first, then the ungrouped lines, which is the
 * order `buildBudgetView` returns and the order the sections render in.
 *
 * The balance is in the label rather than reported under the select once a
 * choice is made. Deciding where to move money from means comparing what the
 * candidates hold, and that comparison has to be possible *while* the list is
 * open.
 */
function TransferOptions({
  section,
  exclude,
}: {
  readonly section: BudgetSectionDto;
  /** The other side of the transfer, which cannot also be this side. */
  readonly exclude: string;
}): ReactNode {
  const label = (row: { name: string; balanceCents: string }): string =>
    `${row.name} — ${formatCents(BigInt(row.balanceCents))}`;

  return (
    <>
      {section.groupings.map((grouping) => {
        const rows = grouping.rows.filter((row) => row.id !== exclude);
        if (rows.length === 0) return null;

        return (
          <optgroup key={grouping.id} label={grouping.name}>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {label(row)}
              </option>
            ))}
          </optgroup>
        );
      })}

      {/* Ungrouped lines sit after the groupings, as they do on the page. */}
      {section.ungrouped
        .filter((row) => row.id !== exclude)
        .map((row) => (
          <option key={row.id} value={row.id}>
            {label(row)}
          </option>
        ))}
    </>
  );
}

export function TransferDialog({
  section,
  initialFrom,
  onClose,
}: {
  /** The delegations section of the budget, in the order the page shows it. */
  readonly section: BudgetSectionDto;
  /** Preset when Transfer was reached from a blocked archive. */
  initialFrom?: string | undefined;
  onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(initialFrom ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: () => {
      const parsed = /^-?\d+(\.\d{1,2})?$/.exec(amount.trim());
      if (!parsed) throw new ApiError(400, 'invalid_amount', 'Enter an amount like 25.00.');

      const [whole, fraction = ''] = amount.trim().replace('$', '').split('.');
      const cents = BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
      return budgetApi.transfer(from, to, cents.toString());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not transfer.'),
  });

  return (
    /*
     * `Modal`, like every other dialog here.
     *
     * This one and Delegate below it were hand-rolled `fixed inset-0` overlays
     * — the only two left in the application — and being hand-rolled cost them
     * both of the things ADR 038 bought everything else. They were centred cards
     * on a phone rather than sheets rising from the edge, and they measured
     * themselves against the *window*: on iOS the software keyboard is drawn
     * over the page, so a card holding a typed amount and its Transfer button
     * sat underneath the keys, and this is the dialog somebody opens to type an
     * amount. Escape did not close them either.
     */
    <Modal
      label="Transfer between delegations"
      title="Transfer"
      description="Moves money between envelopes. The total does not change, and the source may go negative."
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {problem && <Alert>{problem}</Alert>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => transfer.mutate()}
              disabled={from === '' || to === '' || amount.trim() === '' || transfer.isPending}
            >
              {transfer.isPending ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <SelectField label="From" width="full" value={from} onChange={setFrom}>
          <option value="">Choose a delegation</option>
          <TransferOptions section={section} exclude={to} />
        </SelectField>

        <SelectField label="To" width="full" value={to} onChange={setTo}>
          <option value="">Choose a delegation</option>
          <TransferOptions section={section} exclude={from} />
        </SelectField>

        {/* `sm`, not `full`. A figure is not open-ended content, and a box the
            width of a sentence to hold $575.00 reads as a mistake — ui-system.md
            §2, which this dialog was the last place ignoring. */}
        <TextField
          label="Amount"
          width="sm"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="25.00"
          className="money"
        />
      </div>
    </Modal>
  );
}
