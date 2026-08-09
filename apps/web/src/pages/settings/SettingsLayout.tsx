import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

/**
 * Settings, with one section per page.
 *
 * Only the sections that exist are listed. A navigation item leading to "coming
 * soon" teaches the owner that some of these do nothing, which is a lesson that
 * outlasts the placeholder.
 */

const SECTIONS = [
  { to: 'sync', label: 'Sync' },
  { to: 'accounts', label: 'Accounts' },
  { to: 'delegations', label: 'Delegations' },
  { to: 'groupings', label: 'Groupings' },
  { to: 'rules', label: 'Rules' },
  { to: 'bitcoin', label: 'Bitcoin & Property' },
  { to: 'budget', label: 'Budget' },
  { to: 'reconcile', label: 'Reconcile' },
  { to: 'users', label: 'Users' },
  { to: 'archived', label: 'Archived' },
] as const;

export function SettingsLayout(): ReactNode {
  return (
    <div>
      <h1 className="text-page font-bold text-ink">Settings</h1>
      <p className="mt-1 mb-6 text-quiet text-muted">Connections, and how the budget behaves.</p>

      <nav aria-label="Settings sections" className="mb-6 flex gap-1 border-b border-line">
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-quiet font-semibold ${
                isActive ? 'border-accent text-accent' : 'border-transparent text-muted'
              }`
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>

      <div className="flex flex-col gap-4">
        <Outlet />
      </div>
    </div>
  );
}
