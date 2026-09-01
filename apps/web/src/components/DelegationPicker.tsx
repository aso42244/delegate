import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * The delegation picker used to categorize a transaction.
 *
 * This is the highest-traffic control in the application after the Budget page,
 * and at go-live it is used several hundred times in a sitting. So it is a
 * type-ahead rather than a dropdown: type a few letters, press Enter, and the
 * next uncategorized row takes focus. No mouse, no scrolling a list of sixty.
 */

export interface DelegationOption {
  readonly id: string;
  readonly name: string;
}

export interface DelegationPickerProps {
  readonly options: readonly DelegationOption[];
  readonly currentName?: string | undefined;
  readonly onChoose: (delegationId: string) => void;
  /** Called after a choice, so the caller can focus the next uncategorized row. */
  readonly onAdvance?: () => void;
  readonly label: string;
  readonly autoFocus?: boolean;
  /**
   * `inline` is the register's own row: a bare field that becomes a field only
   * on focus, with the matches in a popover beside it.
   *
   * `sheet` is the same control given a whole bottom sheet — a real field and
   * the matches listed in flow beneath it, at a size a thumb can hit. The
   * matching, the ordering and every key are identical; only the frame differs,
   * because a popover anchored to a 13px field is a pointer's idea of a menu.
   */
  readonly variant?: 'inline' | 'sheet';
}

export function DelegationPicker({
  options,
  currentName,
  onChoose,
  onAdvance,
  label,
  autoFocus = false,
  variant = 'inline',
}: DelegationPickerProps): ReactNode {
  const asSheet = variant === 'sheet';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options.slice(0, 8);

    // Names that start with what was typed come first: typing "gro" should put
    // Grocery above "Home & Grounds" even though both match.
    const scored = options.filter((option) => option.name.toLowerCase().includes(needle));
    return scored
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [options, query]);

  function choose(option: DelegationOption | undefined): void {
    if (!option) return;
    setOpen(false);
    setQuery('');
    setHighlighted(0);
    onChoose(option.id);
    onAdvance?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        setHighlighted((index) => Math.min(index + 1, matches.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlighted((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        choose(matches[highlighted]);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        setQuery('');
        inputRef.current?.blur();
        break;
      default:
        break;
    }
  }

  return (
    <div className={asSheet ? '' : 'relative'}>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // A short delay so a click on an option lands before the list closes.
        // In a sheet the list is always shown, so there is nothing to close and
        // blurring must not hide the only thing on screen.
        onBlur={() => {
          if (!asSheet) setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
        placeholder={currentName ?? 'Uncategorized'}
        aria-label={label}
        aria-expanded={open}
        aria-autocomplete="list"
        // aria-controls links the two, so the listbox does not need to repeat
        // the input's label — which would leave both answering to one name.
        aria-controls={listboxId}
        role="combobox"
        autoFocus={autoFocus}
        className={
          asSheet
            ? 'field w-full rounded-lg border border-line bg-canvas px-3 text-base text-ink placeholder:text-faint'
            : `w-full rounded border border-transparent bg-transparent px-2 py-0.5 text-quiet hover:border-line focus:border-accent focus:bg-canvas ${
                currentName ? 'text-ink' : 'text-faint'
              }`
        }
      />

      {(asSheet || open) && matches.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Delegations"
          /*
           * In a sheet the list does not scroll itself — the dialog's body
           * does. `45vh` was a share of the *layout* viewport, which stays 844
           * tall behind an open keyboard, so it reserved more height than the
           * screen had and nested a second scroller inside one that was already
           * scrolling. Two touch scrollers in a stack fight each other.
           */
          className={
            asSheet
              ? 'mt-2'
              : 'absolute z-20 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-lg'
          }
        >
          {matches.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => {
                  // mousedown rather than click: blur would close the list first.
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`block w-full text-left ${
                  asSheet
                    ? 'min-h-[48px] rounded-lg px-3 py-2.5 text-base'
                    : 'px-3 py-1.5 text-quiet'
                } ${index === highlighted ? 'bg-accent-soft text-accent' : 'text-ink'}`}
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
