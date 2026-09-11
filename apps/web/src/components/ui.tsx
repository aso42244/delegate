import {
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { useVisualViewport } from '../useVisualViewport.js';

/**
 * The small shared pieces, built to the tokens in docs/design.md.
 *
 * Deliberately not a component library: this application needs a handful of
 * primitives, and a dependency would bring opinions the dense table layout would
 * have to fight.
 */

export type ButtonVariant =
  'default' | 'primary' | 'positive' | 'info' | 'warning' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'border-line bg-canvas text-ink hover:bg-surface',
  primary: 'border-accent bg-accent text-on-accent hover:brightness-95',
  /*
   * The four soft fills: a control reporting a **state**.
   *
   * `positive` and `info` joined `warning` and `danger` when the budget's own
   * reading became a control rather than a tag (ADR 064). Its three states are
   * the three colours — balanced, money waiting to be delegated, over-delegated
   * — and a reading that is only ever yellow or red could not say the two that
   * are not faults.
   */
  positive: 'border-positive-line bg-positive-soft text-positive hover:brightness-95',
  info: 'border-accent-line bg-accent-soft text-accent hover:brightness-95',
  // Sync SimpleFIN is the one of these: the button is the state, so a failing
  // feed does not need a line of its own underneath saying so.
  warning: 'border-warning-line bg-warning-soft text-warning hover:brightness-95',
  danger: 'border-danger-line bg-danger-soft text-danger hover:brightness-95',
  ghost: 'border-transparent bg-transparent text-muted hover:bg-surface-2',
};

/**
 * What a plain button will do, shown only while somebody is reaching for it.
 *
 * A separate axis from `variant`, because it says something different: `variant`
 * is the state a control is *in*, and this is the consequence of pressing it.
 * The sidebar's control zone is where that distinction earns its keep — Delegate
 * and Sign out have no state and so no colour of their own, but one of them
 * distributes a pay packet and the other ends the session, and 8px apart they
 * should not look identical right up to the moment they are clicked.
 *
 * Background and text only. The outline stays `border-line` on all three plain
 * buttons, which is what makes them read as one set.
 */
export type ButtonHover = 'accent' | 'danger';

const BUTTON_HOVERS: Record<ButtonHover, string> = {
  accent: 'hover:bg-accent-soft hover:text-accent',
  danger: 'hover:bg-danger-soft hover:text-danger',
};

/**
 * How wide a field is, decided by what goes in it.
 *
 * Never inherited from whatever container the field happens to sit in, which is
 * how one text input came to be 384px wide on Settings → Users, 576px on Sync
 * and 918px on Two-factor — three widths for the same kind of thing on three
 * tabs of one page.
 *
 * `max-w-full` on every one of them: a 384px field inside a 343px phone card
 * used to run off the edge, which is exactly what Settings → Bitcoin did.
 */
export type FieldWidth = 'sm' | 'md' | 'lg' | 'full';

/**
 * Applied to the field's **wrapper**, never to the control inside it.
 *
 * `max-w-full` on the control resolves against a wrapper the control itself
 * sized, so it can never clamp anything — which is how a 384px node address
 * still ran off the side of a 326px card. On the wrapper it resolves against the
 * real container and gives way as it should.
 */
const FIELD_WIDTHS: Record<FieldWidth, string> = {
  // 128px — money, dates, counts, anything under ten characters.
  sm: 'w-32 max-w-full',
  // 256px — names, single words, a delegation, a person.
  md: 'w-64 max-w-full',
  // 384px — tokens, addresses, descriptions, anything pasted.
  lg: 'w-96 max-w-full',
  // Only inside a dialog, where the dialog decides the width.
  full: 'w-full',
};

/**
 * A button's face, for the two things that wear it without being one.
 *
 * The budget's reading is a `Link` — it goes to Overview — and a link drawn by
 * hand beside three buttons is how a set stops looking like a set. One string,
 * one place it is written.
 *
 * 28px, at the owner's request: 36 was more air than a row of controls needs,
 * most visibly on a phone where the Budget header carries five of them. Above
 * the 24px floor WCAG 2.5.8 sets, below the 44px both platforms publish as
 * comfortable — a deliberate trade, and his to make.
 */
