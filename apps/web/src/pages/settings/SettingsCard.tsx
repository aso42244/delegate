import type { ReactNode } from 'react';

/** A settings card: bordered, a 14px heading, and one line of grey description. */
export function SettingsCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mb-4 text-quiet text-muted">{description}</p>
      {children}
    </section>
  );
}
