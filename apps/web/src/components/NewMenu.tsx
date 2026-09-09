import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../api/accounts.js';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { AddGroupingDialog } from '../pages/settings/Groupings.jsx';
import { AddRuleDialog } from '../pages/settings/Rules.jsx';
import { TransferDialog } from '../pages/MainBudget.jsx';
import { NewCheckDialog } from './NewCheckDialog.jsx';
import { NewTransactionDialog } from './NewTransactionDialog.jsx';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * One way to make a thing, on every page.
 *
 * There were seven create buttons spread over five screens: New transaction and
 * New check on Budget, New transaction again on the register, New grouping in
 * two places, New rule and New property under Settings. Each was where its own
 * page happened to be, so making a delegation meant knowing that delegations are
 * made on Budget, and making a rule meant remembering it is under Settings.
 * Somebody who wanted to record a cheque had to be on the right screen first.
 *
 * So the entry point is one control that is always in the same place, and the
 * page you are on stops being part of the question. `PageHeader` renders it, so
 * no page has to remember to.
 *
 * **The dialogs did not move.** Each still lives with the screen that owns the
 * thing it makes, and this imports them — a second implementation is how two
 * routes to the same action come to disagree, which is what "Add grouping" and
 * "New grouping" on two screens already were.
 *
 * What stays behind is anything that is not *creating a thing*: Delegate,
 * Arrange, Run rules, and every row-level action. Those belong to the page they
 * act on.
 */

type Kind = 'transaction' | 'transfer' | 'check' | 'delegation' | 'grouping' | 'rule';

/** The order somebody reaches for them: money first, then structure. */
const ITEMS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: 'transaction', label: 'Transaction' },
  { kind: 'transfer', label: 'Transfer' },
  { kind: 'check', label: 'Check' },
  { kind: 'delegation', label: 'Delegation' },
  { kind: 'grouping', label: 'Grouping' },
  { kind: 'rule', label: 'Rule' },
];

export function NewMenu(): ReactNode {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const container = useRef<HTMLDivElement>(null);

  /*
   * Closing: Escape, a press outside, and choosing something. Bound on the
   * document rather than the button so they work before anything inside has
   * focus — the same reasoning the row menu uses.
   */
  useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointerDown(event: PointerEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <>
      <div ref={container} className="relative">
        <Button
          onClick={() => setOpen((was) => !was)}
          aria-haspopup="menu"
          aria-expanded={open}
          // The noun is on the item, not the button: six of them behind one
          // control is what makes it one control.
        >
          New …
        </Button>

        {open && (
          <div
            role="menu"
            aria-label="Create"
            className="absolute right-0 z-20 mt-1 min-w-44 rounded-lg border border-line bg-canvas py-1 shadow-lg"
          >
            {ITEMS.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                className="flex w-full items-center px-3 py-2 text-left text-quiet text-ink hover:bg-surface"
                onClick={() => {
                  setKind(item.kind);
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {kind !== null && <NewDialog kind={kind} onClose={() => setKind(null)} />}
    </>
  );
}

/**
 * Whichever dialog was chosen, with what it needs fetched here.
 *
 * Split out so the queries below run when something is being made and not on
 * every page load — this control is in every header, and three requests behind
 * a closed menu on every screen is a real cost for a thing pressed a few times a
 * day.
 */
function NewDialog({
  kind,
  onClose,
}: {
  readonly kind: Kind;
  readonly onClose: () => void;
}): ReactNode {
  const needsBudget =
    kind === 'transaction' || kind === 'transfer' || kind === 'check' || kind === 'rule';
  const budget = useQuery({
    queryKey: ['budget'],
    queryFn: budgetApi.view,
    enabled: needsBudget,
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
    enabled: kind === 'rule',
  });

  if (kind === 'delegation') return <NewDelegationDialog onClose={onClose} />;
  if (kind === 'grouping') return <AddGroupingDialog onDone={onClose} />;

  // Every remaining dialog needs the budget, and none of them can be drawn
  // half-populated: a picker with no delegations in it is a dialog nobody can
  // finish.
  if (!budget.data) return null;

  const delegations = [
    ...budget.data.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...budget.data.delegations.ungrouped,
  ]
    // Outstanding checks are delegations, but not a category anything is spent
    // on — they are settled by matching, which is a different action.
    .filter((row) => row.kind !== 'check')
    .map((row) => ({ id: row.id, name: row.name }));

  if (kind === 'transaction') {
    return <NewTransactionDialog delegations={delegations} onClose={onClose} />;
  }
  if (kind === 'transfer') {
    return <TransferDialog section={budget.data.delegations} onClose={onClose} />;
  }
  if (kind === 'check') return <NewCheckDialog view={budget.data} onClose={onClose} />;

  if (!accounts.data) return null;
  return (
    <AddRuleDialog delegations={delegations} accounts={accounts.data.accounts} onDone={onClose} />
  );
}

/**
 * A delegation is a name and nothing else.
 *
 * The amount to delegate, the grouping and the order are all set on Budget,
 * where the line can be seen against the others — asking for them here would be
 * a form of four fields for a thing whose only required one is what to call it.
 * It lands ungrouped at the end, which is where the inline control on Budget
 * has always put it.
 */
function NewDelegationDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const trimmed = name.trim();
      if (trimmed === '') {
        throw new ApiError(400, 'invalid_name', 'Give the delegation a name.');
      }
      return budgetApi.createDelegation(trimmed, null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Something went wrong.'),
  });

  return (
    <Modal
      label="New delegation"
      title="New delegation"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="new-delegation" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      }
    >
      <form
        id="new-delegation"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          width="md"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          hint="The amount and the grouping are set on Budget."
        />
        {problem && <Alert>{problem}</Alert>}
      </form>
    </Modal>
  );
}
