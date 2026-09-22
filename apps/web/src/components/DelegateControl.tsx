import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { ControlPopover } from './ControlPopover.jsx';
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
  const detailId = useId();
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

  /** What was delegated, for the panel and for the phone's tooltip. */
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
        /*
         * The offer is on the button's own hover, not under it.
         *
         * It was a paragraph in the column, which is the last caption this zone
         * had — Sync's went in ADR 063 for the reason that applies here too: a
         * control in this zone carries what it has to say, and floor space spent
         * on a sentence is floor space taken from the controls around it. This
         * one also appears and disappears with the undo window, so it moved
         * every button below it twice a fortnight.
         *
         * `ControlPopover`, like the other three, rather than a native `title`:
         * the two would open on the same hover with the tooltip on top, saying
         * less (ADR 063 again). The rail keeps a `title` because a glyph is all
         * the name it has there.
         */
        <div className={`group relative ${width}`}>
          <Button
            variant="danger"
            className={width}
            onClick={() => setDialog('undo')}
            /*
             * Three cases, and only one of them is a tooltip worth having. The
             * rail has a glyph, so the `title` is the control's name. A phone
             * has no hover to open the panel with, so it keeps the sentence the
             * way it always did. The expanded sidebar has the panel, and a
             * native tooltip there would open on the same hover, on top of it,
             * saying less.
             */
            title={collapsed ? 'Undo Delegation' : inline ? (offer ?? undefined) : undefined}
            aria-label={collapsed ? 'Undo Delegation' : undefined}
            {...(offer === null || inline ? {} : { 'aria-describedby': detailId })}
          >
            {collapsed ? '↺' : 'Undo Delegation'}
          </Button>

          {/* Not on a phone: there is no hover to open it with, and the button
              carries the sentence on its own `title` there instead. */}
          {!inline && offer !== null && (
            <ControlPopover id={detailId}>
              <span className="text-quiet text-ink">{offer}</span>
            </ControlPopover>
          )}
        </div>
      ) : (
        <Button
          /*
           * Plain, with the blue on the hover.
           *
           * It was the accent fill, from when it was the Budget page's own
           * primary action and the only loud thing on that screen. In the
           * sidebar's control zone it is one of four buttons 8px apart, and a
           * filled blue one there was the one that moves a pay packet sitting
           * over the one pressed daily — an invitation to reach for the wrong
           * control, which is the hazard the confirmation dialog already exists
           * to catch.
           *
           * Colour in that zone means a control is reporting a **state**, and
           * Delegate has none. What it *will do* shows on the way to pressing
           * it: `ui-system.md` §5 has the split.
           */
          hover="accent"
          className={width}
          onClick={() => setDialog('delegate')}
          title={collapsed ? 'Delegate' : undefined}
          aria-label={collapsed ? 'Delegate' : undefined}
        >
          {collapsed ? '⇊' : 'Delegate'}
        </Button>
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
            {/*
              What the maximums keep out, said rather than quietly deducted.

              The total above is already net of them, so without this sentence it
              is smaller than the To delegate column on the page adds up to, with
              nothing on screen to say why — and the figure it disagrees with is
              the one the household typed. Where the money goes is the other half
              of it, and the answer is nowhere: it stays available to delegate.
            */}
            {BigInt(preview.data.withheldCents) > 0n && (
              <span className="mt-2 block text-quiet text-muted">
                {formatCents(BigInt(preview.data.withheldCents))} is held back by{' '}
                {preview.data.cappedCount === 1
                  ? 'a line at its maximum'
                  : `${preview.data.cappedCount} lines at their maximum`}{' '}
                and stays available to delegate.
              </span>
            )}
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
