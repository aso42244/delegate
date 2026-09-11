import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  budgetApi,
  type BudgetRowDto,
  type BudgetSectionDto,
  type BudgetViewDto,
} from '../api/budget.js';
import { accountsApi } from '../api/accounts.js';
import { checksApi, type CheckMatchDto } from '../api/checks.js';
import { settingsApi } from '../api/settings.js';
import { ApiError } from '../api/client.js';
import { AccountRowMenu } from '../components/AccountRowMenu.jsx';
import { useBudgetLayout } from '../budget-layout.js';
import { PageHeader } from '../components/layout.jsx';
import { AbsorbDialog } from '../components/AbsorbDialog.jsx';
import { BudgetSection } from '../components/BudgetSection.jsx';
import { CheckRowMenu } from '../components/CheckRowMenu.jsx';
import { ConfirmCheckMatchDialog } from '../components/ConfirmCheckMatchDialog.jsx';
import { DelegationRowMenu } from '../components/DelegationRowMenu.jsx';
import { NewCheckDialog } from '../components/NewCheckDialog.jsx';
import { NewTransactionDialog } from '../components/NewTransactionDialog.jsx';
import { Alert, Button, Modal, SelectField, TextField } from '../components/ui.jsx';

/**
 * The Budget page — the page that replaces the spreadsheet.
 *
 * Every mutation invalidates the whole view rather than patching a row locally.
 * The identity at the top depends on all three sections at once, so a partial
 * update would leave the headline figure disagreeing with the rows beneath it,
 * which is the one thing this page cannot do.
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

export function MainBudget(): ReactNode {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'none' | 'transfer' | 'check' | 'transaction'>('none');
  const [problem, setProblem] = useState<string | null>(null);
  // Set when Transfer was opened from a line whose archive was blocked.
  const [transferFrom, setTransferFrom] = useState<string | null>(null);
  /** The line the budget's reading is being closed against, if any. */
  const [absorbing, setAbsorbing] = useState<BudgetRowDto | null>(null);
  /** The proposed check match being confirmed, if any. */
  const [confirmingCheck, setConfirmingCheck] = useState<CheckMatchDto | null>(null);

  // Chosen on Settings → Display and remembered per device. Read here rather
  // than passed down: it decides only where the three sections sit, and no
  // section needs to know which arrangement it is in.
  const [budgetLayout] = useBudgetLayout();

  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  /*
   * The pay cadence, for a target's per-paycheck figure.
   *
   * The same cache key Settings uses, so this is a read of what is already
   * there rather than a second request. `biweekly` is the product default and
   * the right fallback while it loads: the dialog it feeds recomputes the
   * moment the real answer arrives.
   */
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const cadence = settings.data?.payCadence ?? 'biweekly';

  /*
   * Checks the bank appears to have cashed. A sync proposes these and never
   * settles them — ADR 030 — so the row has to offer the confirmation, and the
   * purple banner at the top of the page has to have something to point at.
   */
  const checkMatches = useQuery({ queryKey: ['checkMatches'], queryFn: checksApi.matches });
  const matchByCheckId = new Map(
    (checkMatches.data?.matches ?? []).map((match) => [match.checkId, match]),
  );

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  /** The same view with one grouping folded or unfolded, and nothing else touched. */
  const withGroupingCollapsed = (
    view: BudgetViewDto,
    groupingId: string,
    collapsed: boolean,
  ): BudgetViewDto => {
    const inSection = (section: BudgetSectionDto): BudgetSectionDto => ({
      ...section,
      groupings: section.groupings.map((grouping) =>
        grouping.id === groupingId ? { ...grouping, collapsed } : grouping,
      ),
    });

    return {
      ...view,
      assets: inSection(view.assets),
      debts: inSection(view.debts),
      delegations: inSection(view.delegations),
    };
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Something went wrong.');

  const editAmount = useMutation({
    mutationFn: ({ id, cents }: { id: string; cents: bigint }) =>
      budgetApi.updateDelegation(id, { amountToDelegateCents: cents.toString() }),
    onSuccess: refresh,
    onError,
  });

  const editBalance = useMutation({
    // The server records the difference as an adjust event; the UI never sends a
    // delta it worked out itself.
    mutationFn: ({ id, cents }: { id: string; cents: bigint }) =>
      budgetApi.adjustDelegation(id, cents.toString()),
    onSuccess: refresh,
    onError,
  });

  const createDelegation = useMutation({
    mutationFn: (name: string) => budgetApi.createDelegation(name, null),
    onSuccess: refresh,
    onError,
  });

  const moveDelegation = useMutation({
    mutationFn: ({ id, groupingId }: { id: string; groupingId: string | null }) =>
      budgetApi.updateDelegation(id, { groupingId }),
    onSuccess: refresh,
    onError,
  });

  /**
   * Accounts and groupings, put where somebody dropped them.
   *
   * Assets and Debts are ordered lists now too. The order the household reads
   * its accounts in is a fact about the household, and alphabetical is nobody's
   * reading of it — which is the argument that gave delegations a position in
   * the first place, and is no different one level across.
   */
  const moveAccount = useMutation({
    mutationFn: ({ id, groupingId }: { id: string; groupingId: string | null }) =>
      accountsApi.update(id, { groupingId }),
    onSuccess: refresh,
    onError,
  });

  const placeAccount = useMutation({
    mutationFn: ({
      id,
      groupingId,
      orderedIds,
    }: {
      id: string;
      groupingId: string | null;
      orderedIds: string[];
    }) => budgetApi.placeAccount(id, groupingId, orderedIds),
    onSuccess: refresh,
    onError,
  });

  const reorderGroupings = useMutation({
    mutationFn: ({
      section,
      groupingIds,
    }: {
      section: 'assets' | 'debts' | 'delegations';
      groupingIds: string[];
    }) => budgetApi.reorderGroupings(section, groupingIds),
    onSuccess: refresh,
    onError,
  });

  const placeDelegation = useMutation({
    mutationFn: ({
      id,
      groupingId,
      orderedIds,
    }: {
      id: string;
      groupingId: string | null;
      orderedIds: string[];
    }) => budgetApi.place(id, groupingId, orderedIds),
    onSuccess: refresh,
    onError,
  });

  /**
   * Moves a line one place, for anybody not using a mouse.
   *
   * Drag and drop is the fast route and it is not a keyboard one, so this is
   * the same operation reached from the row menu. It works out the neighbour
   * list here rather than asking the server to interpret "up".
   */
  function nudge(row: BudgetRowDto, direction: -1 | 1): void {
    const siblings =
      row.groupingId === null
        ? view.data!.delegations.ungrouped
        : (view.data!.delegations.groupings.find((grouping) => grouping.id === row.groupingId)
            ?.rows ?? []);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeDelegation.mutate({ id: row.id, groupingId: row.groupingId, orderedIds });
  }

  /**
   * The same, for an account.
   *
   * Dragging is the fast way and it is not an accessible one, so this is not a
   * lesser alternative — it is the one that always works, including under a
   * thumb. The section is passed in because Assets and Debts are separate lists.
   */
  function nudgeAccount(
    section: {
      groupings: readonly { id: string; rows: readonly BudgetRowDto[] }[];
      ungrouped: readonly BudgetRowDto[];
    },
    // The menu's own narrower row shape: it needs an id and a grouping, and the
    // ordering is worked out from the section beside it.
    row: { id: string; groupingId?: string | null | undefined },
    direction: -1 | 1,
  ): void {
    const groupingId = row.groupingId ?? null;
    const siblings =
      groupingId === null
        ? section.ungrouped
        : (section.groupings.find((grouping) => grouping.id === groupingId)?.rows ?? []);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeAccount.mutate({ id: row.id, groupingId, orderedIds });
  }

  /**
   * Collapsing a grouping moves rows, not money.
   *
   * It used to wait for the round trip and then refetch the whole budget before
   * anything on screen changed, which put one to two seconds between the click
   * and the rows moving — for a preference the browser already knows the answer
   * to. The cache is updated first and the request follows; a failure puts it
   * back and says so.
   *
   * Settled rather than left alone. Nothing on this page *changes* because a
   * grouping is folded, so the refetch is not for correctness of the figures —
   * it is because another mutation's invalidation can land on top of an
   * optimistic value and quietly undo it. Re-reading once the write has settled
   * makes the server the last word without costing the instant response, which
   * has already happened by then.
   */
  const toggleGrouping = useMutation({
    mutationFn: ({ id, collapsed }: { id: string; collapsed: boolean }) =>
      budgetApi.setGroupingCollapsed(id, collapsed),
    onMutate: async ({ id, collapsed }: { id: string; collapsed: boolean }) => {
      // An in-flight refetch would land on top of this and undo it.
      await queryClient.cancelQueries({ queryKey: ['budget'] });
      const previous = queryClient.getQueryData<BudgetViewDto>(['budget']);

      queryClient.setQueryData<BudgetViewDto>(['budget'], (current) =>
        current ? withGroupingCollapsed(current, id, collapsed) : current,
      );

      return { previous };
    },
    onError: (error: unknown, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['budget'], context.previous);
      onError(error);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
  });

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the budget…</p>;
  if (view.error || !view.data) {
    return <Alert>Could not load the budget. {String(view.error ?? '')}</Alert>;
  }

  /**
   * Every line spending can be filed against.
   *
   * Outstanding checks are excluded. A check is a delegation, but it is not
   * somewhere spending goes — it is settled by matching the payment that cashes
   * it, which is a different act — so the picker in the new-transaction dialog
   * must not offer one. This is the same filter the Transactions page applies,
   * for the same reason.
   *
   * Transfer does not use this list. It takes the whole section, checks
   * included, because moving money onto or off a check is legitimate — and
   * because its dropdowns mirror the page's own grouping.
   */
  const spendable = [
    ...view.data.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...view.data.delegations.ungrouped,
  ]
    .filter((row) => row.kind !== 'check')
    .map((row) => ({ id: row.id, name: row.name }));

  const groupingOptionsFor = (section: {
    groupings: readonly { id: string; name: string }[];
  }): { id: string; name: string }[] =>
    section.groupings.map((grouping) => ({ id: grouping.id, name: grouping.name }));
  const groupingOptions = groupingOptionsFor(view.data.delegations);

  /*
   * The reading at the top of the page, which decides whether the per-row
   * button appears at all and which direction it offers.
   *
   * Exactly zero is the one case with nothing to do — and it is a real case,
   * because closing the difference against a line is what produces it.
   */
  const difference = BigInt(view.data.identity.differenceCents);

  /**
   * Delegations, built once and placed by the layout.
   *
   * It renders in a different position in each arrangement — first in
   * `columns`, last in `stacked` — and it is the largest block on the page. A
   * variable rather than the JSX written twice: two copies of this would drift,
   * and the one that drifted would be the one nobody had switched to.
   */
  const delegationsSection = (
    <BudgetSection
      title="Delegations"
      section={view.data.delegations}
      showAmountToDelegate
      redNegatives
      onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
      onEditAmount={(id, cents) => editAmount.mutate({ id, cents })}
      onEditBalance={(id, cents) => editBalance.mutate({ id, cents })}
      onCreate={(name) => createDelegation.mutate(name)}
      onMoveToGrouping={(rowId, groupingId) => moveDelegation.mutate({ id: rowId, groupingId })}
      onPlace={(rowId, groupingId, orderedIds) =>
        placeDelegation.mutate({ id: rowId, groupingId, orderedIds })
      }
      onReorderGroupings={(groupingIds) =>
        reorderGroupings.mutate({ section: 'delegations', groupingIds })
      }
      {...(difference === 0n
        ? {}
        : {
            onAbsorb: setAbsorbing,
            absorbLabel: difference > 0n ? 'Move surplus here' : 'Fix deficit from here',
          })}
      rowAffordance={(row) => {
        const match = matchByCheckId.get(row.id);
        if (row.kind !== 'check' || !match) return null;
        return (
          <button
            type="button"
            onClick={() => setConfirmingCheck(match)}
            className="rounded border border-confirm-line bg-confirm-soft px-1.5 py-0.5 text-label font-semibold whitespace-nowrap text-confirm hover:brightness-95"
          >
            Confirm it cleared
          </button>
        );
      }}
      rowMenu={(row) =>
        // A check is not a delegation to rename, re-file or adjust; its menu
        // offers only what the bank can decide.
        row.kind === 'check' ? (
          <CheckRowMenu row={row} />
        ) : (
          <DelegationRowMenu
            row={row}
            groupings={groupingOptions}
            cadence={cadence}
            onNudge={nudge}
            {...(difference === 0n
              ? {}
              : {
                  onAbsorb: setAbsorbing,
                  absorbLabel: difference > 0n ? 'Move surplus here' : 'Fix deficit from here',
                })}
            onTransferFrom={(delegationId) => {
              setTransferFrom(delegationId);
              setDialog('transfer');
            }}
          />
        )
      }
    />
  );

  return (
    <div>
      {/*
        Title and nothing else.

        Delegate and the undo that replaces it were the only things here, and
        they are in the sidebar now — above Sync, under the reading they act on.
        Neither was a fact about this page: they are acts on the household, which
        is the argument ADR 059 already used to move the alerts out of the header.
      */}
      <PageHeader title="Budget" />

      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {/*
        Two arrangements of the same three sections, chosen on Settings →
        Display and stored per device (`useBudgetLayout`).

        The DOM order is the *column* order — Delegations, then the accounts —
        and the grid is what puts them side by side from `lg`. Below that the
        grid simply does not apply and the sections stack in the order they are
        written, which is the order this arrangement wants on a phone anyway:
        the envelopes first, because they are what somebody came to work
        through.

        `minmax(0, …)` on both tracks rather than `3fr 2fr`. A grid item
        defaults to its *content* width, so a table with a long account name in
        it would push its own column wider than its share and shove the other
        one off the screen — the same trap the Insights card header fell into.

        Three-to-two because the columns are not doing the same amount of work:
        Delegations carries two money columns and a row menu, Assets and Debts
        carry one money column each.
      */}
      <div
        className={
          budgetLayout === 'columns'
            ? 'flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-6'
            : 'flex flex-col gap-6'
        }
      >
        {budgetLayout === 'columns' && delegationsSection}

        {/* The 24px between sections is this column's gap now rather than a
            margin each section carried, because each of them is a tile and a
            tile does not know what is under it. */}
        <div className="flex flex-col gap-6">
          <BudgetSection
            title="Assets"
            section={view.data.assets}
            showAmountToDelegate={false}
            redNegatives={false}
            onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
            onMoveToGrouping={(rowId, groupingId) => moveAccount.mutate({ id: rowId, groupingId })}
            onPlace={(rowId, groupingId, orderedIds) =>
              placeAccount.mutate({ id: rowId, groupingId, orderedIds })
            }
            onReorderGroupings={(groupingIds) =>
              reorderGroupings.mutate({ section: 'assets', groupingIds })
            }
            rowMenu={(row) => (
              <AccountRowMenu
                row={row}
                groupings={groupingOptionsFor(view.data.assets)}
                onNudge={(target, direction) => nudgeAccount(view.data.assets, target, direction)}
              />
            )}
          />

          {/* Debts render in normal text, never red, despite being liabilities. */}
          <BudgetSection
            title="Debts"
            section={view.data.debts}
            showAmountToDelegate={false}
            redNegatives={false}
            onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
            onMoveToGrouping={(rowId, groupingId) => moveAccount.mutate({ id: rowId, groupingId })}
            onPlace={(rowId, groupingId, orderedIds) =>
              placeAccount.mutate({ id: rowId, groupingId, orderedIds })
            }
            onReorderGroupings={(groupingIds) =>
              reorderGroupings.mutate({ section: 'debts', groupingIds })
            }
            rowMenu={(row) => (
              <AccountRowMenu
                row={row}
                groupings={groupingOptionsFor(view.data.debts)}
                onNudge={(target, direction) => nudgeAccount(view.data.debts, target, direction)}
              />
            )}
          />
        </div>

        {budgetLayout === 'stacked' && delegationsSection}
      </div>

      {absorbing && (
        <AbsorbDialog
          row={absorbing}
          differenceCents={BigInt(view.data.identity.differenceCents)}
          onClose={() => setAbsorbing(null)}
          onProblem={setProblem}
        />
      )}

      {confirmingCheck && (
        <ConfirmCheckMatchDialog match={confirmingCheck} onClose={() => setConfirmingCheck(null)} />
      )}

      {dialog === 'transaction' && (
        <NewTransactionDialog delegations={spendable} onClose={() => setDialog('none')} />
      )}
      {dialog === 'check' && <NewCheckDialog view={view.data} onClose={() => setDialog('none')} />}
      {dialog === 'transfer' && (
        <TransferDialog
          section={view.data.delegations}
          {...(transferFrom === null ? {} : { initialFrom: transferFrom })}
          onClose={() => {
            setDialog('none');
            setTransferFrom(null);
          }}
        />
      )}
    </div>
  );
}
