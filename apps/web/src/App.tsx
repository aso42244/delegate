import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client.js';
import { useSession } from './auth/SessionProvider.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { ChangePassword } from './pages/ChangePassword.jsx';
import { MainBudget } from './pages/MainBudget.jsx';
import { BudgetSection } from './pages/settings/Budget.jsx';
import { ReconcileSection } from './pages/settings/Reconcile.jsx';
import { SettingsLayout } from './pages/settings/SettingsLayout.jsx';
import { SyncSection } from './pages/settings/Sync.jsx';
import { Transactions } from './pages/Transactions.jsx';
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

function Placeholder({ title, note }: { title: string; note: string }): ReactNode {
  return (
    <div>
      <h1 className="text-page font-bold text-ink">{title}</h1>
      <p className="mt-1 text-quiet text-muted">{note}</p>
    </div>
  );
}

/** Everything behind a session, wrapped in the shell. */
function AppShell({ appName }: { appName: string }): ReactNode {
  return (
    <div className="flex h-full">
      <Sidebar appName={appName} />
      <main className="flex-1 overflow-auto px-6 py-8 md:px-12">
        <div className="mx-auto w-full max-w-[1200px]">
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

      <Route element={<RequireSession />}>
        <Route element={<AppShell appName={appName} />}>
          <Route index element={<MainBudget />} />
          <Route path="transactions" element={<Transactions />} />
          <Route
            path="utilities"
            element={<Placeholder title="Utilities" note="Phase 2: needs categorized history." />}
          />
          <Route
            path="insights"
            element={<Placeholder title="Insights" note="Phase 2: needs categorized history." />}
          />
          <Route path="settings" element={<SettingsLayout />}>
            {/* Sync is the landing section: it is the one that has to work
                before anything else on this page means anything. */}
            <Route index element={<Navigate to="sync" replace />} />
            <Route path="sync" element={<SyncSection />} />
            <Route path="budget" element={<BudgetSection />} />
            <Route path="reconcile" element={<ReconcileSection />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
