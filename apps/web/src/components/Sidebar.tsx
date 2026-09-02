import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { authApi, syncApi } from '../api/client.js';
import { useSession } from '../auth/SessionProvider.jsx';
import { Button } from './ui.jsx';

/**
 * The left sidebar: 232px, collapsible to a 64px icon rail.
 *
 * Collapse state persists across sessions, per the design. It lives in
 * localStorage rather than on the server: it is a per-device preference, and a
 * shared household budget should not have one person's collapsed sidebar follow
 * the other to their own laptop.
 */

const COLLAPSE_KEY = 'budget.sidebar.collapsed';

/**
 * Drawn rather than typed.
 *
 * The icons were Unicode glyphs — ▤ ⇄ ◷ ◔ ⚙ — which render at whatever weight
 * and baseline each platform decides, so the set never looked like a set. These
 * are one stroke weight, one grid, one visual language, and they take their
 * colour from the link they sit in.
 */
export function Icon({ name }: { readonly name: PageIcon }): ReactNode {
  const shapes: Record<PageIcon, ReactNode> = {
    // A ledger: rows in a frame.
    budget: (
      <>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <path d="M2.5 8h15M7.5 8v8.5" />
      </>
    ),
    // Two flows, opposite directions.
    transactions: (
      <>
        <path d="M3 7h11l-3-3M17 13H6l3 3" />
      </>
    ),
    // A meter, which is what a utility bill is read off.
    utilities: (
      <>
        <path d="M3.5 15a7.5 7.5 0 1 1 13 0" />
        <path d="M10 15l3.5-4" />
      </>
    ),
    // A page with a fold: a bill in an envelope.
    bills: (
      <>
        <path d="M5 3.5h10v13l-2.5-1.5L10 16.5l-2.5-1.5L5 16.5z" />
        <path d="M8 7.5h4M8 10.5h4" />
      </>
    ),
    // Bars of unequal height: a comparison.
    insights: (
      <>
        <path d="M4 16.5v-5M10 16.5v-9M16 16.5v-3" />
      </>
    ),
    // Sliders. A gear turns to mush at this size.
    settings: (
      <>
        <path d="M3 6h9M15 6h2M3 14h2M8 14h9" />
        <circle cx="13.5" cy="6" r="2" />
        <circle cx="6.5" cy="14" r="2" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {shapes[name]}
    </svg>
  );
}

export type PageIcon = 'budget' | 'transactions' | 'bills' | 'utilities' | 'insights' | 'settings';

export const PAGES = [
  { to: '/', label: 'Budget', icon: 'budget', end: true },
  { to: '/transactions', label: 'Transactions', icon: 'transactions', end: false },
  { to: '/bills', label: 'Bills', icon: 'bills', end: false },
  { to: '/utilities', label: 'Utilities', icon: 'utilities', end: false },
  { to: '/insights', label: 'Insights', icon: 'insights', end: false },
  { to: '/settings', label: 'Settings', icon: 'settings', end: false },
] as const satisfies readonly { to: string; label: string; icon: PageIcon; end: boolean }[];

function useCollapsed(): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === 'true';
  });

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  return [collapsed, setCollapsed];
}

