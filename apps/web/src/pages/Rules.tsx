import type { ReactNode } from 'react';
import { PageHeader } from '../components/layout.jsx';
import { RulesSection } from './settings/Rules.jsx';

/**
 * Auto-categorization rules, as a page of their own.
 *
 * They lived under Settings, which is where a thing that is configured once
 * belongs. Rules are not that. They are written from the Transactions page while
 * categorizing, reordered when one shadows another, and read whenever a charge
 * lands somewhere surprising — the same rhythm as the register itself, and three
 * clicks away from it.
 *
 * The card keeps its own shape. What changed is where it is reached from, so the
 * body is the section as it was rather than a second implementation of it.
 */
export function Rules(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Rules" />
      <RulesSection />
    </div>
  );
}
