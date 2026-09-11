import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal } from './ui.jsx';

/**
 * Delegate, and the undo that replaces it — in the sidebar, above Sync.
 *
 * It was the Budget page's own primary button, which was right while Budget was
 * the only screen it could be pressed from. It is not a fact about that page:
 * distributing a pay packet is an act on the household, exactly like syncing the
 * feed, and the reading that says whether to press it — `To delegate $1,240.00`
 * — already sits at the foot of the sidebar and has done since ADR 059. The
 * button belongs under the figure it acts on.
 *
 * **Both states confirm.** Delegate always did; Undo Delegation did not, and
 * fired the moment it was clicked. In this slot that is the same hazard the
 * owner named — the two controls are stacked 8px apart, and the one below is
 * Sync — so a misclick has to cost a dialog either way rather than a
 * distribution or a rollback.
 *
 * **One slot, two jobs.** While the run can still be undone there is nothing
 * sensible to delegate, so offering both would be offering the wrong one first.
 *
 * `inline` is the phone. Below `sm` there is no sidebar at all, so a control
 * that lived only there would take the act this application is named for off the
 * small screen entirely — the same case `Alerts` handles by falling back to
 * `PageHeader`, and handled the same way.
 */
export function DelegateControl({
  inline = false,
  collapsed = false,
}: {
  /** Drawn in the page header, for a screen with no sidebar. */
  readonly inline?: boolean;
  /** The sidebar's icon rail, where a label does not fit. */
  readonly collapsed?: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'none' | 'delegate' | 'undo'>('none');
  const [problem, setProblem] = useState<string | null>(null);

  const undo = useQuery({ queryKey: ['undo-preview'], queryFn: budgetApi.undoPreview });
  const undoRunId = undo.data?.available === true ? (undo.data.runId ?? null) : null;

  const undoDelegate = useMutation({
    mutationFn: (runId: string) => budgetApi.undoDelegate(runId),
    onSuccess: async () => {
      setProblem(null);
      setDialog('none');
      await queryClient.invalidateQueries();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not undo.'),
  });

  /*
   * Closes the offer the moment the window does.
   *
   * The server stops offering an undo once it has expired, but nothing would ask
   * it again — so without this the button stays red until something else happens
   * to refetch, which on a tab left open is never. The second of slack is for
   * clock skew between here and the database.
   */
  useEffect(() => {
    const expiresAt = undo.data?.expiresAt;
    if (undoRunId === null || !expiresAt) return;

    const remaining = new Date(expiresAt).getTime() - Date.now();
    const timer = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: ['undo-preview'] }),
      Math.max(remaining, 0) + 1_000,
    );
    return () => clearTimeout(timer);
  }, [undoRunId, undo.data?.expiresAt, queryClient]);

  /** What was delegated, for the caption and for the rail's tooltip. */
  const offer =
    undoRunId === null
      ? null
      : `Delegated ${formatCents(BigInt(undo.data?.totalCents ?? '0'))} across ${
          undo.data?.lineCount ?? 0
        } lines. Undo rolls the cycle back too.`;

  const width = inline ? '' : 'w-full';

  return (
    <>
      {undoRunId !== null ? (
        <Button
          variant="danger"
          className={width}
          onClick={() => setDialog('undo')}
          title={collapsed ? `Undo Delegation. ${offer ?? ''}`.trim() : (offer ?? undefined)}
          aria-label={collapsed ? 'Undo Delegation' : undefined}
        >
          {collapsed ? '↺' : 'Undo Delegation'}
        </Button>
      ) : (
        <Button
          /*
           * Not blue.
           *
           * It was the accent, from when it was the Budget page's own primary
           * action and the only loud thing on that screen. In the sidebar it is
           * one of two buttons 8px apart, and the blue one was the one that
           * moves a pay packet while the neutral one below it is the one pressed
           * daily — an invitation to reach for the wrong control, which is the
           * hazard the confirmation dialog already exists to catch. Both are
           * plain now; what is coloured here is a button reporting a *state*,
           * and Delegate has none.
           */
          className={width}
          onClick={() => setDialog('delegate')}
          title={collapsed ? 'Delegate' : undefined}
          aria-label={collapsed ? 'Delegate' : undefined}
        >
          {collapsed ? '⇊' : 'Delegate'}
        </Button>
      )}

      {/*
        What was delegated, while it can still be taken back.

        It was the Budget page's subtitle. It belongs with the button rather than
        with a page, and it is transient — the only sign a press can still be
        undone, and gone the moment the window closes. The rail and the phone
        carry it on the button's own tooltip instead, where there is no room.
      */}
      {!inline && !collapsed && offer !== null && (
        /*
         * Capped and wrapping, like everything else of uncontrolled length in
         * here (`ui-system.md` §12). The sidebar is `w-fit`, so an uncapped
         * sentence would set its width — and tall rather than wide is the
         * owner's stated preference, which is the same trade the alert detail
         * makes.
         */
        <p className="max-w-sidebar-cap px-1 text-label text-muted">{offer}</p>
      )}

      {problem !== null && dialog === 'none' && (
        <div className={inline ? '' : 'px-1'}>
          <Alert>{problem}</Alert>
        </div>
      )}

      {dialog === 'delegate' && (
        <DelegateDialog
          onClose={() => {
            setDialog('none');
            setProblem(null);
          }}
        />
      )}

      {dialog === 'undo' && undoRunId !== null && (
        <ConfirmUndoDialog
          summary={offer}
          pending={undoDelegate.isPending}
          problem={problem}
          onConfirm={() => undoDelegate.mutate(undoRunId)}
          onClose={() => {
            setDialog('none');
            setProblem(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The shell every confirmation here uses. One copy of it rather than two,
 * because the two dialogs differ only in their words.
 *
 * **`Modal`, not a frame of its own.** It was hand-rolled on the reasoning that
 * neither of these holds a typed figure — which is an argument for letting the
 * backdrop close them, and `dismissible` is exactly that switch. It is not an
 * argument for a second frame, and a hand-rolled one gives up the three things
 * `Modal` exists to guarantee (ADR 038): it is measured against the **visual
 * viewport** rather than the window, it rises from the bottom edge as a sheet on
 * a phone instead of landing wherever a centred card's own height puts it, and
 * Escape closes it.
 *
 * That matters more here than anywhere, because this control was just promoted
 * into the page header below `sm`. The confirmation a phone reaches most easily
 * is now **Undo Delegation** — the destructive one, which empties every line a
 * run touched — and a destructive confirm that ignores Escape and lands mid-screen
 * is the weakest possible case for a bespoke frame.
 */
function ConfirmFrame({
  label,
  title,
  onClose,
  children,
  footer,
}: {
  readonly label: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}): ReactNode {
  return (
    <Modal
      label={label}
      title={title}
      onClose={onClose}
      /* A reading has nothing to lose to a stray press beside the card, which is
         the true half of the original reasoning. */
      dismissible
      footer={<div className="flex justify-end gap-2">{footer}</div>}
    >
      {children}
    </Modal>
  );
}

function DelegateDialog({ onClose }: { onClose: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const preview = useQuery({ queryKey: ['delegate-preview'], queryFn: budgetApi.delegatePreview });

  const run = useMutation({
    mutationFn: budgetApi.delegate,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not delegate.'),
  });

  return (
    <ConfirmFrame
      onClose={onClose}
      label="Confirm delegate"
      title="Delegate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => run.mutate()}
            disabled={run.isPending || preview.data?.lineCount === 0}
          >
            {run.isPending ? 'Delegating…' : 'Delegate'}
          </Button>
        </>
      }
    >
      {/* `gap-4` rather than a margin on the paragraph: the footer's step away
          from the body belongs to `Modal` now, and carrying it here too spent it
          twice. */}
      <div className="flex flex-col gap-4">
        {preview.isLoading ? (
          <p className="text-quiet text-muted">Working out what would be distributed…</p>
        ) : preview.data ? (
          <p className="text-base text-ink">
            Distribute <strong>{formatCents(BigInt(preview.data.totalCents))}</strong> across{' '}
            <strong>{preview.data.lineCount}</strong>{' '}
            {preview.data.lineCount === 1 ? 'line' : 'lines'}.
            <span className="mt-2 block text-quiet text-muted">
              Lines with no amount receive nothing. This can be undone for a while afterwards.
            </span>
          </p>
        ) : null}

        {problem && <Alert>{problem}</Alert>}
      </div>
    </ConfirmFrame>
  );
}

/**
 * Undoing asks first, which it did not before.
 *
 * The button is one press from Sync SimpleFIN, and an undo taken by accident
 * takes a whole distribution back out of the envelopes and rolls the cycle with
 * it. Nothing about that is recoverable by pressing the same button again.
 */
function ConfirmUndoDialog({
  summary,
  pending,
  problem,
  onConfirm,
  onClose,
}: {
  readonly summary: string | null;
  readonly pending: boolean;
  readonly problem: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <ConfirmFrame
      onClose={onClose}
      label="Confirm undo delegation"
      title="Undo Delegation"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Undoing…' : 'Undo Delegation'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-base text-ink">
          {summary ?? 'Takes the last distribution back out of the delegations.'}
          <span className="mt-2 block text-quiet text-muted">
            Every line this run touched goes back to what it held before.
          </span>
        </p>

        {problem && <Alert>{problem}</Alert>}
      </div>
    </ConfirmFrame>
  );
}