export function buttonFace(variant: ButtonVariant = 'default', hover?: ButtonHover): string {
  const base =
    'inline-flex min-h-[28px] items-center justify-center gap-2 rounded-lg border px-3 text-quiet font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  // A tinted hover replaces the variant's own, so the two cannot both apply.
  const tone =
    hover === undefined || variant !== 'default'
      ? BUTTON_VARIANTS[variant]
      : `border-line bg-canvas text-ink ${BUTTON_HOVERS[hover]}`;
  return `${base} ${tone}`;
}

export function Button({
  variant = 'default',
  hover,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** Only meaningful on `default`, whose own hover it replaces. */
  hover?: ButtonHover;
}): ReactNode {
  return (
    <button
      // 8px radius, 1px border, 13px/600.
      //
      // 28px, at the owner's request: 36 was more air than a row of controls
      // needs, most visibly on a phone where the Budget header carries five of
      // them. Above the 24px floor WCAG 2.5.8 sets, below the 44px both
      // platforms publish as comfortable — a deliberate trade, and his to make.
      className={`${buttonFace(variant, hover)} ${className}`}
      {...props}
    />
  );
}

/**
 * The label and the hint are wired up separately, rather than both sitting
 * inside a wrapping `<label>`.
 *
 * Nesting them makes the hint part of the input's *accessible name*, so a field
 * labelled "Password" announces as "Password At least 12 characters. A
 * passphrase is ideal." to a screen reader, and cannot be found by its own
 * label. `aria-describedby` is what a hint is for: read after the name, not as
 * part of it.
 */
export function TextField({
  label,
  hint,
  width = 'md',
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** At most one short line, and only when the label cannot carry the meaning. */
  hint?: string;
  width?: FieldWidth;
}): ReactNode {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const hintId = `${id}-hint`;

  return (
    <div className={`${FIELD_WIDTHS[width]} min-w-0`}>
      <label htmlFor={id} className="mb-1 block text-quiet font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        {...(hint ? { 'aria-describedby': hintId } : {})}
        className={`field w-full rounded-lg border border-line bg-canvas px-3 text-base text-ink placeholder:text-faint ${className}`}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="mt-1 block text-quiet text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The multi-line counterpart to TextField, wired the same way.
 *
 * The control sits beside its label rather than inside it. A wrapping `<label>`
 * takes its text from everything it contains, which for a filled-in box means
 * the label reads as the label plus whatever was typed.
 */
export function TextArea({
  label,
  width = 'full',
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  width?: FieldWidth;
}): ReactNode {
  const generatedId = useId();
  const id = props.id ?? generatedId;

  return (
    <div className={`${FIELD_WIDTHS[width]} min-w-0`}>
      <label htmlFor={id} className="mb-1 block text-quiet font-medium text-ink">
        {label}
      </label>
      <textarea
        id={id}
        className={`w-full rounded-lg border border-line bg-canvas px-3 py-2 text-base text-ink placeholder:text-faint ${className}`}
        {...props}
      />
    </div>
  );
}

/**
 * Errors are surfaced, never swallowed. State is carried by the text as well as
 * the colour, so it survives being read without colour perception.
 */
export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'warning' | 'positive' | 'info';
  children: ReactNode;
}): ReactNode {
  const tones = {
    danger: 'border-danger-line bg-danger-soft text-danger',
    warning: 'border-warning-line bg-warning-soft text-warning',
    positive: 'border-positive bg-positive-soft text-positive',
    info: 'border-accent bg-accent-soft text-accent',
  } as const;

  return (
    <div role="alert" className={`rounded-lg border px-3 py-2 text-quiet ${tones[tone]}`}>
      {children}
    </div>
  );
}

/**
 * A modal dialog.
 *
 * Escape closes it and Cancel closes it. **The backdrop closes it only when the
 * dialog is `dismissible`** — a reading has nothing to lose to a stray click,
 * while a form holding a typed amount and a description has all of it, and that
 * is a worse failure than one extra keypress.
 */
