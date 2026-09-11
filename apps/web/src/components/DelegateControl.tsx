import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button } from './ui.jsx';

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
          variant="primary"
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
 * The shell every confirmation here uses.
 *
 * Deliberately not `Modal`: neither of these holds a typed figure, both are two
 * sentences and two buttons, and this is the frame the Delegate confirmation has
 * always had. One copy of it rather than two, because the two dialogs differ
 * only in their words.
 */
function ConfirmFrame({
  label,
  title,
  children,
  footer,
}: {
  readonly label: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}): ReactNode {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/20 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-full max-w-md rounded-lg border border-line bg-canvas p-4"
      >
        <h2 className="mb-1 text-section font-bold text-ink">{title}</h2>
        {children}
        <div className="mt-4 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
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
      {preview.isLoading ? (
        <p className="text-quiet text-muted">Working out what would be distributed…</p>
      ) : preview.data ? (
        <p className="mb-4 text-base text-ink">
          Distribute <strong>{formatCents(BigInt(preview.data.totalCents))}</strong> across{' '}
          <strong>{preview.data.lineCount}</strong>{' '}
          {preview.data.lineCount === 1 ? 'line' : 'lines'}.
          <span className="mt-2 block text-quiet text-muted">
            Lines with no amount receive nothing. This can be undone for a while afterwards.
          </span>
        </p>
      ) : null}

      {problem && <Alert>{problem}</Alert>}
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
      <p className="mb-4 text-base text-ink">
        {summary ?? 'Takes the last distribution back out of the delegations.'}
        <span className="mt-2 block text-quiet text-muted">
          Every line this run touched goes back to what it held before.
        </span>
      </p>

      {problem && <Alert>{problem}</Alert>}
    </ConfirmFrame>
  );
}
