import { useId, useState, type ReactNode } from 'react';
import { Button } from './ui.jsx';

/**
 * The pieces every screen repeats.
 *
 * Each of these existed three to five times before, written slightly differently
 * each time — four page headers, four ways of saying a list was empty, two
 * segmented controls on one page built out of different things. None was wrong
 * on its own. Together they were why the application did not look like one
 * application.
 *
 * See docs/ui-system.md. The spacing here is the only spacing: 4, 8, 16, 24.
 */

/**
 * Title, an optional reading beside it, one line of subtitle, actions on the
 * right, and 24px to whatever comes next.
 *
 * The 24px is part of the component rather than left to the caller, because
 * "how far below the title does the page start" was previously answered `mb-4`
 * on two pages and `mb-6` on two others, and nothing made those disagree on
 * purpose.
 */
export function PageHeader({
  title,
  beside,
  subtitle,
  actions,
}: {
  readonly title: string;
  /** A chip or reading that belongs to the title, baseline-aligned with it. */
  readonly beside?: ReactNode;
  /** One line. The current fact, never an instruction — see the text budget. */
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-page font-bold text-ink">{title}</h1>
          {beside}
        </div>
        {subtitle !== undefined && <p className="mt-1 text-quiet text-muted">{subtitle}</p>}
      </div>
      {/* No `shrink-0`. Holding the actions at their natural width is what put
          138px of the Insights window picker off the side of a phone, with the
          last option unreachable — the header must give way before the screen
          does. `min-w-0` so a child that scrolls can. */}
      {actions !== undefined && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

const DOT_TONES = {
  positive: 'bg-positive',
  warning: 'bg-warning',
  danger: 'bg-danger-dot',
  muted: 'bg-faint',
} as const;

const TEXT_TONES = {
  positive: 'text-muted',
  warning: 'text-warning',
  danger: 'font-semibold text-danger',
  muted: 'text-muted',
} as const;

/**
 * What something currently is, in one sentence with a dot in front of it.
 *
 * Sync said it with a dot, Backups said it with a dot of a different size,
 * Two-factor said it as bare prose, and Tor said it as a paragraph. One shape
 * now, so "is this working" is answered in the same place and the same way
 * everywhere.
 *
 * The tone is carried by the words as well as the colour. A reader who cannot
 * separate the two still gets the answer — the same rule the banners follow.
 */
export function StatusLine({
  tone,
  children,
}: {
  readonly tone: keyof typeof DOT_TONES;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p className="flex items-center gap-2 text-quiet">
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT_TONES[tone]}`} />
      <span className={TEXT_TONES[tone]}>{children}</span>
    </p>
  );
}

/**
 * A list with nothing in it.
 *
 * One sentence, and no instructions. Where to go next belongs on the control
 * that goes there — which on every one of these screens is a button already
 * sitting in the card header, a few pixels above this text telling the reader to
 * go and find it.
 */
export function EmptyState({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="text-quiet text-muted">{children}</p>;
}

/**
 * One of a few options.
 *
 * A real control rather than a row of buttons with one of them turned primary.
 * Insights had both idioms on screen at once: the window picker was five
 * Buttons, and directly below it every tile's view picker was a pill group.
 *
 * `radiogroup` rather than a set of toggle buttons, because that is what this
 * is — one choice out of a known few — and it gets arrow-key navigation from the
 * platform instead of from us.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  describeOption,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  /** Names the choice for a screen reader: "Time window". */
  readonly label: string;
  /** `sm` sits inside a card header; `md` sits in a page header. */
  readonly size?: 'sm' | 'md';
  /** Overrides an option's accessible name, when the label alone is too thin. */
  readonly describeOption?: (option: { readonly value: T; readonly label: string }) => string;
}): ReactNode {
  const small = size === 'sm';

  return (
    <div
      role="radiogroup"
      aria-label={label}
      /*
       * `max-w-full` and a scroll of its own: five time windows do not fit
       * across a phone, and the choice between clipping them and scrolling them
       * is the choice between an option nobody can reach and one they can.
       * `no-scrollbar` because a visible bar inside the control is louder than
       * the control.
       *
       * 24px options inside 2px of padding, so the whole thing is 28px and sits
       * on the same line as the buttons beside it. It was 28 inside 4 — a 36px
       * control against a 28px "New tile", which read as two rows pretending to
       * be one.
       */
      className={`no-scrollbar inline-flex min-w-0 max-w-full items-center overflow-x-auto rounded-md bg-surface-2 p-0.5`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            {...(describeOption ? { 'aria-label': describeOption(option) } : {})}
            onClick={() => onChange(option.value)}
            className={`shrink-0 rounded font-semibold whitespace-nowrap transition-colors ${
              small ? 'px-1.5 py-0.5 text-label' : 'min-h-[24px] px-3 text-quiet'
            } ${selected ? 'bg-canvas text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Something folded away until asked for.
 *
 * A button, never `<details>`. `<details>` draws its own marker in its own size
 * and cannot be styled consistently across browsers, and a native summary is not
 * reachable the same way a button is on a touchscreen. `aria-expanded` carries
 * the state properly either way.
 */
export function Disclosure({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {summary}
      </Button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}
