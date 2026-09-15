import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { budgetApi } from '../api/budget.js';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { authApi, syncApi } from '../api/client.js';
import { Alerts } from './Alerts.jsx';
import { BalanceButton } from './BalanceReading.jsx';
import { ControlPopover } from './ControlPopover.jsx';
import { describeSync, readSync } from './sync-status.js';
import { DelegateControl } from './DelegateControl.jsx';
import { Tag } from './Tag.jsx';
import { Button, buttonFace, Modal } from './ui.jsx';
import {
  BACKLOG_KIND,
  byUrgency,
  loudest,
  SYNC_KINDS,
  useNotifications,
  type NotificationDto,
} from './notifications.js';
import { useIsDemo } from '../useDemo.js';
import { pathFor } from '../demo/is-demo.js';

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
    /*
     * A funnel: things go in at the top and come out sorted.
     *
     * Not a gear, which is what a settings icon looks like and is what this
     * moved away from being. Not a filter's usual funnel-with-a-handle either,
     * because the register's own filters use that shape and two meanings for one
     * drawing is the mistake the chip vocabulary exists to prevent.
     */
    rules: (
      <>
        <path d="M3 4.5h14l-5.5 6v6l-3-2v-4z" />
      </>
    ),
    // Bars of unequal height: a comparison.
    insights: (
      <>
        <path d="M4 16.5v-5M10 16.5v-9M16 16.5v-3" />
      </>
    ),
    /*
     * The panel and the arrow: a sidebar, and which way it goes.
     *
     * It was `«` and `»`, which is the same mistake the nav icons were fixed
     * for — a Unicode glyph renders at whatever weight and baseline each
     * platform decides, and beside six drawn icons it read as a different kind
     * of thing. Same 20-unit grid, same stroke.
     */
    collapse: (
      <>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <path d="M8 3.5v13M14.5 10h-4M12.5 8l-2 2 2 2" />
      </>
    ),
    expand: (
      <>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <path d="M8 3.5v13M10.5 10h4M12.5 8l2 2-2 2" />
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

/**
 * Every drawn mark in the shell, not only the destinations.
 *
 * `collapse` and `expand` are here rather than typed apart because they are the
 * same 20-unit grid and the same stroke — that sameness is the point, and a
 * second type would let it drift.
 */
export type PageIcon =
  | 'budget'
  | 'transactions'
  | 'bills'
  | 'rules'
  | 'utilities'
  | 'insights'
  | 'settings'
  | 'collapse'
  | 'expand';

export const PAGES = [
  /*
   * Overview first, and — since ADR 067 — the only one of the two.
   *
   * It was Overview then Budget: a quick review, then the full inspection. The
   * owner's reading after a fortnight of ADR 065's dashboard is that the two had
   * become duplicative, so **Budget is hidden from the navigation for a trial
   * rather than deleted**. Nothing else about it changed: `/budget` is still
   * routed, still rendered by `MainBudget`, and still where a landing
   * preference of `budget` sends somebody.
   *
   * Putting it back is this line, and nothing else:
   *
   *   { to: '/budget', label: 'Budget', icon: 'budget', end: false },
   *
   * Both navigations read this list — the sidebar and `TabBar` — so one line
   * decides both, which is why it is the only edit the trial needed.
   */
  { to: '/overview', label: 'Overview', icon: 'insights', end: false },
  { to: '/transactions', label: 'Transactions', icon: 'transactions', end: false },
  /*
   * Beside Transactions rather than inside Settings.
   *
   * A rule is written while categorizing, reordered when one shadows another,
   * and read whenever a charge lands somewhere surprising. That is the register's
   * rhythm, not a thing configured once — and under Settings it was three clicks
   * from the page it is about.
   */
  { to: '/rules', label: 'Rules', icon: 'rules', end: false },
  /*
   * One entry, two views. Bills and Utilities were two entries over the same
   * merchants — one watching whether a charge arrived, one judging whether the
   * line is funded at what it costs — and Electricity sat on both, described two
   * different ways.
   */
  { to: '/recurring', label: 'Recurring', icon: 'bills', end: false },
  { to: '/settings', label: 'Settings', icon: 'settings', end: false },
] as const satisfies readonly { to: string; label: string; icon: PageIcon; end: boolean }[];

/**
 * The pages the demo has data for.
 *
 * Only these: a link to a page whose figures are not invented is a link to an
 * empty screen, which looks like a fault rather than a boundary.
 */
/*
 * What a demo navigates to.
 *
 * `/budget` stays named here although `PAGES` no longer carries it, because this
 * is a filter over that list: an entry naming a page that is not in it simply
 * matches nothing. Keeping it means putting Budget back is one line up there
 * rather than two in two places — and it records that the demo's exclusion of
 * Budget is the trial's doing rather than a decision about the demo.
 */
const DEMO_PAGES = new Set(['/overview', '/budget']);

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

/** Which button a severity paints. Only these two are ever loud enough. */
function variantFor(tone: ReturnType<typeof loudest>): 'default' | 'warning' | 'danger' {
  if (tone === 'danger') return 'danger';
  if (tone === 'warning') return 'warning';
  return 'default';
}

/**
 * The categorization backlog, as a control rather than a tag.
 *
 * It was an `info` tag in the column above — "4 new transactions" — and a tag is
 * the wrong object for it (ADR 066). Everything else in that column is a
 * condition somebody reads and then decides about. This is a queue of work with
 * exactly one thing anybody ever does about it, and it sits one press from the
 * screen where ADR 065 made that doing possible.
 *
 * **Only when there is one.** Unlike the reading above it, which is always
 * there and always coloured, this control does not exist on a morning with
 * nothing waiting — which is what keeps `ui-system.md` §5's rule intact: a soft
 * fill in this zone means a control is reporting a state, and an empty queue is
 * not a state worth a button.
 *
 * **Blue, because it is not a fault.** A backlog is the ordinary consequence of
 * a bank feed that works; `info` is the tone the notification already carried,
 * and the same blue the reading takes when there is money to delegate. Yellow
 * would say something had gone wrong.
 *
 * **It does not ask first**, because it does not act. The three that do —
 * Delegate, Sync, Sign out — distribute a pay packet, roll one back, fetch the
 * bank or end the session, and every one of them asks. This navigates, exactly
 * as the reading above it does, and a confirmation on a link is a dialog in the
 * way of nothing.
 */
function BacklogControl({ collapsed }: { readonly collapsed: boolean }): ReactNode {
  const detailId = useId();
  const notifications = useNotifications();

  const backlog = (notifications.data?.notifications ?? []).find(
    (row) => row.kind === BACKLOG_KIND,
  );

  if (backlog === undefined) return null;

  return (
    <div className="group relative">
      <Link
        to={backlog.actionPath}
        aria-describedby={detailId}
        /*
         * Named by the count, which is what the tag said and what the end-to-end
         * suite looks for. Kept off `role="status"` deliberately: the reading
         * above is this zone's live region, and a second one 8px away would have
         * a screen reader announcing two things on every sync.
         */
        aria-label={backlog.pill}
        title={collapsed ? backlog.pill : undefined}
        className={`${buttonFace('info')} w-full`}
      >
        {collapsed ? (
          /*
           * The register's own mark, in the rail.
           *
           * A drawn icon rather than a character, unlike Sync's `⟳` and Sign
           * out's `⎋`: those name acts that have no page, and this one goes to a
           * destination that is already in the icon set. Repeating the
           * navigation's glyph is the point — blue, at the foot, it reads as
           * "the register, with something waiting in it".
           */
          <Icon name="transactions" />
        ) : (
          // `truncate` for the same reason the reading truncates: the sidebar is
          // as wide as its longest nav label, and the whole sentence is in the
          // popover and the count is in the name either way.
          <span className="min-w-0 truncate">{backlog.pill}</span>
        )}
      </Link>

      {/* The sentence the tag's hover used to carry, in the shape this zone
          says it in — including the age of the oldest, which is the half the
          face has no room for and the half that says whether it is urgent. */}
      <ControlPopover id={detailId}>
        <span className="text-quiet text-ink">{backlog.message}</span>
      </ControlPopover>
    </div>
  );
}

/**
 * Sync SimpleFIN, carrying everything the bank feed has to say.
 *
 * The feed's conditions used to be five separate tags in the column above this
 * button — "Sync failing", "1 account not reporting", "2 stale balances", "1 new
 * account" — each a yellow pill sitting directly over a yellow button, all of
 * them answered by looking at the same connection. That is one sentence said
 * five times, and it crowded out the alerts the feed has nothing to do with.
 *
 * They are inside the button now. It takes the colour of the loudest of them,
 * and the whole list opens on hover and on focus, **most significant first**.
 *
 * **The list is reachable, not merely visible.** Every row is still a link to
 * where its condition is dealt with, so the panel takes the pointer rather than
 * refusing it — which is why it hangs from a padded wrapper: a gap between the
 * button and the card would drop `:hover` as the mouse crossed it, and the panel
 * would close on the way to the thing being reached for.
 *
 * **Not on a phone.** There is no sidebar below `sm` and so no button to fold
 * into; `Alerts inline` keeps the feed's own alongside the rest there.
 */
function SyncControl({ collapsed }: { readonly collapsed: boolean }): ReactNode {
  const queryClient = useQueryClient();
  const detailId = useId();

  const syncStatus = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: syncApi.status,
    // A sync takes seconds and runs hourly on its own; this keeps the button's
    // colour honest without polling hard.
    refetchInterval: 60_000,
  });

  const runSync = useMutation({
    mutationFn: syncApi.run,
    onSettled: async () => {
      // Balances, transactions and the budget view can all have moved.
      await queryClient.invalidateQueries();
    },
  });

  const notifications = useNotifications();
  const reported = (notifications.data?.notifications ?? []).filter((row) =>
    SYNC_KINDS.has(row.kind),
  );

  /*
   * The live status, when the notifications have not said it yet.
   *
   * Five minutes is a long time to look green after a run has failed, and the
   * status endpoint already knows. Matched on `kind`, so once the notification
   * arrives with its own fuller message this drops out rather than doubling it.
   */
  const detail = describeSync(syncStatus.data);
  const live: readonly NotificationDto[] =
    detail !== null && !reported.some((row) => row.kind === 'sync_failing')
      ? [
          {
            kind: 'sync_failing',
            severity: 'danger',
            pill: 'Sync failing',
            message: detail,
            actionPath: '/settings/sync',
          },
        ]
      : [];

  // Loudest first: the panel is read downwards, unlike the column above it.
  const folded = [...byUrgency([...reported, ...live])].reverse();
  const tone = loudest(folded);

  /*
   * What a quiet feed says about itself.
   *
   * Read at render rather than held in state: the popover is closed almost all
   * of the time, and a ticking clock behind a hidden panel is a re-render a
   * minute for something nobody is looking at. The status query already
   * refetches every 60s, which moves this along whenever it matters.
   */
  const reading = readSync(syncStatus.data, new Date());

  /*
   * A `title` only on the rail, and only to name the control.
   *
   * Collapsed, the button is a glyph and its `title` is the only name it has.
   * Expanded it names itself, and a native tooltip would open on the same hover
   * as the panel below and sit on top of it saying less.
   */
  const title = collapsed ? 'Sync SimpleFIN' : undefined;

  return (
    <div className="group relative">
      <Button
        /*
         * The button is the state.
         *
         * A caption under it said how long ago the last sync was, which is a
         * figure nobody acts on, and a second line appeared under that when a
         * run failed. Both are gone, and so are the feed's tags: what the
         * connection has to say is the colour of the thing somebody would press
         * about it, with the words one hover away.
         */
        variant={variantFor(tone)}
        onClick={() => runSync.mutate()}
        disabled={runSync.isPending || syncStatus.data?.syncing === true}
        className="w-full"
        title={title}
        {...(folded.length > 0 || reading !== null ? { 'aria-describedby': detailId } : {})}
      >
        {collapsed ? '⟳' : runSync.isPending ? 'Syncing…' : 'Sync SimpleFIN'}
      </Button>

      {/*
        The panel says whichever of the two readings applies.

        When the feed is reporting something, that is the answer and the last
        run's timing is beside the point. When it is quiet — which is nearly
        always — the useful thing is that it ran and what it brought back, which
        used to be a caption under the button and is now only here, where it
        costs no floor space.
      */}
      {folded.length > 0 ? (
        <ControlPopover id={detailId}>
          {folded.map((row) => (
            <Link
              key={row.kind}
              to={row.actionPath}
              className="-mx-2 flex flex-col items-start gap-1 rounded-md px-2 py-1 hover:bg-surface-2"
            >
              <Tag tone={row.severity} size="md">
                {row.pill}
              </Tag>
              <span className="text-quiet text-ink">{row.message}</span>
            </Link>
          ))}
        </ControlPopover>
      ) : (
        reading !== null && (
          <ControlPopover id={detailId}>
            <span className="text-quiet text-ink">{reading.when}</span>
            {/* Only when the run actually found something. "0 new transactions"
                is a line that says nothing and appears on every quiet day. */}
            {reading.added !== null && (
              <span className="text-quiet text-muted">{reading.added}</span>
            )}
          </ControlPopover>
        )
      )}
    </div>
  );
}

