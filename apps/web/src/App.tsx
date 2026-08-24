import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client.js';
import { useSession } from './auth/SessionProvider.jsx';
import { NotificationBanners } from './components/NotificationBanners.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { ChangePassword } from './pages/ChangePassword.jsx';
import { SetUpTwoFactor } from './pages/SetUpTwoFactor.jsx';
import { MainBudget } from './pages/MainBudget.jsx';
import { AccountsSection } from './pages/settings/Accounts.jsx';
import { ArchivedSection } from './pages/settings/Archived.jsx';
import { BitcoinSection } from './pages/settings/Bitcoin.jsx';
import { PropertiesSection } from './pages/settings/Properties.jsx';
import { BudgetSection } from './pages/settings/Budget.jsx';
import { DelegationsSection } from './pages/settings/Delegations.jsx';
import { GroupingsSection } from './pages/settings/Groupings.jsx';
import { RulesSection } from './pages/settings/Rules.jsx';
import { DisplaySection } from './pages/settings/Display.jsx';
import { TorSection } from './pages/settings/Tor.jsx';
import { UsersSection } from './pages/settings/Users.jsx';
import { SettingsLayout } from './pages/settings/SettingsLayout.jsx';
import { SyncSection } from './pages/settings/Sync.jsx';
import { Transactions } from './pages/Transactions.jsx';
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

/** Everything behind a session, wrapped in the shell. */
function AppShell({ appName }: { appName: string }): ReactNode {
  return (
    <div className="flex h-full">
      <Sidebar appName={appName} />
      <main className="flex-1 overflow-auto px-6 py-8 md:px-12">
        <div className="mx-auto w-full max-w-[1200px]">
          {/* Above the page rather than on one of them: a failing sync is not a
              fact about the Transactions page. */}
          <NotificationBanners />
          <Outlet />
        </div>
      </main>
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
          <Route path="utilities" element={<Utilities />} />
          <Route path="insights" element={<Insights />} />
          <Route path="settings" element={<SettingsLayout />}>
            {/* Sync is the landing section: it is the one that has to work
                before anything else on this page means anything. */}
            <Route index element={<Navigate to="sync" replace />} />
            <Route path="sync" element={<SyncSection />} />
            <Route path="accounts" element={<AccountsSection />} />
            <Route path="delegations" element={<DelegationsSection />} />
            <Route path="groupings" element={<GroupingsSection />} />
            <Route path="rules" element={<RulesSection />} />
            <Route path="bitcoin" element={<BitcoinSection />} />
            <Route path="properties" element={<PropertiesSection />} />
            <Route path="budget" element={<BudgetSection />} />
            <Route path="users" element={<UsersSection />} />
            <Route path="tor" element={<TorSection />} />
            {/* The tab was Security until two-factor moved to Users; anything
                bookmarked or linked still lands somewhere. */}
            <Route path="security" element={<Navigate to="/settings/tor" replace />} />
            <Route path="display" element={<DisplaySection />} />
            <Route path="archived" element={<ArchivedSection />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
