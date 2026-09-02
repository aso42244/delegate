import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { NARROW, useMediaQuery } from '../../useMediaQuery.js';
import { PageHeader } from '../../components/layout.jsx';
import { useSettingsTabs } from '../../settings-tabs.js';
import { SettingsIndex } from './SettingsIndex.jsx';

/**
 * Settings, with one section per page.
 *
 * **Eight sections, grouped by what somebody came to change.** There were
 * twelve, which is more than a tab row can carry without becoming a list of
 * words to read rather than a set of places to go — and half of them held a
 * single card. The old routes all still resolve: they redirect to whichever
 * section absorbed them, so a bookmark, a link in a note and every existing test
 * still land somewhere correct.
 *
 * Only the sections that exist are listed. A navigation item leading to "coming
 * soon" teaches the owner that some of these do nothing, which is a lesson that
 * outlasts the placeholder.
 */

export const SECTIONS = [
  { to: 'sync', label: 'Sync' },
  { to: 'accounts', label: 'Accounts' },
  { to: 'budget', label: 'Budget' },
  { to: 'rules', label: 'Rules' },
  { to: 'holdings', label: 'Holdings' },
  { to: 'access', label: 'Access' },
  { to: 'display', label: 'Display' },
  { to: 'archived', label: 'Archived' },
] as const;

export function SettingsLayout(): ReactNode {
  const narrow = useMediaQuery(NARROW);
  const [placement] = useSettingsTabs();
  const { pathname } = useLocation();
  // `/settings` exactly, where the phone shows its index rather than a section.
  const atIndex = pathname === '/settings' || pathname === '/settings/';

  // The rail is a wide-screen arrangement. On a phone the index list is the
  // navigation and neither the row nor the rail is drawn at all.
  const asRail = placement === 'side' && !narrow;

  const header =
    narrow && !atIndex ? (
      /*
       * On a phone, inside a section, the back link is the header. Repeating
       * "Settings" above a card that already names itself would spend a quarter
       * of the screen saying where you are twice.
       */
      <Link
        to="/settings"
        // Named for what it does, not for where it points. The tab bar also
        // carries a link to `/settings`, so two links with the accessible name
        // "Settings" sat on the same phone screen — which is ambiguous to
        // anyone navigating by name, and one of them is a back button.
        aria-label="Back to Settings"
        className="mb-4 inline-flex min-h-[44px] items-center gap-1 text-quiet font-semibold text-accent"
      >
        <span aria-hidden>‹</span> Settings
      </Link>
    ) : (
      // No subtitle. "Connections, and how the budget behaves" described the
      // tab row immediately beneath it, which describes itself.
      <PageHeader title="Settings" />
    );

  /*
   * The cards, as a three-column grid on a wide screen.
   *
   * Every card used to take the whole width, so Display was three radio groups
   * stacked down a 1,200px page with each one using a fifth of its own row. A
   * card states what it needs with `span` and the default is still the whole
   * row, so nothing that has not thought about it changed.
   */
  const body = (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      {narrow && atIndex ? <SettingsIndex /> : <Outlet />}
    </div>
  );

  const links = SECTIONS.map((section) => (
    <NavLink
      key={section.to}
      to={section.to}
      className={({ isActive }) =>
        asRail
          ? `block rounded-md px-2 py-1.5 text-quiet font-semibold ${
              isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2'
            }`
          : `-mb-px border-b-2 px-3 py-2 text-quiet font-semibold ${
              isActive ? 'border-accent text-accent' : 'border-transparent text-muted'
            }`
      }
    >
      {section.label}
    </NavLink>
  ));

  if (asRail) {
    /*
     * The rail sits inside the page rather than beside the app's own sidebar.
     *
     * It belongs to Settings and disappears with it, so putting it in the shell
     * would mean the shell knowing which page is open — and a second permanent
     * column on every other screen.
     */
    return (
      <div>
        {header}
        <div className="flex gap-6">
          <nav aria-label="Settings sections" className="w-40 shrink-0 border-r border-line pr-2">
            {links}
          </nav>
          <div className="min-w-0 flex-1">{body}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* The tab row is the better control where every destination fits at
          once, and thirteen never do on a phone. */}
      {!narrow && (
        <nav aria-label="Settings sections" className="mb-6 flex gap-2 border-b border-line">
          {links}
        </nav>
      )}

      {body}
    </div>
  );
}
