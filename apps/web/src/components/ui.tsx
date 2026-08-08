import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

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

export function Tag({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
      {children}
    </span>
  );
}
