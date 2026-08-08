import {
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

/**
 * The small shared pieces, built to the tokens in docs/design.md.
 *
 * Deliberately not a component library: this application needs a handful of
 * primitives, and a dependency would bring opinions the dense table layout would
 * have to fight.
 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'border-line bg-canvas text-ink hover:bg-surface',
  primary: 'border-accent bg-accent text-white hover:brightness-95',
  danger: 'border-danger-line bg-danger-soft text-danger hover:brightness-95',
  ghost: 'border-transparent bg-transparent text-muted hover:bg-surface-2',
};

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): ReactNode {
  return (
    <button
      // 8px radius, 1px border, 13px/600 — and a 44px minimum touch target
      // wherever the layout allows it.
      className={`inline-flex min-h-[36px] items-center justify-center gap-2 rounded-lg border px-3 text-quiet font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
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
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }): ReactNode {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const hintId = `${id}-hint`;

  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-quiet font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        {...(hint ? { 'aria-describedby': hintId } : {})}
        className={`w-full rounded-lg border border-line bg-canvas px-3 py-2 text-base text-ink placeholder:text-faint ${className}`}
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
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }): ReactNode {
  const generatedId = useId();
  const id = props.id ?? generatedId;

  return (
    <div className="block">
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
 * Escape closes it and Cancel closes it; clicking the backdrop does not. These
 * dialogs hold typed money and a description, and losing that to a stray click
 * beside the card is a worse failure than one extra keypress.
 */
export function Modal({
  label,
  title,
  description,
  onClose,
  children,
  width = 'md',
}: {
  label: string;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  width?: 'md' | 'lg';
}): ReactNode {
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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/20 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`max-h-full w-full overflow-auto rounded-lg border border-line bg-canvas p-4 ${
          width === 'lg' ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <h2 className="mb-1 text-section font-bold text-ink">{title}</h2>
        {description ? <p className="mb-4 text-quiet text-muted">{description}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** A labelled `<select>`, wired the same way as TextField. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  id: providedId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  id?: string;
}): ReactNode {
  const generatedId = useId();
  const id = providedId ?? generatedId;

  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-quiet font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-base text-ink"
      >
        {children}
      </select>
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
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
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

export function Tag({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
      {children}
    </span>
  );
}
