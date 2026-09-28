import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

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

/**
 * Where this merchant went the last few times.
 *
 * It leads the list before anything is typed, and it is the entry Enter lands
 * on — which is a strict improvement on what Enter did before, when the first
 * of an arbitrary eight was the default. Marked with its own count rather than
 * silently promoted: a suggestion that does not look like one is an assertion.
 */
export interface DelegationSuggestion {
  readonly delegationId: string;
  readonly name: string;
  readonly matchCount: number;
  readonly totalCount: number;
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
  readonly suggestion?: DelegationSuggestion | undefined;
}

/** The tallest the popover list is ever allowed to be. */
const LIST_MAX_PX = 256;

/** Breathing room between the list and the edge of the screen. */
const EDGE_MARGIN_PX = 16;

/**
 * Which way the list opens, and how tall it may be.
 *
 * It hung straight down at a flat `max-h-64`, which is right in the middle of a
 * long register and wrong at either end of it: on the last rows of a page the
 * list ran off the bottom of the screen, and the options nobody could reach were
 * the ones a search had just narrowed to.
 *
 * Measured from the **input**, which is always on screen, rather than from the
 * list, which is not rendered until it opens and so has no box to measure.
 *
 * It flips only when flipping genuinely helps — a row near the bottom of a short
 * window has little room either way, and a list that jumps upward to gain twelve
 * pixels is a list that moves for no reason.
 */
function useListPlacement(
  inputRef: React.RefObject<HTMLInputElement | null>,
  open: boolean,
): { above: boolean; maxHeightPx: number } {
  const [placement, setPlacement] = useState({ above: false, maxHeightPx: LIST_MAX_PX });

  useEffect(() => {
    if (!open) return;

    function measure(): void {
      const input = inputRef.current;
      if (!input) return;

      const box = input.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - EDGE_MARGIN_PX;
      const above = box.top - EDGE_MARGIN_PX;

      // Downwards unless upwards is both sufficient and better, so the common
      // case never moves.
      const flip = below < LIST_MAX_PX && above > below;
      setPlacement({
        above: flip,
        maxHeightPx: Math.max(Math.min(LIST_MAX_PX, flip ? above : below), 0),
      });
    }

    measure();
    window.addEventListener('resize', measure);
    // Capture, because what scrolls is usually an ancestor rather than the page.
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [inputRef, open]);

  return placement;
}

export function DelegationPicker({
  options,
  currentName,
  onChoose,
  onAdvance,
  label,
  autoFocus = false,
  variant = 'inline',
  suggestion,
}: DelegationPickerProps): ReactNode {
  const asSheet = variant === 'sheet';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const placement = useListPlacement(inputRef, !asSheet && open);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      // Only while nothing is typed. Once there is a query the list is what was
      // asked for, in the order it was asked for; a suggestion pinned above a
      // search result would be answering a question nobody asked twice.
      const suggested = suggestion
        ? options.find((option) => option.id === suggestion.delegationId)
        : undefined;
      if (!suggested) return options.slice(0, 8);
      return [suggested, ...options.filter((option) => option.id !== suggested.id).slice(0, 7)];
    }

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
  }, [options, query, suggestion]);

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
           *
           * As a popover it is 256px wide **or the width of its field, whichever
           * is less**. `max-w-full` resolves against the positioned wrapper,
           * which is the field — so on the register's wide column the list is
           * the 256px it has always been, and in a dashboard tile where the
           * field has given way to the payee it gives way with it rather than
           * hanging over the tile's right edge.
           *
           * Its height and its direction are measured rather than fixed: see
           * `useListPlacement`.
           */
          className={
            asSheet
              ? 'mt-2'
              : `absolute z-20 w-64 max-w-full overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-lg ${
                  placement.above ? 'bottom-full mb-1' : 'top-full mt-1'
                }`
          }
          {...(asSheet ? {} : { style: { maxHeight: `${placement.maxHeightPx}px` } })}
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
                {/* The evidence, never the claim on its own. `14 of 15` is what
                    makes a suggestion something a reader can weigh rather than
                    a second opinion with nothing behind it. */}
                {suggestion?.delegationId === option.id && query.trim() === '' && (
                  <span className="ml-2 text-label text-muted">
                    {suggestion.matchCount} of {suggestion.totalCount} before
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
