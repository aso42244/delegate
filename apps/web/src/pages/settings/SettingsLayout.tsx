import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { NARROW, useMediaQuery } from '../../useMediaQuery.js';
import { SettingsIndex } from './SettingsIndex.jsx';

/**
 * Settings, with one section per page.
 *
 * Only the sections that exist are listed. A navigation item leading to "coming
 * soon" teaches the owner that some of these do nothing, which is a lesson that
 * outlasts the placeholder.
 */

export const SECTIONS = [
  { to: 'sync', label: 'Sync' },
  { to: 'accounts', label: 'Accounts' },
  { to: 'delegations', label: 'Delegations' },
  { to: 'groupings', label: 'Groupings' },
  { to: 'rules', label: 'Rules' },
  { to: 'bitcoin', label: 'Bitcoin' },
  { to: 'properties', label: 'Properties' },
  { to: 'budget', label: 'Budget' },
  { to: 'users', label: 'Users' },
  { to: 'tor', label: 'Tor' },
  { to: 'display', label: 'Display' },
  { to: 'archived', label: 'Archived' },
] as const;

export function SettingsLayout(): ReactNode {
  const narrow = useMediaQuery(NARROW);
  const { pathname } = useLocation();
  // `/settings` exactly, where the phone shows its index rather than a section.
  const atIndex = pathname === '/settings' || pathname === '/settings/';

  return (
    <div>
      {/*
        On a phone, inside a section, the back link is the header. Repeating
        "Settings" above a card that already names itself would spend a quarter
        of the screen saying where you are twice.
      */}
      {narrow && !atIndex ? (
        <Link
          to="/settings"
          className="mb-4 inline-flex min-h-[44px] items-center gap-1 text-quiet font-semibold text-accent"
        >
          <span aria-hidden>‹</span> Settings
        </Link>
      ) : (
        <>
          <h1 className="text-page font-bold text-ink">Settings</h1>
          <p className="mt-1 mb-6 text-quiet text-muted">
            Connections, and how the budget behaves.
          </p>
        </>
      )}

      {/* The tab row is the better control where every destination fits at
          once, and thirteen never do on a phone. */}
      {!narrow && (
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
      )}

      <div className="flex flex-col gap-4">
        {narrow && atIndex ? <SettingsIndex /> : <Outlet />}
      </div>
    </div>
  );
}