/**
 * Sign out, and the confirmation it now asks for.
 *
 * **Plain, like the two above it, with a red hover.** It was `ghost` — no
 * outline at all — in a block of its own under a rule, which made it read as
 * furniture rather than as the fourth control in a set of four. Colour in this
 * zone means a control is reporting a state (`ui-system.md` §5), and signing out
 * has none; what it *will do* shows on the way to pressing it.
 *
 * **It asks first.** Every other control in this zone does, and for the same
 * reason: they are 8px apart, and the one directly above this is the bank sync
 * somebody presses several times a day. Signing out is a full page load, so a
 * misclick costs the whole session and everything typed into it — there is no
 * undo, and no state to come back to.
 *
 * The Settings → Users copy of this button is deliberately not confirmed: it is
 * three navigations deep, it is nowhere near anything else, and on a phone it is
 * the only route there is.
 */
function SignOutControl({ collapsed }: { readonly collapsed: boolean }): ReactNode {
  const [asking, setAsking] = useState(false);
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

  return (
    <>
      <Button
        hover="danger"
        onClick={() => setAsking(true)}
        disabled={signingOut}
        className="w-full"
        title={collapsed ? 'Sign out' : undefined}
        aria-label={collapsed ? 'Sign out' : undefined}
      >
        {collapsed ? '⎋' : 'Sign out'}
      </Button>

      {asking && (
        <Modal
          label="Confirm sign out"
          title="Sign out"
          onClose={() => setAsking(false)}
          /* A reading has nothing to lose to a stray press beside the card, and
             this dialog holds nothing typed — the same argument the delegate
             confirmations make. */
          dismissible
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAsking(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => void signOut()} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          }
        >
          <p className="text-base text-ink">
            End this session and return to the sign-in screen.
            <span className="mt-2 block text-quiet text-muted">
              Nothing in the budget changes. Signing back in needs the password, and the second
              factor if one is set up.
            </span>
          </p>
        </Modal>
      )}
    </>
  );
}

