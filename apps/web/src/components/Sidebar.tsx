import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
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

const PAGES = [
  { to: '/', label: 'Main Budget', icon: '▤', end: true },
  { to: '/transactions', label: 'Transactions', icon: '⇄', end: false },
  { to: '/utilities', label: 'Utilities', icon: '◷', end: false },
  { to: '/insights', label: 'Insights', icon: '◔', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙', end: false },
] as const;

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
  const { user, clear } = useSession();
  const navigate = useNavigate();
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

  const signOut = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      clear();
      void navigate('/login', { replace: true });
    },
  });

  const width = collapsed ? 'w-rail' : 'w-sidebar';

  return (
    <nav
      aria-label="Main"
      className={`${width} flex shrink-0 flex-col border-r border-line bg-canvas transition-[width]`}
    >
      <div className="flex items-center gap-2 px-3 py-4">
        <span aria-hidden className="text-lg">
          ◈
        </span>
        {!collapsed && <span className="truncate font-semibold text-ink">{appName}</span>}
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

      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {PAGES.map((page) => (
          <li key={page.to}>
            <NavLink
              to={page.to}
              end={page.end}
              title={collapsed ? page.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-2 py-2 text-base font-medium ${
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'
                } ${collapsed ? 'justify-center' : ''}`
              }
            >
              <span aria-hidden className="text-[17px]">
                {page.icon}
              </span>
              {!collapsed && <span>{page.label}</span>}
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
          <p className="mt-1 px-1 text-label text-muted">
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
          <div className="mb-2">
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
          onClick={() => signOut.mutate()}
          className="w-full"
          title={collapsed ? 'Sign out' : undefined}
        >
          {collapsed ? '⎋' : 'Sign out'}
        </Button>
      </div>
    </nav>
  );
}
