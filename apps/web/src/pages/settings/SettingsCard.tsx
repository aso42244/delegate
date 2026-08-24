import type { ReactNode } from 'react';

/**
 * A settings card: bordered, a 14px heading, one line of grey description, and
 * an optional action in the top right.
 *
 * The action belongs in the header for the same reason it does on the Budget
 * page: a page that lists things and also creates them should not carry the
 * creating form all the way down the page, below the list, permanently open.
 * One button, one dialog, and the list keeps the room.
 */
export function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description: string;
  /** Rendered right-aligned, baseline-aligned with the title. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        {/* `min-w-0` so a long description wraps rather than shoving the action
            onto a line of its own. */}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <p className="text-quiet text-muted">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