export function Modal({
  label,
  title,
  description,
  onClose,
  children,
  footer,
  width = 'md',
  dismissible = false,
}: {
  label: string;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * The dialog's buttons, kept out of the scrolling body so they stay on screen
   * however long the body is. Optional: most dialogs are a field or two and
   * never scroll, and for those the buttons are just more children.
   */
  footer?: ReactNode;
  width?: 'md' | 'lg' | 'xl';
  /**
   * Whether pressing the backdrop closes it.
   *
   * Off by default and deliberately: a dialog holding a typed amount and a
   * description loses all of it to a stray click beside the card, which is a
   * worse failure than one extra keypress. A dialog that is only a *reading* has
   * nothing to lose, and there the expectation that clicking away closes it is
   * strong enough that not honouring it reads as the dialog being stuck.
   */
  dismissible?: boolean;
}): ReactNode {
  const viewport = useVisualViewport();
  useEffect(() => {
    // Escape is bound on the document rather than the card, so it works before
    // anything inside has been focused.
    function onDocumentKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [onClose]);

  return (
    /*
     * A centred card on a pointer, a bottom sheet on a phone.
     *
     * Not decoration: a centred card puts its buttons wherever its own height
     * lands them, which on a tall form is the middle of the screen and out of
     * thumb reach. A sheet is anchored to the bottom edge, so Save is always in
     * the same place and always reachable. It also leaves the page visible
     * above it, which says what is being acted on.
     *
     * `items-end` and the full width come from the breakpoint; everything else
     * is shared, so there is one dialog rather than two.
     */
    <div
      // Above the tab bar, which is `z-20` and fixed to the same edge a sheet
      // rises from. Below it, a sheet's own buttons sit behind navigation.
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/20 sm:items-center sm:p-4"
      /*
       * The backdrop closes a reading, never a form. `currentTarget` so only a
       * press on the backdrop itself counts — without it, every press that
       * bubbles up from inside the card would close it too.
       */
      onPointerDown={
        dismissible
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
      /*
       * Sized to what is on screen rather than to the window. `inset-0` is the
       * layout viewport, which on iOS keeps its full height while the keyboard
       * covers the bottom of it — so a sheet anchored to `bottom: 0` is
       * anchored underneath the keys. `top` and `height` win over `bottom`
       * when all three are set, so this narrows the overlay to the visible
       * rectangle and leaves the class as the fallback.
       */
      style={viewport ? { top: viewport.top, height: viewport.height } : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        /*
         * A column, so that a long body scrolls *inside* the card instead of
         * pushing the buttons past its bottom edge. `min-h-0` on the body is
         * what lets it shrink below its content: a flex item's minimum size is
         * its content by default, which would keep the card at full height and
         * put the overflow back off-screen.
         */
        className={`flex max-h-[88%] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-canvas px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] sm:max-h-full sm:rounded-lg sm:pb-4 ${
          width === 'xl' ? 'sm:max-w-4xl' : width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'
        }`}
      >
        {/* The grabber says "this came from the bottom and goes back there".
            Decorative, so it is hidden from the accessibility tree and gone
            entirely where the dialog is a centred card. */}
        <div aria-hidden className="mx-auto mb-4 h-1 w-9 shrink-0 rounded-full bg-line sm:hidden" />

        <h2 className="mb-1 shrink-0 text-section font-bold text-ink">{title}</h2>
        {description ? <p className="mb-4 shrink-0 text-quiet text-muted">{description}</p> : null}

        {/* `-mx-4 px-4`: the scroller runs the full width of the card so a
            focus ring or a popover inside it is not clipped by the padding,
            while its contents stay inset like everything else. */}
        <div className="-mx-4 min-h-0 overflow-auto px-4">{children}</div>
        {footer ? <div className="mt-4 shrink-0">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A labelled `<select>`, wired the same way as TextField. */
export function SelectField({
  label,
  hint,
  value,
  onChange,
  children,
  width = 'md',
  id: providedId,
}: {
  label: string;
  /** At most one short line. A select that saves on change needs one. */
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  width?: FieldWidth;
  id?: string;
}): ReactNode {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;

  return (
    <div className={`${FIELD_WIDTHS[width]} min-w-0`}>
      <label htmlFor={id} className="mb-1 block text-quiet font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(hint ? { 'aria-describedby': hintId } : {})}
        className={`field w-full rounded-lg border border-line bg-canvas px-3 text-base text-ink`}
      >
        {children}
      </select>
      {hint ? (
        <p id={hintId} className="mt-1 block text-quiet text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A 36×20 switch, per the design.
 *
 * `role="switch"` rather than a styled checkbox: the state is announced as on or
 * off, and it is operable from the keyboard without any handling of our own.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /**
   * Refused rather than hidden.
   *
   * Where a set has a cap — four figures in the band — the options past it stay
   * on screen and stop responding, so the limit reads as a state somebody has
   * reached rather than as choices that quietly vanished.
   */
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-surface-2'
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
