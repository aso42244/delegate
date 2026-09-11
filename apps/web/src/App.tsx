import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.js';
import { DEFAULT_LANDING_PAGE, LANDING_PATH } from '@budget/shared';
import { useSession } from './auth/SessionProvider.jsx';
import { TabBar } from './components/TabBar.jsx';
import { NARROW, useMediaQuery } from './useMediaQuery.js';
import { Sidebar } from './components/Sidebar.jsx';
import { ChangePassword } from './pages/ChangePassword.jsx';
import { SetUpTwoFactor } from './pages/SetUpTwoFactor.jsx';
import { MainBudget } from './pages/MainBudget.jsx';
import { AccountsSection } from './pages/settings/Accounts.jsx';
import { ArchivedSection } from './pages/settings/Archived.jsx';
import { Rules } from './pages/Rules.jsx';
import { DisplaySection } from './pages/settings/Display.jsx';
import { AccessSection, BudgetGroupSection, HoldingsSection } from './pages/settings/Sections.jsx';
import { SettingsLayout } from './pages/settings/SettingsLayout.jsx';
import { SyncSection } from './pages/settings/Sync.jsx';
import { Transactions } from './pages/Transactions.jsx';
import { Recurring } from './pages/Recurring.jsx';
import { Overview } from './pages/Overview.jsx';

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
        /*
         * `md:px-8` rather than `px-12`. design.md §4 puts the content gutter at
         * 28–36px; 48 was over it, and beside a narrow sidebar it read as a gap
         * between the page and the navigation rather than as breathing room.
         */
        className="flex-1 overflow-auto px-4 py-6 pb-[calc(3.5rem+env(safe-area-inset-bottom,0px)+1rem)] sm:px-6 sm:py-8 sm:pb-8 md:px-8"
      >
        {/* Nothing above the page any more. Every notification is a pill in the
            page header now, which `PageHeader` renders — so they still reach
            every screen, and none of them costs the screen a row. */}
        {/*
          1600px, from 1200.

          The cap was set when every page was a table and a column of cards, and
          1200 is where a line of prose stops being comfortable. These pages are
          not prose: Overview is a grid of tiles, Budget is a wide table, and the
          register is a list of rows whose longest column has no upper bound. On
          a modern desktop the old cap left a band of empty surface down each
          side wider than the sidebar.

          Still capped rather than full-bleed — an unbounded page turns a
          three-tile row into a five-tile row on one monitor and a two on
          another, and the arrangement is stored per person, not per screen.
        */}
        <div className="mx-auto w-full max-w-[1600px]">
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

/**
 * Where this person lands.
 *
 * Read from the session rather than stored per device, because it is a fact
 * about the person and not about the browser they happen to be sitting at. Null
 * means they never chose, and the default applies — which is deliberately not
 * the same as having chosen it, so the default can move later without
 * overriding anybody's decision.
 */
function LandingRedirect(): ReactNode {
  const { user } = useSession();
  return <Navigate to={LANDING_PATH[user?.landingPage ?? DEFAULT_LANDING_PAGE]} replace />;
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
          {/*
            The root is "wherever you land", not a page.

            It was the Budget page's own address, which is exactly why a
            per-person landing page could not work: a preference can only ever
            redirect *away* from a root that is already something. Budget has its
            own address now and the root resolves to whichever page this person
            chose.
          */}
          <Route index element={<LandingRedirect />} />
          <Route path="budget" element={<MainBudget />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="recurring" element={<Recurring />} />
          {/* Both old entries land on the page carrying both halves. A bookmark
              is a promise, and the thing each pointed at is on that screen —
              `?view=cost` is gone with the switch it selected, because Due and
              Cost are side by side now rather than one at a time. */}
          <Route path="bills" element={<Navigate to="/recurring" replace />} />
          <Route path="utilities" element={<Navigate to="/recurring" replace />} />
          <Route path="rules" element={<Rules />} />
          {/* Overview replaced it. Same promise as /bills: the thing the
              bookmark pointed at still exists, in better form. */}
          <Route path="insights" element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<Overview />} />

          {/*
            The demo: the same pages, drawing invented numbers.
            
            Not a separate build and not a separate deployment — a route. It is
            behind the same sign-in as everything else because it *is* everything
            else, and the only thing that differs is where the figures come from:
            see `demo/responses.ts`, which answers the one fetch this application
            makes.
          */}
          <Route path="demo">
            <Route index element={<Navigate to="/demo/overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="budget" element={<MainBudget />} />
          </Route>
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<SettingsLanding />} />
            <Route path="sync" element={<SyncSection />} />
            <Route path="accounts" element={<AccountsSection />} />
            <Route path="budget" element={<BudgetGroupSection />} />
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
            {/* Rules left Settings for the sidebar; the old path still lands. */}
            <Route path="rules" element={<Navigate to="/rules" replace />} />
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
