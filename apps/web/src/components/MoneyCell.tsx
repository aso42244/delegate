import { formatCents, formatCentsForInput, tryParseMoney } from '@budget/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A money cell: reads as text, edits on click.
 *
 * Keyboard behaviour is the point. The owner is typing sixty delegations by hand
 * at go-live and correcting them every payday after that, so Enter commits and
 * moves down, Escape abandons, and blur saves. Anything that requires reaching
 * for the mouse between rows would be the difference between five minutes and
 * forty.
 */

export interface MoneyCellProps {
  readonly valueCents: bigint | null;
  /** Rendered when the value is null — an ad-hoc line, not a zero. */
  readonly emptyLabel?: string;
  readonly editable?: boolean;
  /** Only delegation balances render negatives in red; debts never do. */
  readonly redWhenNegative?: boolean;
  readonly emphasis?: 'hero' | 'quiet' | 'normal';
  readonly onCommit?: (cents: bigint) => void;
  /** Called on Enter, so focus can move to the next row's cell. */
  readonly onCommitAndAdvance?: () => void;
  readonly label?: string;
}

export function MoneyCell({
  valueCents,
  emptyLabel = '—',
  editable = false,
  redWhenNegative = false,
  emphasis = 'normal',
  onCommit,
  onCommitAndAdvance,
  label,
}: MoneyCellProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const isNegative = valueCents !== null && valueCents < 0n;
  const weight =
    emphasis === 'hero'
      ? 'text-hero font-bold'
      : emphasis === 'quiet'
        ? 'text-quiet font-normal text-faint'
        : 'text-base';
  const colour = redWhenNegative && isNegative ? 'text-negative font-semibold' : '';

  function begin(): void {
    if (!editable) return;
    setDraft(valueCents === null ? '' : formatCentsForInput(valueCents));
    setInvalid(false);
    setEditing(true);
  }

  function commit(advance: boolean): void {
    const trimmed = draft.trim();

    // An emptied cell is left alone rather than guessed at. Clearing an amount
    // to delegate is a different action from setting it to zero, and guessing
    // which was meant would be worse than doing nothing.
    if (trimmed === '') {
      setEditing(false);
      return;
    }

    const parsed = tryParseMoney(trimmed);
    if (!parsed.ok) {
      // Held open with the bad text visible: silently discarding what someone
      // typed is how a mistyped amount becomes an unnoticed wrong number.
      setInvalid(true);
      return;
    }

    setEditing(false);
    setInvalid(false);
    onCommit?.(parsed.value);
    if (advance) onCommitAndAdvance?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setInvalid(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(false)}
        aria-label={label}
        aria-invalid={invalid}
        inputMode="decimal"
        className={`money money-input money-edge ml-auto block rounded border bg-canvas px-2 py-0.5 ${
          invalid ? 'border-danger-dot' : 'border-accent'
        }`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={begin}
      onFocus={editable ? undefined : undefined}
      disabled={!editable}
      aria-label={label}
      className={`money money-edge w-full rounded px-2 py-0.5 ${weight} ${colour} ${
        editable ? 'hover:bg-accent-soft' : 'cursor-default'
      }`}
    >
      {valueCents === null ? (
        <span className="text-faint">{emptyLabel}</span>
      ) : (
        formatCents(valueCents)
      )}
    </button>
  );
}