export function Sidebar({ appName }: { appName: string }): ReactNode {
  /*
   * A demo has no Settings and no sync.
   *
   * Settings is where the bank-feed credential and the household's accounts
   * live, and neither is worth showing to a room. Sync is a write, which the
   * server refuses anyway — this is about not offering it.
   */
  /*
   * On the demo, the navigation stays on the demo.
   *
   * Every link is rewritten under `/demo`, because the first press of "Budget"
   * otherwise lands somebody in their own money halfway through showing
   * somebody else's. Settings goes entirely: it is where the bank-feed
   * credential lives and there is nothing there worth showing to a room.
   */
  const demo = useIsDemo();
  const pages = (demo ? PAGES.filter((page) => DEMO_PAGES.has(page.to)) : PAGES).map((page) => ({
    ...page,
    to: pathFor(page.to, demo),
  }));

  const [collapsed, setCollapsed] = useCollapsed();

  // The budget's own reading, which is the top of the control zone below.
  const budget = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

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
   *
   * With a floor under it. `w-fit` alone is about 145px, which is right and
   * reads as cramped — the labels sit against the edge with nothing around
   * them. `min-w-sidebar` is 180px: more than the content strictly needs, less
   * than the 232px this started at.
   */
  const width = collapsed ? 'w-rail' : 'w-fit min-w-sidebar';

  return (
    <nav
      aria-label="Main"
      // Gone below `sm`, where the tab bar is the navigation. Not narrowed:
      // even the 64px rail is 16% of a phone's width for something a bottom bar
      // does in 9% of its height, and the rail is a manual toggle nobody has
      // found yet on their first run.
      className={`${width} hidden shrink-0 flex-col border-r border-line bg-canvas transition-[width] sm:flex`}
    >
      {/*
        Collapsed, the toggle joins the icons: same size, same column, same
        hover — with a rule under it, because it acts on the sidebar itself
        rather than going anywhere. Expanded, it sits at the end of the name
        row, which is where a control that closes something belongs.
      */}
      <div
        className={`flex items-center gap-2 px-3 py-3 ${
          collapsed ? 'justify-center border-b border-line' : ''
        }`}
      >
        {!collapsed && (
          <span className="max-w-sidebar-cap truncate font-semibold text-ink">{appName}</span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={`rounded-md p-1.5 text-muted hover:bg-surface-2 ${collapsed ? '' : 'ml-auto'}`}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
        </button>
      </div>

      <ul className="flex flex-1 flex-col px-2">
        {pages.map((page) => (
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

      {/*
        What the application has to say, at the foot of the navigation and above
        everything that acts. `mt-auto` puts the whole group at the bottom
        whatever the page list comes to.
      */}
      <div className="mt-auto">{!collapsed && <Alerts />}</div>

      {/*
        The control zone: one group, 8px apart, under one rule.

        **The reading first, and it is the only one that is always there and
        always coloured.** Green, blue or red — where the budget stands — and a
        press goes to Overview whatever it says.

        **Then the backlog, when there is one** (ADR 066). Blue, because a queue
        of new charges is the ordinary consequence of a working bank feed rather
        than a fault, and a link rather than an act: it opens the queue. It was a
        tag in the column above until ADR 066, which made the one notification
        that is *work* look like the ones that are conditions.

        Then the two acts on the household, in the order they are reached for:
        Delegate, then Sync. Neither is a fact about the page underneath — the
        argument ADR 059 used to move the alerts out of the page header.

        Then Sign out, which was in a block of its own under a second rule. It is
        drawn as one of the set now (ADR 064): a divider between a button and the
        button above it said there were two groups where there is one.

        **Everything here that acts asks first**, because they are 8px apart and
        they distribute a pay packet, roll one back, fetch the bank, and end the
        session. The two that only navigate — the reading and the backlog — do
        not, and a confirmation on a link would be a dialog in the way of
        nothing.
      */}
      <div className="flex flex-col gap-2 border-t border-line px-2 py-3">
        {budget.data && <BalanceButton view={budget.data} collapsed={collapsed} />}

        {/* Only when the queue is not empty, so it does not compete with the
            reading on a morning with nothing waiting. A demo never has one:
            `useNotifications` does not run there. */}
        <BacklogControl collapsed={collapsed} />

        <DelegateControl collapsed={collapsed} />

        {/* The bank feed, and everything it has to say about itself. A demo has
            no feed to sync — invented data does not come from anywhere. */}
        {!demo && <SyncControl collapsed={collapsed} />}

        <SignOutControl collapsed={collapsed} />
      </div>
    </nav>
  );
}