function formatLastSync(iso: string | null): string {
  if (!iso) return 'Never synced';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

export function Sidebar({ appName }: { appName: string }): ReactNode {
  const [collapsed, setCollapsed] = useCollapsed();
  const { user } = useSession();
  const queryClient = useQueryClient();

  const syncStatus = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: syncApi.status,
    // A sync takes seconds and runs hourly on its own; this keeps the caption
    // honest without polling hard.
    refetchInterval: 60_000,
  });

  const runSync = useMutation({
    mutationFn: syncApi.run,
    onSettled: async () => {
      // Balances, transactions and the budget view can all have moved.
      await queryClient.invalidateQueries();
    },
  });

  const [signingOut, setSigningOut] = useState(false);

  /**
   * A full page load rather than a client-side route change.
   *
   * Signing out has to leave nothing behind, and the in-memory caches of a
   * single-page application are exactly the sort of thing that quietly survives
   * a re-render — query data fetched as the previous user, a stale session read,
   * component state. Reloading discards all of it at once, and cannot be got
   * subtly wrong the way unwinding it by hand can.
   *
   * Deliberately not a `useMutation`. Its callbacks belong to the component's
   * observer, so if this component unmounts while the request is in flight —
   * which a re-render of the shell can do — the callback is dropped and the
   * navigation never happens. The result is a browser still showing the budget
   * of a session the server has already destroyed. A plain handler cannot be
   * skipped that way.
   *
   * `finally`, not the success path: if the request failed the browser is in an
   * unknown state, which is the last moment to keep someone's budget on screen.
   */
  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await authApi.logout();
    } finally {
      window.location.assign('/login');
    }
  }

  /*
   * Expanded, the sidebar is as wide as its longest label — "Transactions" —
   * plus the icon, the gap and the padding around it. `w-fit` rather than a
   * number, so it stays right if a destination is ever renamed.
   *
   * Two things make that safe. Every nav label is `whitespace-nowrap`, so the
   * links state a real intrinsic width rather than collapsing to their longest
   * word. And the app name and the signed-in address are capped and truncated,
   * because `w-fit` takes the widest child and an email address is wider than
   * anything anybody navigates to.
   */
  const width = collapsed ? 'w-rail' : 'w-fit min-w-rail';

  return (
    <nav
      aria-label="Main"
      // Gone below `sm`, where the tab bar is the navigation. Not narrowed:
      // even the 64px rail is 16% of a phone's width for something a bottom bar
      // does in 9% of its height, and the rail is a manual toggle nobody has
      // found yet on their first run.
      className={`${width} hidden shrink-0 flex-col border-r border-line bg-canvas transition-[width] sm:flex`}
    >
      <div className="flex items-center gap-2 px-3 py-3">
        {!collapsed && (
          <span className="max-w-sidebar-cap truncate font-semibold text-ink">{appName}</span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className="ml-auto rounded p-1 text-muted hover:bg-surface-2"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <ul className="flex flex-1 flex-col px-2">
        {PAGES.map((page) => (
          <li key={page.to}>
            <NavLink
              to={page.to}
              end={page.end}
              title={collapsed ? page.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-base font-medium ${
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'
                } ${collapsed ? 'justify-center' : ''}`
              }
            >
              <Icon name={page.icon} />
              {!collapsed && <span className="whitespace-nowrap">{page.label}</span>}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="border-t border-line px-2 py-3">
        <Button
          onClick={() => runSync.mutate()}
          disabled={runSync.isPending || syncStatus.data?.syncing === true}
          className="w-full"
          title={collapsed ? 'Sync SimpleFIN' : undefined}
        >
          {collapsed ? '⟳' : runSync.isPending ? 'Syncing…' : 'Sync SimpleFIN'}
        </Button>

        {!collapsed && (
          <p className="mt-1 max-w-sidebar-cap px-1 text-label text-muted">
            {syncStatus.data?.configured === false
              ? 'Not configured'
              : formatLastSync(syncStatus.data?.lastSyncAt ?? null)}
          </p>
        )}

        {/* A failed sync is surfaced here as well as on the page, because this is
            where the owner looks when he wonders whether data is current. */}
        {!collapsed && syncStatus.data?.failing === true && (
          <p className="mt-1 px-1 text-label font-semibold text-danger">Last sync failed</p>
        )}
      </div>

      <div className="border-t border-line px-3 py-3">
        {!collapsed && user && (
          <div className="mb-2 max-w-sidebar-cap">
            <p className="truncate text-quiet font-semibold text-ink">{user.username}</p>
            <p className="text-label text-muted">
              {user.role === 'super_admin'
                ? 'Super Admin'
                : user.role === 'admin'
                  ? 'Admin'
                  : 'User'}
            </p>
          </div>
        )}
        <Button
          variant="ghost"
          onClick={() => void signOut()}
          disabled={signingOut}
          className="w-full"
          title={collapsed ? 'Sign out' : undefined}
        >
          {collapsed ? '⎋' : 'Sign out'}
        </Button>
      </div>
    </nav>
  );
}
