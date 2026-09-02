import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client.js';
import { useSession } from './auth/SessionProvider.jsx';
import { TabBar } from './components/TabBar.jsx';
import { NARROW, useMediaQuery } from './useMediaQuery.js';
import { Sidebar } from './components/Sidebar.jsx';
import { ChangePassword } from './pages/ChangePassword.jsx';
import { SetUpTwoFactor } from './pages/SetUpTwoFactor.jsx';
import { MainBudget } from './pages/MainBudget.jsx';
import { AccountsSection } from './pages/settings/Accounts.jsx';
import { ArchivedSection } from './pages/settings/Archived.jsx';
import { RulesSection } from './pages/settings/Rules.jsx';
import { DisplaySection } from './pages/settings/Display.jsx';
import { AccessSection, BudgetGroupSection, HoldingsSection } from './pages/settings/Sections.jsx';
import { SettingsLayout } from './pages/settings/SettingsLayout.jsx';
import { SyncSection } from './pages/settings/Sync.jsx';
import { Transactions } from './pages/Transactions.jsx';
import { Bills } from './pages/Bills.jsx';
import { Insights } from './pages/Insights.jsx';
import { Utilities } from './pages/Utilities.jsx';
import { SignIn } from './pages/SignIn.jsx';

/**
 * Routing and the app shell.
 *
 * The application name comes from the server, never from a literal here: the
 * owner's preferred title is a family name, and personal data must not live in
 * the repository. See docs/design.md, decision 6.
 */

function useAppName(): string {
  const query = useQuery({
    queryKey: ['app-name'],
    queryFn: () => api.get<{ appName: string }>('/api/app'),
    staleTime: Infinity,
  });
  return query.data?.appName ?? 'Delegate';
}

/**
 * What `/settings` shows, which depends on how wide the screen is.
 *
 * On a phone it is an index list — rendered by the layout in place of the
 * outlet, so this renders nothing. On a wider screen there is a tab row and no
 * section chosen, so Sync lands: it is the one that has to work before anything
 * else on that page means anything.
 *
 * A plain redirect would send every phone straight past the index, and the back
 * link from a section would then reach a page that immediately bounced forward
 * again.
 */
function SettingsLanding(): ReactNode {
  const narrow = useMediaQuery(NARROW);
  return narrow ? null : <Navigate to="sync" replace />;
}

/** Everything behind a session, wrapped in the shell. */
function AppShell({ appName }: { appName: string }): ReactNode {
  /*
   * The scrolling element, handed to the tab bar so it can watch it.
   *
   * `<main>` scrolls here, not the window — the shell is a full-height flex row
   * — so a listener on `window` would never fire. State rather than a ref
   * because the bar has to re-subscribe when the node first exists.
   */
  const [scroller, setScroller] = useState<HTMLElement | null>(null);

  return (
    <div className="flex h-full">
      {/* Below `sm` the sidebar is replaced by the tab bar, not squeezed. */}
      <Sidebar appName={appName} />

      <main
        ref={setScroller}
        // The bottom padding is the tab bar's height plus its safe-area inset,
        // so the last row of a table is never underneath it.
        className="flex-1 overflow-auto px-4 py-6 pb-[calc(3.5rem+env(safe-area-inset-bottom,0px)+1rem)] sm:px-6 sm:py-8 sm:pb-8 md:px-12"
      >
        {/* Nothing above the page any more. Every notification is a pill in the
            page header now, which `PageHeader` renders — so they still reach
            every screen, and none of them costs the screen a row. */}
        <div className="mx-auto w-full max-w-[1200px]">
          <Outlet />
        </div>
      </main>

      <TabBar scroller={scroller} />
    </div>
  );
}

function RequireSession(): ReactNode {
  const { user, isLoading } = useSession();
  const location = useLocation();

  // Nothing is rendered until the server has answered. Guessing and correcting
  // would flash the budget at someone who is not signed in.
  if (isLoading) {
    return <div className="p-8 text-quiet text-muted">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  // A temporary password reaches exactly one screen.
  if (user.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }
  // So does an account that owes the household a second factor. Without this the
  // requirement is a trap: every route answers 403, including the settings page
  // that offers enrolment.
  if (user.needsTwoFactor) {
    return <Navigate to="/set-up-two-factor" replace />;
  }
  return <Outlet />;
}

export function App(): ReactNode {
  const appName = useAppName();
  const { user } = useSession();

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <SignIn appName={appName} />}
      />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/set-up-two-factor" element={<SetUpTwoFactor />} />

      <Route element={<RequireSession />}>
        <Route element={<AppShell appName={appName} />}>
          <Route index element={<MainBudget />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="bills" element={<Bills />} />
          <Route path="utilities" element={<Utilities />} />
          <Route path="insights" element={<Insights />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<SettingsLanding />} />
            <Route path="sync" element={<SyncSection />} />
            <Route path="accounts" element={<AccountsSection />} />
            <Route path="budget" element={<BudgetGroupSection />} />
            <Route path="rules" element={<RulesSection />} />
            <Route path="holdings" element={<HoldingsSection />} />
            <Route path="access" element={<AccessSection />} />
            <Route path="display" element={<DisplaySection />} />
            <Route path="archived" element={<ArchivedSection />} />

            {/*
              Every route this page has ever had still resolves.
              
              Twelve tabs became eight, and a section that moves is a bookmark
              that breaks, a link in somebody's notes that breaks, and a test
              that fails for a reason unrelated to what it is testing. Each of
              these lands on whichever section absorbed it. The first was
              `security`, which became Tor when two-factor moved to Users, and it
              has been redirecting quietly ever since.
            */}
            <Route path="security" element={<Navigate to="/settings/access" replace />} />
            <Route path="users" element={<Navigate to="/settings/access" replace />} />
            <Route path="tor" element={<Navigate to="/settings/access" replace />} />
            <Route path="delegations" element={<Navigate to="/settings/budget" replace />} />
            <Route path="groupings" element={<Navigate to="/settings/budget" replace />} />
            <Route path="bitcoin" element={<Navigate to="/settings/holdings" replace />} />
            <Route path="properties" element={<Navigate to="/settings/holdings" replace />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
