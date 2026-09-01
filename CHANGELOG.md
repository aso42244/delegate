# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are tagged per
phase (`v0.1.0-phase1`, and so on).

## [Unreleased]

### Fixed

- **The uncategorized banner clears the moment the queue does.** It was
  invalidated at two call sites out of the dozens that can change it, and
  categorizing was not one of them — so "12 waiting to be categorized" stayed on
  screen after the last one was filed, and coming back to the Budget page did not
  help because the answer was already cached. It cleared five minutes later, on
  the poll.

  Notifications are now recomputed after **any** mutation that succeeds. Done
  once, centrally, because the list of things that can change a notification is
  every mutation in the application, and a list like that is one somebody
  eventually forgets to add to. They are computed on read and never stored
  (ADR 030), so recomputing one is a cheap query rather than work.

### Changed

- **Insights → New tile is a dialog in the middle of the page, and every option
  shows the shape it draws.** The picker unrolled a panel _below_ the grid, so on
  a page with a dozen tiles pressing the button scrolled nothing into view and
  appeared to do nothing. Each option now carries a small schematic — line, area,
  bars, donut, list or figure — because a reader after a chart is after a shape
  first, and choosing between "Net worth over time" and "Assets against debts"
  from two labels means already knowing what each one draws.

  Schematic rather than real data, deliberately: a live thumbnail per option
  would mean twenty-one queries to answer a question about form, and a household
  three days into its snapshots would see twenty-one identical flat lines — every
  option looking the same at exactly the moment the picker is most used.

- **Buttons are 28px rather than 36px**, at the owner's request — 78% of the
  height, most visible on a phone where the Budget header carries five of them.
  Above the 24px floor WCAG 2.5.8 sets, below the 44px both platforms publish as
  comfortable.

- **"This cycle began …" has left the Budget page.** It sat there permanently and
  was the one line nobody was going to act on — a date, on the screen for
  deciding where money goes. It now reads as what it is, a fact about the
  budget's settings, on Settings → Budget beside the undo window and the pay
  cadence that govern it. The undo offer stays on the Budget header: it is
  transient, it is the only sign a Delegate press can still be taken back, and it
  goes when the window closes.

- **The `s` chip is grey.** Yellow is for something to act on, and how fresh a
  figure is is not something anybody can act on. `p` (pending) and `r` (needs
  review) keep it; everything else is the quiet grey.

## [0.33.0] — 2026-08-28

### Fixed

- **The end of a local day is resolved against the day it is actually
  resolving.** `localDayBounds` checked both of its probes against the _start_
  day's key — a comparison the following midnight can never satisfy — so the end
  bound always discarded its daylight-saving correction and returned the
  uncorrected guess.

  Invisible in `America/Chicago`, which shifts at two in the morning, where both
  answers agree. In a zone that shifts at midnight it is an hour out on
  transition days, which silently moves an hour of transactions into the
  neighbouring day. Found reviewing
  [ADR 037](docs/decisions/037-a-day-is-the-households-day.md); the regression
  test fails without the fix in `America/Santiago`, `America/Havana`,
  `Asia/Beirut` and `Australia/Lord_Howe`.

### Added

- **A day is the household's day, not UTC's**
  ([ADR 037](docs/decisions/037-a-day-is-the-households-day.md)). The zone chosen
  in Settings now decides which calendar day an instant falls in, everywhere the
  application turns one into the other.

  UTC runs five or six hours ahead of this household, so anything after about six
  in the evening was already tomorrow. That was not a rounding difference; it was
  wrong figures on screen:

  - A charge at 8pm on the 31st was counted in the **next** month's utility
    average. The month it was made in came out short and the following one long,
    and the suggested per-paycheck amount drawn from the average was wrong in
    both directions.
  - The hourly price fetch filed every evening reading under **tomorrow**,
    leaving the day it was taken on with no close and settling one for a day that
    had not happened.
  - A price fetched minutes ago read **stale** all evening.
  - A balance typed in the evening recorded its valuation under tomorrow, so the
    day it was typed on still showed the old figure.
  - Year-to-date on New Year's Eve left out the evening it was looking at.

  **No migration, and no backfill.** The three columns this was expected to move
  were checked rather than assumed: `posted_at` already holds a true instant from
  the feed's own epoch, and `as_of` and `price_date` are `DATE` columns holding
  calendar days somebody decided — a decided day needs no zone. So nothing stored
  changes; what changed is the reading of an instant at the twelve places it
  becomes a day.

  One module, `calendar.ts`, now answers "which day is this" for the whole
  application, and it keeps the two ideas apart by name: an **instant** needs a
  zone to place in a day, a **date key** is a day already decided and needs none.
  Conflating them is the whole bug. Local day bounds are resolved by probing the
  offset rather than by arithmetic, because two mornings a year are 23 and 25
  hours long and a 24-hour window would drop an hour of transactions or count it
  twice — asserted directly, along with tiling a full year with no gap or overlap
  and round-tripping 365 days in four zones.

  Deliberately **not** given a zone: `revalueBitcoinHoldings`, which values a
  quantity and does not care whether the price is today's. Threading one through
  the six layers above it to compute a flag it discards is how a parameter
  eventually gets passed wrongly, so `latestPrice` (staleness, needs a zone) and
  `newestPrice` (the figure, does not) are now two functions that say which
  question they answer. Where a zone **is** needed it is a required argument, so
  a call site that forgets it fails the build instead of silently reverting to
  UTC.

  A deployment left on UTC is unaffected: every conversion is the identity there,
  and the tests assert it in both directions rather than only in the interesting
  zone. On any other zone, expect a utility average to shift by up to one bill
  once — that is the correction landing, not a regression.

- **The financial picture is recorded nightly.** Three tables — one row per
  account per day, one per delegation per day, and one for the whole picture —
  each keyed by a date and carrying its own provenance: `observed`,
  `reconstructed`, `carried` or `interpolated`. An aggregate takes the weakest
  provenance among its inputs, so one estimated account makes the day's total an
  estimate rather than hiding inside forty exact ones.

  [ADR 035](docs/decisions/035-the-financial-picture-is-snapshotted-nightly.md)
  **supersedes ADR 013**, which rejected exactly this in August. Its reason has
  expired — it was that snapshots would miss the twelve months of history about
  to be imported, and that import happened months ago — while the price it
  recorded and accepted has not: a reconstructed balance is a confident line
  drawn through transactions that can be quietly incomplete, and nothing about it
  says so.

  Two shape decisions are load-bearing. **The aggregates are stored rather than
  derived**, so archiving an account or changing an in-budget flag cannot rewrite
  a chart somebody has already read; each account row carries its own type and
  budget flags, and each delegation row its grouping, as they stood that night.
  And there are **two scopes**, because net worth includes the house and the
  mortgage while the identity is precisely the reading that excludes them —
  three totals could not have served both. `identity_value_cents` is the
  four-term figure from ADR 020, so it matches the chip on the Budget page rather
  than wandering by whatever is categorized and not yet posted.

- **The nightly job that writes them**, at 03:10 in the household's zone,
  labelling its rows for the **previous** day — a run at 03:10 on the 15th
  records the 14th, read as "end of day the 14th".

  03:10 for three reasons: off the hour so it does not contend with the hourly
  sync on two cores, _after_ the price fetch at :05 so yesterday's Bitcoin close
  is settled by the time a holding is valued against it, and outside 02:00–02:59
  — an hour that does not exist locally on the spring-forward morning, where a
  job scheduled inside it is skipped for the night.

  The date is calendar arithmetic on the local date, never 24 hours subtracted
  from an instant. Two mornings a year are not 24 hours long, and the difference
  is a row filed under the wrong day.

  **All three tables commit together or none do.** A partial day is worse than a
  missing day: the gap-filler can see a date with no rows and repair it, and
  cannot see a date whose accounts were written and whose aggregate was not.
  **An `observed` row is never overwritten** — not by a reconstruction, and not
  by a re-run — so pointing the manual trigger at any date repairs what is
  missing and revises nothing that was seen.

  A Bitcoin holding is valued at that date's close, with the quantity and the
  price stored beside it so the figure is explainable from the row alone. When
  the price had to be carried from an earlier day the row is `interpolated`
  rather than `observed`: the quantity was seen and the price was guessed, and
  the aggregate then inherits that.

- **Gap filling, for the days nobody was running for.** The NAS reboots,
  containers restart, power fails. On startup and again before each nightly run,
  every date between the newest snapshot and yesterday is rebuilt by the most
  accurate method available **per row**:

  **Delegations** replay the append-only ledger to the end of the day — exact
  however long the gap was, because the events are the truth and all of them are
  still there. **SimpleFIN accounts** take the next balance actually known and
  roll every posted transaction back out of it, through `accountBalanceDelta` so
  a debt's opposing sign is applied in the one place that knows about it.
  **Manual accounts** carry the last value entered on or before the date, because
  manual values change in steps and not slopes: property worth $400,000 until
  $420,000 was typed on the 16th was worth $400,000 on the 15th, not $410,000.
  **Bitcoin** reads the quantity held on that date from its own dated ledger,
  which is exact rather than carried, and only the price can be missing.
  **Interpolation** is the last resort, marked as an estimate and logged at
  warning level with the account and the date.

  **Nothing here is a backfill.** With no snapshot stored there is no gap — only
  history nobody chose to record — so a fresh deployment stays empty and history
  starts at the first run, exactly as decided.

  One transaction per day rather than one for the whole run: a fortnight of
  outage should not be all-or-nothing, and a day that fails should not discard
  the thirteen that succeeded.

- **A manual balance typed on Settings → Accounts is now a dated valuation.**
  `balance_as_of` is a single timestamp overwritten on every edit, so it could
  say when a value was last confirmed and never what the value was in March. Only
  properties had a history, because only they went through the valuations route —
  which left cash, River and Strike with no dated history at all, and the
  gap-filler with nothing to carry forward for them.

- **The eight core Insights tiles, drawn from the snapshots.** Net worth over
  time, assets against debts, account balance history, delegation balances,
  burn rate per cycle, identity drift, home equity and Bitcoin.

  **Every chart says where its figures came from.** A stretch built from
  estimated days is dashed and muted with the reason on hover; observed,
  reconstructed and carried days are all exact and draw normally. **And every
  chart ends on now** — a hollow marker past the stored history, because
  snapshots are labelled for the previous day and a line stopping there reads as
  stale rather than current.

  **The empty state is the state these ship in.** History starts at the first
  night, so a tile with nothing says "No history yet — the first night records
  one" and one with a single day says so too, rather than drawing an axis
  through a dot.

  `credit_card_trend` is retired. It was hardwired to whichever card owed the
  most; **account balance history** replaces it with a picker over every account
  that has stored history, which is what the tile was always reaching for. A
  layout still naming the old key is filtered against the catalogue rather than
  handing the page a widget it cannot draw.

  The delegation drill-down is three levels — every grouping, one grouping's
  delegations, one delegation — with a breadcrumb back up. The level survives a
  change of range, so widening from 30 days to a year widens the view you are
  looking at. Lines in no grouping are their own level and open like any other:
  a bucket somebody can see and cannot click into is a dead end.

- **The five derived tiles.** What net worth is made of (a stacked area of
  Bitcoin, other assets and debts, with debts below the baseline rather than
  stacked on top — stacking a debt on an asset would make the total read as their
  sum), change per pay cycle aligned to actual Delegate presses, 30-day momentum,
  delegation movers, and debt trajectory.

  Movers runs its bars from a centre line rather than from the left: the question
  is which direction a line moved as much as by how much, and a ranking drawing a
  $500 gain and a $500 drain identically would answer only half of it. Momentum
  says "Not a month of history yet" rather than flattening, because comparing
  against a month earlier needs a month.

  There is deliberately no cash-versus-savings split in the composition. The
  application has no such classification — an account is an asset or a debt — and
  inventing one from account names would be a guess presented as a category.

- **One range selector for the whole page**: 30 days, 90 days, 6 months, 1 year,
  year to date, this cycle, all. The spending and cycle tiles predate snapshots
  and `This cycle` is the only window that means anything to them, so one control
  drives everything rather than two disagreeing above a grid that mixes both.

- **`domain/history.ts` is gone**, as ADR 035 said it would be. The four tiles it
  fed are not — they are rebuilt on stored rows. Its ledger-walking survives only
  inside the gap-filler, where every row it writes is marked as derived. The
  properties its tests protected moved with it: a holding valued at each day's
  own quantity is asserted against the stored quantity and price now, rather than
  against a chart.

- **Read endpoints, returning series already shaped for a chart.** The browser is
  handed points it can draw rather than a year of rows to reduce on a phone.

  `GET /api/insights/snapshots?range=` serves everything that does not depend on
  a picker: the aggregate series, net worth composition, home equity, 30-day
  momentum, change per pay cycle, the debt trajectory, and the account list for
  the balance-history picker. `…/account/:id` serves one account.
  `…/delegations` serves the drill-down at whichever of its three levels was
  asked for — all groupings aggregated, one grouping's delegations, or one
  delegation.

  **Downsampling follows from the range, and the reader never chooses it.** Above
  roughly 180 stored days a series buckets to weekly and above 730 to monthly,
  taking the **average** of each bucket rather than its last day — a weekly point
  reporting Sunday's balance would swing with whichever day landed at the end,
  and a net worth line is not a sampling of Sundays. **A bucket takes the weakest
  provenance in it**, so a week containing one estimated day renders as
  estimated: a line drawn through a bucket is no better than its worst point.

  Every series carries a **live point** computed from current state and kept
  apart from the stored history. Snapshots are labelled for the previous day, so
  without it every chart would end a day behind and read as stale rather than
  current.

  Two things are deliberately withheld rather than guessed. **The payoff
  projection stays hidden until there are 60 days of history** — a line fitted
  through nine days would move by years every morning, and a number that unstable
  reads as a fact to whoever sees it. And **the composition split has no cash
  versus savings**: the application has no such classification, and inventing one
  from account names would be a guess presented as a category.

  Burn rate divides by the **configured pay cadence**, never a hardcoded 26. The
  Utilities page already divides by the same figure, and two screens of one
  household disagreeing about how often it is paid would be worse than either
  answer.

- **`GET /api/snapshots/status`**, and an administrator-only
  `POST /api/snapshots/run`. The status reading is the answer to "did the job
  run", taken from the rows rather than from the absence of an error — the
  lesson the nightly backup taught, which reported every failure correctly into
  a log nobody read while the question nobody asked was whether a dump was
  actually on disk. It reports the newest date, how many days are stored, the
  schedule and the zone it truly runs in, and goes stale after two days rather
  than one, because a run is for the previous day and a one-day threshold would
  warn every morning.

- **The schedule time zone is chosen in Settings**, not only in `.env`
  ([ADR 036](docs/decisions/036-the-schedule-timezone-is-a-setting.md)). Null
  means "follow `SCHEDULE_TIMEZONE`", which is what every existing deployment
  does and keeps doing until somebody picks a zone — so this changes when nothing
  fires. The environment variable stays as the floor, because the container has
  it before it can reach the database.

  **Saving rebuilds the schedules.** `node-cron` fixes a task's zone when the
  task is created, so a stored zone that only took effect on the next restart
  would be a setting that reports itself working and is not — which is the shape
  of failure this project has already paid for once, with a nightly backup that
  logged an error into a file nobody read while failing every night for weeks.
  It governs when jobs fire and nothing else; every date the domain computes is
  still UTC, and moving that is recorded as an open question rather than smuggled
  in here. **Superseded within this release by ADR 037, below** — the zone now
  also decides which day an instant falls in.

- **The zone is pickable on Settings → Budget.** The setting landed with an API
  and no interface, which left it changeable only by editing `.env` and
  restarting — the exact thing ADR 036 set out to remove. The picker offers what
  the server accepts rather than a list of its own, and its hint names the zone
  actually **in force**, which is the case that matters: nobody has chosen, and
  the answer is coming from the environment. A page showing only the choice would
  read blank on precisely the deployment whose zone nobody could otherwise find
  out.

### Fixed

- **A racy end-to-end test that failed about three runs in five.** "A pending
  charge is not offered as money to delegate" hovers the balance reading to check
  its working, then reloads and asserts no tooltip is open. A hover is physical
  pointer position rather than page state, so the cursor was still on the chip
  when the reloaded page painted and re-fired it — the assertion found the
  tooltip the test itself had left behind. Found while verifying unrelated work,
  confirmed at the same rate on `main`, and fixed by moving the pointer away
  before the reload rather than by relaxing the assertion.

- **A figure sits flush with the end of its row on a phone.** The 8px inside a
  money cell is the inset its hover background needs on a desktop; on a phone
  there is no hover, and with the `⋯` column collapsed the money column is the
  last thing in the row — so every figure stopped 8px short of the rule that ends
  it. The only ragged edge on the page, and it read as the table not reaching the
  screen. Section totals and row amounts now land on the same edge as the rules.

### Changed

- **On a touchscreen the row menu is a long press, and the `⋯` is gone.**
  `RowMenuShell` already wired a long press on the row itself, so the trigger was
  a second way into a menu that was already reachable — while costing a **40px
  column** on a 390px screen, on every table that has one.

  **Visually hidden, not removed.** A long press is not a gesture VoiceOver can
  perform, so the button keeps its place in the accessibility tree and loses only
  its pixels. `display: none` would have taken the same 40px back and stranded
  every row menu for anyone using a screen reader.

  Only the shell's own trigger. Settings → Groupings and Settings → Rules paint
  the same class on an Archive button and a pair of reorder arrows that have no
  long press behind them; hiding those would leave them unreachable by any means,
  which is the state that rule was written to fix once already.

- **A money box is the size of the money.** `w-full` made an inline editor as wide
  as its column — on a delegation row, most of the screen for eight characters of
  number. Inline editors are now `11ch`, which is `$999,999.99` with tabular
  numerals, and sit against the right edge where the figure they replace already
  was. Money fields in dialogs dropped from `full` to `sm` for the same reason: a
  figure is not open-ended content the way a name or a pasted token is.

  **Fixed, not growing with the content.** A box that resizes on every keystroke
  moves the caret and the rows beside it while somebody is typing.

### Fixed

- **Nothing runs off the side of a phone any more.** Measured across all sixteen
  screens at 390px, not eyeballed. A table of fixed columns came to 456px inside a
  326px card and drew `NAME` and `ROLE` on top of each other; the Insights window
  picker put 138px and its last option past the edge, unreachable; a 384px field
  overflowed its card because `max-w-full` sat on the control rather than the
  wrapper, where it resolved against a box the control had itself sized and so
  could never clamp anything.

- **A chip no longer wraps onto a line of its own**, which doubled the height of
  whichever Budget row it happened to and made a column of figures read as a
  ragged list. The name gives way now; the chip never does.

- **A phone shows a table's identity column, its money, and the row menu.**
  Everything else waits in that menu, which already carried it — the two account
  toggles, a person's role and status. Three fixed columns of secondary facts do
  not fit beside a name in 326px, and were not worth the name being unreadable.

- **No heading, cell, label or control takes a second line at 390px.** Copy that
  needed two was cut to fit one: the SimpleFIN and Accounts descriptions, the
  sync status, the backups schedule line, two node notes, and a field label
  carrying its unit — `Undo window (hours)` became `Undo window`, with the unit in
  the hint where it does not have to fit a 128px column.

- **The Transactions row leads with the control.** The delegation chip is the one
  thing you tap on a phone and it sat on the right, where a variable-width pill
  under right-aligned amounts made a ragged edge and moved sideways on every row.
  It starts in the same place every row now, with the date and account quiet
  after it.

- **A utility with nothing spent in the window draws no chart**, rather than 64px
  of empty box — which was the largest thing on the card and the part with
  nothing in it.

### Added

- **`e2e/phone.spec.ts` measures both rules on every route** — nothing past the
  edge that is not inside something built to scroll, and nothing that lines up in
  a column taking two lines. Every fault above was visible in a screenshot for
  weeks and none of them was noticed, so this is counted rather than looked at.

## [0.32.0] — 2026-08-26

### Added

- **Dark mode**, on Settings → Display beside row height: System, Light or Dark,
  remembered per device like every other display preference. System follows the
  device and keeps following it, rather than meaning whatever it said when the tab
  was opened.

  The palette is **rotated, not inverted** — the warm neutral greys get warm dark
  counterparts, so the application reads as itself with the lights off. Every
  accent is lifted, because the light values sit at 2–3:1 on a dark canvas and
  that is the usual way a dark mode ends up unreadable, and `color-scheme` is set
  so the browser draws checkboxes, selects and scrollbars dark too.

  The QR code on two-factor enrolment stays white in both themes. It is scanned
  rather than read.
  [ADR 034](docs/decisions/034-dark-mode-is-a-second-palette-not-an-inversion.md).

- **[docs/ui-system.md](docs/ui-system.md)** — the measurements every screen uses,
  and `ui-system.test.ts`, which enforces the mechanical half by reading the
  source. Five rules: the spacing scale, the page header, declared field widths,
  no bare `<details>`, and one verb for creating a thing.

### Changed

- **Every screen was reviewed and brought onto one system.** The look was right;
  the execution had drifted. The audit found four page-header implementations,
  five widths for the same kind of text input — 384px, 576px and 918px on three
  tabs of one page — spacing at every value from 1 to 8, three verbs for creating
  a thing (including **"Add grouping"** on Budget and **"New grouping"** in
  Settings, opening the same dialog), four ways of saying a list is empty, and two
  differently-built segmented controls on one page.

  What changed: a **four-value spacing scale** (4, 8, 16, 24) and nothing else; a
  **field width chosen by content** rather than inherited from a container;
  **`New <noun>`** at every create entry point and the bare verb on every dialog
  submit; and one `PageHeader`, `StatusLine`, `EmptyState`, `SegmentedControl` and
  `Disclosure` in place of between three and five implementations each.

  **Fewer words throughout.** One line of subtitle per page, one of description
  per card, one short hint per field, and empty states that say `No rules yet.`
  rather than explaining where to go instead — because the button that goes there
  is already a few pixels above the text.
  [ADR 033](docs/decisions/033-one-ui-system-with-a-test-that-holds-it.md).

- **Settings → Bitcoin and Settings → Properties no longer park a create-form in
  a card.** Both are a header button and a dialog now, which the settings-card
  convention already required. On a phone the old forms wrapped a checkbox onto
  its own line beside a field and pushed an input past the card's edge.

### Fixed

- **A field no longer runs off the edge of a phone card.** Every width now carries
  `max-w-full`.
- **The setup key wraps between groups, never inside one.** `break-all` split
  `XRXM` across two lines as `X` and `RXM`, which is the wrong place to break a
  string somebody is reading a character at a time.

## [0.31.0] — 2026-08-25

### Added

- **Two-factor enrolment offers the setup key, behind "Can't scan this?"** The QR
  code is still the first thing offered and is unchanged. What it could never
  serve is the case a household hits most: enrolling in a password manager on the
  machine already showing the screen, or on the phone that is holding it. There is
  no second camera to point at anything.

  The key was previously printed under the QR code permanently, as thirty-two
  unbroken characters with nothing to copy it — so the common case carried clutter
  and the uncommon case still meant transcribing it by hand or dragging a
  selection across it on a phone. It is now folded away behind a button, shown in
  groups of four, and has a Copy button.

  **What is copied is the key without the spaces.** The grouping is for the eye;
  a password manager handed `ABCD EFGH` may keep the space, and a second factor
  producing codes that match nothing is discovered at the worst possible moment.

  Nothing is newly exposed. The QR code encodes this exact secret, and anyone who
  can read the pixels can read the letters.

  **The Copy button works on a plain-http origin**, which is the interesting part.
  `navigator.clipboard` exists only in a secure context, and this application
  serves plain http at the origin by decision ([ADR 017](docs/decisions/017-plain-http-is-the-default-and-tls-is-optional.md))
  — encrypted from away by the tunnel or by Tor, plain on the LAN. A copy button
  written against that API alone would do nothing on the LAN address, which is the
  one used most, and would do it silently. It falls back to selecting the text and
  asking the document to copy it, and if even that is refused it leaves the key
  selected and names the keystroke. Three outcomes, none of them silence.

## [0.30.0] — 2026-08-25

### Added

- **Scheduled jobs run in a configured time zone.** `SCHEDULE_TIMEZONE` — an IANA
  name, defaulting to `UTC` — is the zone every cron expression is read in, so the
  nightly backup can run at half past two in the morning where the household
  actually lives rather than at half past nine the previous evening.

  It governs **when jobs fire and nothing else**. The process clock is untouched,
  deliberately: moving it would also move every date the domain computes, and
  which month a transaction lands in is not a preference. Applied to all three
  schedules rather than only the backup — the other two are hourly and land at the
  same instant in any zone, but passing it to one and not the others would leave a
  future reader working out which of three schedules meant local time.

  Abbreviations (`CST`) and fixed offsets (`-05:00`) are refused, because neither
  observes daylight saving: a job set for a civil hour against an offset drifts by
  an hour for half the year, and `CST` names two zones on two continents. An
  unknown zone silently falls back to the process default, so it fails at startup
  instead.

  Defaulting to `UTC` means an upgrade changes nothing until `.env` says otherwise.

- **A synced account now shows how old the feed's own answer is.** `balanceAsOf`
  was answering two questions at once: it holds the feed's `balance-date` when
  the feed sends one, and the time of our request when it does not — and
  afterwards those are the same value. So "the bridge says this is current" could
  not be told from "the bridge said nothing and we filled it in".

  `accounts.feed_balance_as_of` records only what the feed actually said, and is
  **null when it said nothing**. That third state is the whole point: unknown must
  not read as fresh. Settings → Accounts marks a synced balance more than two days
  old with the `s` chip and names the day it came from, so the question lands on
  the bridge rather than on this application.

  Found chasing ten charges that stayed marked pending for days after the card
  had posted them. Nothing about the pending lifecycle was wrong — the stored
  balance, the stuck rows and the card's real balance agreed to the cent, and all
  three were behind together while the bridge reported itself healthy. The
  application was right about everything it had been told and had no way to show
  that what it had been told was old.
  [ADR 032](docs/decisions/032-a-feed-date-is-kept-apart-from-the-one-we-stamp.md).

### Changed

- **The `s` chip reads "Balance may not be current"**, having read "Not confirmed
  recently" — wording written for a manual balance, and wrong for a synced one
  where there is nobody to do the confirming. The letter and its single meaning
  are unchanged; the wording was narrower than the meaning.

### Fixed

- **The Backups card describes this deployment rather than the defaults.** It read
  "nightly at 02:30 UTC, kept for 30 days" whatever `BACKUP_CRON`,
  `SCHEDULE_TIMEZONE` and `BACKUP_RETENTION_DAYS` were set to — a small version of
  the problem the card exists to solve, which is an interface asserting something
  nothing checks. It now reads all three, and says "daily" rather than "nightly",
  which stays true if the job is ever moved to the afternoon.

  **And it names the directory as the host knows it.** The card showed
  `/backups`, which is the path _inside the container_ and no use to somebody
  standing on the NAS looking for the file — which is exactly what a person
  chasing a missing dump is doing. Compose knows both halves of the bind mount
  and passes the host's name through as `BACKUP_HOST_DIR`; when nothing sets it
  the card shows the container path as before rather than inventing one.

## [0.29.2] — 2026-08-25

### Changed

- **A closed onion address now says nothing.** With remote access off it answered
  `403` and explained itself: that remote access exists, that it is switched off,
  and where to switch it on. To anyone holding the address — which is the only
  way to reach it — that confirmed a live service worth returning to. It is an
  empty `404` now, and "off" is indistinguishable from "nothing was ever here".

  **`/health` and `/api/auth/logout` are no longer exempt.** The health exemption
  was the louder of the two leaks: a `200` confirms a running service whatever the
  switch says. It existed so a health check would keep working, and bought
  nothing — Docker's own check runs inside the compose network and never carries
  an onion `Host`.

  The refusal is still logged on the server, where the household can read it and
  nobody else can. [ADR 027](docs/decisions/027-remote-access-is-an-onion-service.md).

### Fixed

- **The back link out of a settings section is named "Back to Settings".** On a
  phone the tab bar links to `/settings` too, so two links with the accessible
  name "Settings" sat on one screen — ambiguous to anyone navigating by name, and
  one of them is a back button. Found because a test that clicked by name failed
  intermittently.

- **The settings client no longer declares `requireTotp`.** The field was removed
  from the API when the second factor became unconditional; the web type still
  advertised it, so it read as a `boolean` the server never sends and offered it
  as something `update` would accept — which the strict schema refuses outright.

## [0.29.1] — 2026-08-25

### Fixed

- **Tor still never started, for a second reason.** v0.28.2 taught the entrypoint
  to resolve the app's address and substitute it into the configuration, and the
  deploy never shipped that entrypoint: `compose up -d` builds a service from
  source only when no image for it exists, and one did. The configuration is
  bind-mounted and updated; the script that reads it is baked into the image and
  did not. Tor received the placeholder verbatim, reported an unparseable port,
  and restarted for ever.

  `deploy.sh` passes `--build` now, so the one service built from source is
  rebuilt on every deploy. The entrypoint also refuses to start if the
  placeholder survives its own substitution, and says which two files disagree
  rather than leaving tor to complain about a port.

### Changed

- **`npm run verify` starts Tor rather than parsing its configuration.** The
  check that stood there ran `tor --verify-config` over a hand-substituted file,
  and passed on the very release whose container was crash-looping — it proved
  the file was valid, never that the entrypoint produced it. It now runs the real
  image against a container answering to `app`, exactly as compose arranges it,
  and asks tor whether it started.

## [0.29.0] — 2026-08-24

### Added

- **Delegate works on a phone.** It has never had a layout for one: the sidebar
  was a fixed 232px with no breakpoint — 59% of a 390px screen before a number
  was drawn — and there were seven breakpoint utilities in the whole application.

  - **A bottom tab bar** below `sm`, with the same five destinations and the same
    icons the sidebar carries. It **hides as you scroll down and returns as you
    scroll up**: the gesture for seeing more of a list gives the list more room,
    and the one for going back to the top brings navigation with it. It never
    hides in the first screenful, where there is nothing to reclaim.
  - **The register is a two-line card** on a phone rather than six columns.
    Description and amount on the first line, date and account on the second —
    and **categorizing is a chip, not a field**, opening the picker in a bottom
    sheet with the matches at a size a thumb can hit. A full-width text box on
    every row read as sixty things waiting to be typed into, and nobody types
    into it on a phone.
  - **Settings is an index list**, because about four of thirteen tabs fit.
    Tapping a section replaces it, and a back link returns. Tabs are unchanged
    above `sm`, where every destination fits at once.
  - **Dialogs are bottom sheets** below `sm`, anchored to the edge a thumb
    reaches rather than centred wherever their own height lands them.
  - **The Budget header keeps Delegate** and folds the other four actions into a
    sheet. Five buttons cannot sit in a row at 390px, and Delegate is the one
    with a moment attached.

- **Sync now on Settings → Sync, and Sign out on Settings → Users.** Both existed
  only in the sidebar, so the page named after the connection could report on it
  and not run it — a gap regardless of screen width.

### Fixed

- **Controls hidden behind hover are reachable on a touchscreen.** Every row
  menu, the absorb button, a grouping's Archive and a rule's reorder arrows were
  `opacity: 0` until hovered, and a phone cannot hover. Touch-and-hold was wired
  on two pages and nowhere else, which left several of them unreachable by any
  means at all. They are drawn where `(hover: none)` matches.

- **The absorb button no longer covers the name it sits beside.** It is hung out
  of flow in the gutter left of the Remaining column — over space the name is not
  using at 1200px, and directly on top of it at 390px. It is a pointer control
  now, and the same action is offered in the row menu, which has room for the
  words.

- **Touch targets are 44px** where there is no hover, which is the figure both
  platforms publish. The controls keep their size; the target grows around them.

## [0.28.2] — 2026-08-24

### Fixed

- **Tor has never started, and now does.** `torrc` carried
  `HiddenServicePort 80 app:3000`. Tor does no name resolution for that
  directive, so a compose hostname is a parse error — the container died before
  starting, restarted for ever, and no hidden service was ever created. The only
  symptom anywhere was Settings saying "No onion address yet", which is also what
  it says when nothing is wrong.

  The entrypoint now resolves the app's address before tor starts and writes it
  into a runtime configuration. Confirmed by running the service locally against
  a stub: it bootstraps, creates the hidden service, and reports the address.

- **The app could not have read the address even once tor worked.** It mounted
  the key volume and read `/tor/delegate/hostname` — a directory tor keeps at
  0700 and owns, necessarily, because the private key is in it. The app runs as a
  different unprivileged user, so every read failed with `EACCES`, and the catch
  around it returned `null`, which renders identically to "no service yet".

  The address is republished to a volume of its own, world-readable, and the app
  no longer mounts the key volume at all — **less** access to the key than
  before, not more. A v3 onion address is a public key; the thing worth guarding
  is the secret beside it.

  `readOnionAddress` now stays quiet only for a missing file. Anything else is
  logged as the misconfiguration it is.

- **The troubleshooting instructions on that page did not work.** They said
  `sudo docker compose logs tor` with no directory, which answers "no
  configuration file provided" from anywhere but the deploy folder, and
  `sudo docker` on DSM answers "command not found" because sudo resolves the
  binary itself against a path without `/usr/local/bin`. The page now gives the
  whole command.

### Added

- **`npm run verify` checks the Tor configuration**, with `tor --verify-config`
  against the real file. Offline, about a second, and it would have caught the
  above before it ever left the Mac.

## [0.28.1] — 2026-08-24

### Fixed

- **The nightly backup has never once run, and now does.** `deploy.sh` creates
  the backup directory under `sudo`, so it was owned by root; the container runs
  as the unprivileged `node` user, uid 1000. Every nightly `pg_dump` since
  go-live failed with `Permission denied`. The Dockerfile's `chown` of
  `/backups` did nothing about it — a bind mount replaces the image's directory
  wholesale, and the host's ownership is what the process meets.

  `deploy.sh` now chowns the directory to uid 1000, and — because a bind-mount
  permission problem cannot be caught in the image or in `npm run verify` —
  **proves the container can write there** before reporting a successful deploy.

### Added

- **Settings → Sync shows the backups.** The newest dump, how many are kept, the
  directory they land in, and the last five with their sizes. A dump missing its
  checksum sidecar reads as `incomplete` rather than as a backup, because that is
  what `backup.sh` leaves behind when a run dies partway.

- **A red banner when no backup has landed in 48 hours**, or when none ever has.
  This is the part that matters: the dump failed every night for weeks, was
  logged at error level every time, and nothing anywhere read the log. The check
  asks **whether a dump has landed**, not whether the last attempt threw — those
  differ exactly where it counts, and only one of them was answerable from
  inside the application.

## [0.28.0] — 2026-08-24

### Changed

- **Settings is quieter, denser, and consistent tab to tab.** Every list obeys
  Settings → Display like the rest of the app, and every "add" is a button in the
  card's top right opening a dialog, rather than a form permanently open below
  the list it adds to.

  - **Sync** — the connection is a line with a dot, not a full-width green bar
    that shouted on the days nothing was wrong. Once connected, the setup-token
    field goes away behind **Set up new token**, beside **Disconnect**: a token
    is claimed once and spent, and an empty box asking to be filled reads as
    unfinished work. Recent syncs now say what each run actually did — "12
    imported, 3 updated", or "nothing new", which is the ordinary result on an
    hourly schedule and should not read as a fault.
  - **Accounts** — **Rename is offered on manual accounts only.** A SimpleFIN
    account is called whatever the institution calls it, and the next sync would
    not restore a name typed over it — it would leave the two disagreeing with
    nothing on the page saying they ever matched. **Short name is now Nickname**,
    which is the supported way to call an account something else. The "Also
    counted" footer is gone, and **Add a manual account** is a header button and
    a dialog.
  - **Delegations** — one 32px row per envelope, reading like the Budget page's
    own table. Opening one gives a single line of controls — name, grouping,
    utility, amount — with the note on a second line, instead of a stack of
    labelled fields three hundred pixels tall.
  - **Groupings** — a table, with the palette behind the current swatch instead
    of seven controls open on every row for a choice made once and left for
    months. The trigger names the colour it holds, so the choice is never carried
    by colour alone. **New grouping** is a header button and a dialog.
  - **Rules** — a list laid out like the register: order, rule, what it
    categorizes as, what narrows it, and whether it is on. **Add rule** and **Run
    rules** are header buttons. Apply-to-existing was a permanently open panel
    running a preview query on every visit, with the toggle that changes what the
    button does sitting some distance from the button; it is a confirmation now,
    and the preview is fetched when it opens.
  - **Budget** — three settings on one screen without scrolling.
  - **Users** — row actions are behind the `⋯` menu. A row could carry Edit,
    Reset password, Reset two-factor and Archive at once: four controls of equal
    weight, one destructive, on every row of a table read far more often than it
    is acted on.

- **Two-factor moved from Security to Users**, where it sits beside the account
  it protects rather than beside a network setting. `/set-up-two-factor` renders
  the same card, so there is still exactly one enrolment flow.

- **Security is now Tor**, carrying remote access and nothing else. The old
  `/settings/security` redirects.

### Removed

- **Reconcile to Actual.** It existed for a single moment in a household's life —
  turning a twelve-month backfill into day-one balances — and that moment has
  passed. Correcting drift now happens where the drift is visible: **Manually
  adjust** on a Budget row, or Settings → Delegations. Both write the same
  `adjust` event the screen wrote.

  **No data is removed.** Every event a reconciliation wrote is untouched: they
  are ordinary manual adjustments and always were. `go_live_at` keeps the date it
  holds, because on a live deployment that is a real fact about the household,
  and migrations here are forward-only. Nothing reads it now, so the Go-live card
  in Settings → Budget went with the screen.

  [ADR 031](docs/decisions/031-reconcile-to-actual-is-removed.md).

## [0.27.0] — 2026-08-24

### Changed

- **Every chip is one letter.** The marks beside a row's name were words —
  `Pending`, `income`, `manual`, `utility`, `needs review`, `stale` — and at
  eleven pixels a word costs a row's width while saying no more than its initial
  does once the initial is known. The register and the budget are the two places
  where width is scarcest, and they carried the most of them.

  `p` pending (still yellow), `i` income, `t` transfer, `m` kept by hand,
  `s` stale, `r` needs review, `u` utility. Two rules keep a vocabulary of
  letters legible and both are enforced rather than promised: **one letter, one
  meaning across the whole application** — a unit test fails if two chips ever
  share a mark — and **the word is always there**, as real text for a screen
  reader and as a `title` for anyone who hovers.

  A mark never repeats what the row already says. The register printed "Split
  across 2: Grocery, Household"; `sp` says the first three words in two
  characters, so the row reads `Costco Run  sp  Grocery, Household` and the
  merchant name keeps the width those words were spending.

### Added

- **Five new marks**, for things the interface knew and never said:
  - **`c`** — this payment settled an outstanding check. `clearCheck` allocates
    to the delegation the check was drawn on and archives the check line, which
    is right and left nothing on the row saying a check was involved. The
    transaction remembers the check it settled now. Null on everything that
    predates the column: which payment settled which check cannot be
    reconstructed afterwards, and guessing from amounts and dates is the loose
    matching [ADR 030](docs/decisions/030-a-cleared-check-is-confirmed-not-assumed.md)
    exists to avoid, so older rows simply carry no mark.
  - **`btc`** and **`h`** — a Bitcoin holding and a property, on the budget.
    Neither figure is a bank balance: a holding is a quantity times a price and
    is revalued daily with no transaction behind it, and a property is a dated
    valuation. Both read as ordinary balances until something says otherwise.
    `h` for house, because `p` is spent on pending.
  - **`sp`** — split across more than one delegation.
  - **`n`** — this delegation has a note. Previously only visible by opening the
    row menu.
  - **`s`** now appears on the **budget** as well as in Settings, which is where
    you read the number it is warning you about.

## [0.26.0] — 2026-08-24

### Changed

- **A check the bank has cashed is now confirmed, never settled unasked.** A sync
  used to clear an outstanding check by itself the moment a payment matched its
  exact amount and named its number. The criteria were strict and as far as
  anyone can tell never settled the wrong check — the problem was that settling
  one moves money between envelopes and archives a line, and it happened at three
  in the morning with a log entry as its only trace.

  A sync now **proposes**, and a person settles. It is surfaced twice: a **purple
  banner** at the top of every page naming the checks, and a **Confirm it
  cleared** button on the check's own row, beside its Remaining figure. The row
  button is always visible rather than shown on hover, because a state nobody can
  see until they hover the right row is one the banner points at in vain.

  The confirmation shows both sides in full — what you wrote, and what the bank
  took — because the point of asking is that you can disagree. There is no reject
  button: a proposal is recomputed from the data rather than remembered, so it
  would only come back. Declining is categorizing the payment as whatever it
  actually was, which the dialog says.

  The matching criteria are unchanged and deliberately still strict. A proposal
  shown as "this cleared" is one somebody confirms without reading, so a loose
  proposal is barely safer than a loose auto-match. A check whose bank text never
  named it still goes through the manual path on the Transactions page.

  [ADR 030](docs/decisions/030-a-cleared-check-is-confirmed-not-assumed.md).

- **The balance reading is a chip beside the title, not a bar across the page.**
  It read as a full-width bar with the state on the left and the equation on the
  right. The equation is the reason to trust the figure, but it is not read twice
  a day, and a bar's worth of page for it pushed the budget itself down the
  screen — roughly 200px of it.

  It now sits immediately right of **Budget**, baseline-aligned with the controls
  across the header, saying only `Balanced`, `To delegate $1,000.00` or
  `Over delegated $212.00` — state first, then the figure. Hovering it shows the
  full equation, and so does tabbing to it: the justification for the number has
  to be reachable without a mouse. It is not a button and does not pretend to be
  one; there is nothing to press.

  The three labels now live in `formatIdentityLabel` in `@budget/shared`, which
  already existed and produced exactly these strings while the Budget page built
  its own copy and never called it. There was one wording in two places and
  nothing keeping them in step; there is one now.

### Added

- **Purple, as a fourth banner colour**, for something the application has
  worked out and will not act on until somebody says so. Blue, yellow and red
  were already "here is a fact", "this needs attention" and "this is wrong", and
  a proposal is none of those. `#6B3FA0` on `#F4ECFB` is 6.41:1, in line with
  danger rather than scraping the 4.5 floor.

## [0.25.0] — 2026-08-23

### Changed

- **Settings → Accounts is one line per account.** A row was 77px — a name, a
  short-name box under it whether or not it held anything, a bordered dropdown
  for a field with two values, two switches each with their own written label,
  and a red Archive button. Ten rows came to 738px. The same accounts now take
  289px.

  The list is split into **Assets** and **Debts**, alphabetical within each, and
  the section name sits in the first column heading rather than in a title row of
  its own. That split removes the Type column outright: the section a row is in
  _is_ its type.

  What stays on the row is what the page exists for — the two switches, one click
  each, under a heading that names them once instead of sixteen times — and the
  balance, still click-to-edit on a manual account. Everything read far more often
  than it is changed moved into the `⋯` menu the Budget page has always had:
  Rename, **Short name**, Set balance, Type, and Archive. Settings and the Budget
  row menu are now the same menu, which is what §9.5 asked for.

  Ordering follows the name on screen rather than the one in the column. The API
  sorts by `name`, which used to be the black text here; now the short name reads
  first, and sorting by the grey text underneath would have put "Frontier
  Checking" above "Frontier Bank Little Pioneer Savings" — its real name begins
  "Big Deal Cash Back".

  The source chip is shown on **manual** accounts only. Eight identical
  `simplefin` chips said nothing; a manual account is the one whose balance is
  yours to type and which can go stale.

  Row height follows Settings → Display like every other table, so compact,
  comfortable and dense give 32, 40 and 28px here too.

- **Bitcoin and property are no longer rows on that page.** They are one line
  under the tables — `Also counted: …` — with each name linking to the tab that
  owns it. Amends [ADR 021](docs/decisions/021-bitcoin-and-property-are-managed-where-they-live.md),
  which put them there so the page could not become "a lie about what the budget
  is made of"; that reasoning holds, and now costs 30px rather than two full rows.

### Fixed

- **A net-worth-only Bitcoin holding no longer reads `$0.00`.** `balance_cents`
  is written for in-budget holdings only and cleared when one leaves the budget,
  so `0` there means the absence of a figure, not a balance of zero. The old
  "Manage in Bitcoin" row printed it as `$0.00` next to a wallet worth six
  figures. A figure now appears only where it is maintained.

- **Archive reads as destructive again in every row menu.** It was written as
  `ITEM_CLASS text-danger`, and those two colour utilities have equal
  specificity — so which won came down to the order Tailwind emitted them in,
  and it was `text-ink`. The one destructive item in the menu looked like all the
  others. There is a `DANGER_ITEM_CLASS` now that cannot lose that race.

## [0.24.0] — 2026-08-22

### Added

- **Close the budget's reading against one line, from the line itself.** Hover a
  delegation while the reading is not zero and a button appears: **Move surplus
  here** when money has landed and is not in an envelope, **Fix deficit from
  here** when the envelopes hold more than exists.

  Three choices either way — all of it, bring the line to zero (or empty it into
  the shortfall), or an amount you type. A choice that would be refused is shown
  disabled **with the reason**, because the reason is usually the thing worth
  knowing: "This line holds $50.00, which is not enough."

  The dialog opens on the first choice that can actually be applied, which
  matters most in exactly the case somebody opens it for.

  It is the same `adjust` event a manual adjustment has always written, with the
  amount computed instead of typed — so history, undo and the ledger check all
  work on it already. The difference is **recomputed on the server** when the
  request lands: "all of it" has to mean all of it then, not whatever the page
  was showing before the hourly sync.

## [0.23.0] — 2026-08-22

### Added

- **Archive, on a transaction's row menu.** The API has always supported it and
  the interface never offered it, so taking a row out of the register meant a
  database prompt. The case it exists for arrived on its own: a re-linked
  institution re-imports transactions that are already there.

  Archive, never Delete — nothing here is hard-deleted. Archiving reverses any
  envelope movement the transaction caused, and backs a **manual** row's amount
  out of the account balance; a synced account's balance comes from the feed and
  is left alone.

## [0.22.1] — 2026-08-22

### Fixed

- **An institution reconnected at the bridge broke syncing permanently.**
  Deleting a connection at SimpleFIN and adding it back gives every one of its
  accounts a new external id. Delegate matches on that id, so they arrived
  looking new — and creating one failed on the partial unique index over
  `lower(name)`, because the original was still there under the same name. The
  collision then recurred every hour, forever. Such an account is adopted now:
  same row, same register, same type and nickname, new id.
- **One account's failure stopped every other institution syncing.** Anything
  thrown while ingesting an account escaped and failed the whole run, so a
  household with six connections lost all six balances because one had been
  reconnected. Per-account failures are reported on the run and skipped, which
  is how a foreign-currency account has always been handled.

## [0.22.0] — 2026-08-20

### Changed

- **The Delegate button becomes Undo Delegation** while the run can still be
  undone, in red, and goes back to Delegate when the window closes. One slot,
  because while a run is still undoable there is nothing sensible to delegate —
  offering both would be offering the wrong one first.
- **What was delegated is said beside the cycle date** rather than in a bar of
  its own, and it disappears with the offer. The cycle date stays: the cycle did
  not end when the chance to undo it did.

### Fixed

- **The undo offer never expired.** `previewUndoLatestDelegate` computed the
  expiry and handed the run back regardless, so the interface kept offering an
  undo that `undoDelegateRun` would refuse with `undo_window_expired`. The money
  was never at risk — that refusal is real and always was — but a button that
  cannot do what it says is worse than no button.

## [0.21.0] — 2026-08-19

### Added

- **Delegations can be put in an order**, and it is stored on the budget rather
  than in a browser — the same for everyone who signs in. Alphabetical was the
  only order this application had, which is why a household ends up naming its
  groupings "3 - Food" and "5 - Home": numbering by hand to buy back an ordering
  the software would not give them.
- **Drop a row onto another row** to put it in that row's place, in that row's
  grouping. Dropping onto a grouping still sends it to the end, as before.
- **Move up** and **Move down** in the row menu, beside the existing Move to
  grouping. Dragging is the fast route and it is not a keyboard one, so this is
  not a lesser alternative — it is the one that always works, including under a
  thumb.

Positions are backfilled to the order the budget already showed, so nothing
moves on upgrade.

## [0.20.0] — 2026-08-19

Interface work asked for by the owner, and a second factor that is no longer
optional.

### Added

- **Display names.** The username is an email address and reads as one wherever
  it appears. A name is not a credential and nothing is looked up by it, so
  anybody can set their own whatever role they hold — `PATCH /api/auth/me` sits
  outside user management for that reason.
- **Resetting somebody's second factor**, for an administrator. The way back
  when the phone is gone and the recovery codes went with it. Sign-in demands
  the second factor whenever one is confirmed, so before this the only route was
  a database prompt.
- **Add transaction on the Budget page**, beside Add grouping.

### Changed

- **A second factor is required of every account, always**, including the first
  Super Admin. The `requireTotp` setting is gone with its toggle. It never did
  what its name suggested: sign-in demanded the second factor whenever one was
  confirmed whatever it said, so it could not rescue a locked-out account, and
  its only real effect was to permit accounts with none at all.
- **Settings → Users is a table**, with creating and editing in a dialog. It was
  a permanent form at the bottom of the page and inline fields on every row,
  which made the common case — reading who has an account — the hardest thing on
  the screen.
- **The Transactions register opens unfiltered**, and its columns are stated
  rather than left to the browser. A bank description is unbounded and took 728
  of 1112 pixels, leaving the delegation picker 87.
- **Transfer mirrors the Budget page**: grouped dropdowns in the same order, each
  option carrying the balance it holds.
- **To delegate lines up with Assets and Debts.** A single `pr-3` those cells do
  not carry had it 12 pixels out.
- **New outstanding check** is **New check**.
- Less prose on Utilities and Insights, and **Add from catalog** is a button in
  the header rather than a dashed tile at the end of the grid.

### Fixed

- `PATCH /api/settings` refused unknown fields rather than stripping them. A
  request still carrying `requireTotp` answered 200 with the field discarded —
  which reads to the caller as having turned two-factor off, successfully.

## [0.19.0] — 2026-08-19

The budget no longer assumes the household is paid every two weeks.

### Added

- **Pay cadence**, on Settings → Budget: weekly (52 a year), every two weeks
  (26), twice a month (24), or monthly (12). The count is part of each label
  because "biweekly" is genuinely ambiguous in English, and picking the wrong
  one would put the suggestion out by a factor of four with nothing on screen to
  reveal it.
- **Twice a month covers both patterns.** The 1st-and-15th and the
  15th-and-last-day are the same 24 payments a year, and naming it by a pair of
  dates would make half the households it fits think it did not.

### Changed

- `suggestedPerCycleCents` takes the number of cycles rather than assuming 26.
  Still integer throughout and still rounded half away from zero; the doubling
  in the new form is what keeps that exact for an odd divisor as well as an even
  one.
- The Utilities page names the divisor it actually used, and the server sends it
  alongside the figures rather than leaving the interface to look it up — a page
  saying "over 26" beside a number computed from 24 is worse than either alone.
- Two comments that described biweekly pay as though the code depended on it.
  One of them, on `partial` in the cycle summaries, had never matched what the
  code did.

### Unchanged, deliberately

- **Nothing runs on a schedule.** A cycle is still one Delegate press to the
  next, pressed by hand when the money lands. The cadence is a divisor, not a
  timetable.
- **No amount to delegate is rewritten.** Those are applied once per press, so
  changing cadence changes what they come to over a year. That is the
  household's decision and the interface says so rather than acting on it.
- **An existing budget reads identically after the upgrade.** The column
  defaults to `biweekly`, which is what the arithmetic assumed before it was a
  setting.

## [0.17.0] — 2026-08-19

Model Context Protocol support, added in 0.15.0 and 0.16.0, is removed at the
owner's direction. Settings → Connections, the API token model, the connector
bundle and the `apps/mcp` workspace are all gone, along with their
documentation and ADRs 030 and 031.

The two fixes found while that work was being done are **kept**. Neither had
anything to do with it beyond being noticed at the same time.

### Removed

- API tokens, the token scope allowlist, Settings → Connections, the
  `apps/mcp` server and the Claude Desktop connector bundle.
- `api_tokens` is dropped by a new migration rather than by deleting the one
  that created it. Migrations are forward-only (ADR 003) and the deployment had
  already applied it; removing the file would leave `migrate deploy` reporting
  drift. Dropping rather than archiving is right here for once — the rows were
  credentials, not a record of anything the household did.

### Fixed

- **A flag in a query string is text, not a truthy value.**
  `z.coerce.boolean()` is `Boolean(value)`, and `Boolean("false")` is `true`, so
  `GET /api/transactions?uncategorized=false` returned the uncategorized queue —
  the Transactions page's Categorized filter had been showing the wrong list.
  `pending` and `includeArchived` had the same fault, on transactions and on
  accounts. The parse now lives in `http/serialize.ts` as `booleanQuery`.
- **`.dockerignore` was anchored at the root**, so
  `packages/shared/tsconfig.tsbuildinfo` was copied into the build context. A
  stale one is a lie `tsc --build` believes: it concludes the project is already
  built, emits nothing, and every workspace importing `@budget/shared` then
  fails to resolve it. Only ever visible locally — the NAS builds from a
  `git archive` tarball, which carries no ignored file at all.

### Changed

- **The container image step starts the image** and asks it for `/health`.
  Building alone was half of what the step's name claimed, and a container that
  builds and then exits on boot is a failure this project has had twice.

## [0.3.0-phase3] — 2026-08-10

Phase 3 as re-scoped, plus outstanding checks and the first pass of Phase 4.
Passkeys were dropped from the plan and Cloudflare Access deferred, both
recorded rather than quietly skipped.

### Added

- **Two-factor authentication.** TOTP with ten recovery codes, and a
  household-wide requirement that refuses to turn on while any active account
  would be locked out by it. The secret is stored encrypted and the recovery
  codes as argon2id hashes, for the same reason the SimpleFIN credential is: the
  nightly `pg_dump` is the copy most likely to leave the device. The
  second-factor step uses a signed challenge rather than a half-authenticated
  session — [ADR 014](docs/decisions/014-the-second-factor-step-uses-a-signed-challenge-not-a-session.md).
- **Rate limiting** on every route that verifies a credential, and security
  headers via helmet with a same-origin content security policy.
- **CSRF protection** as an origin check on every state-changing request, on top
  of the `SameSite=Lax` cookie — [ADR 015](docs/decisions/015-csrf-is-an-origin-check-not-a-token.md).
- **Session rotation on role change.** The guards already re-read the role every
  request, but the session id itself was minted under different privileges.
- **Optional TLS**, terminated by the application, with plain http as the
  documented default for a trusted LAN — [ADR 017](docs/decisions/017-plain-http-is-the-default-and-tls-is-optional.md).
  `scripts/make-tls-cert.sh` generates a certificate with the right subject
  alternative names, including bare IP addresses.
- **Cloudflare Tunnel support.** `TRUST_PROXY` makes the sign-in rate limit count
  the real client rather than `cloudflared` — without it the whole internet
  shares one bucket. Opt-in, because trusting an unvetted `X-Forwarded-For` does
  not weaken the limit, it removes it —
  [ADR 018](docs/decisions/018-a-proxy-is-trusted-only-when-configured.md).
- **Outstanding checks.** A check written and not yet cashed is modelled as a
  delegation, so the budget identity holds through its whole life. Matched to the
  payment that cashes it by exact amount _and_ check number as a whole token;
  what cannot be resolved automatically is matched by hand. The spending lands on
  the delegation the check was drawn on, never on the check line.
- **Dependency audit in CI**, failing on a high or critical advisory in anything
  that ships. Policy and update process in [docs/dependencies.md](docs/dependencies.md).
- **Phase 4, first pass:** a row-height setting (40px, or 32px compact), the
  budget showing one amount at a time on a phone with a swipe between them, and
  `j`/`k` plus arrow-key navigation of the transaction queue.
- **A per-row menu on Transactions**, holding Split and Match to a check. One way
  in per device: hover, keyboard focus, or touch and hold.

### Fixed

- **Signing out could be undone by a request already in flight.** The session row
  was deleted, then a poll that had been running since before the logout re-saved
  its session — sessions are rolling — and the upsert re-created the row. Signed
  out everywhere visible, still signed in as far as the cookie was concerned,
  about one time in three.
- **Sign-out left the browser rendering the budget.** The server destroyed the
  session; the client kept drawing from a cache that was never emptied.
- **The container could not read its own TLS key.** It runs as uid 1000, and a
  key generated by whoever ran the script is mode 600 and owned by them. Caught
  by CI on the first run of the TLS smoke test.
- **Compose silently ignored `TRUSTED_ORIGINS`, `AUTH_RATE_LIMIT_*` and
  `BITCOIN_PRICE_*`.** They were never passed through, so setting them in `.env`
  did nothing.

### Changed

- **Passkeys are out of scope** — [ADR 016](docs/decisions/016-passkeys-are-out-of-scope.md).
  TOTP covers the stolen-password threat; what passkeys add is phishing
  resistance, which is narrow for a two-person application with no public URL to
  impersonate. The trade is recorded: Delegate remains phishable.
- **Cloudflare Access deferred** to a future request. Without it the sign-in page
  will be on the public internet once the tunnel is up, and the rate limit, the
  second factor and argon2id are what stand in its place.

## [0.2.0-phase2] — 2026-08-09

Phase 2: everything §12 asks for, built and tested. The pages that need
categorized history are correct but sparse until go-live fills them.

### Added

- **Bitcoin** held as a quantity in satoshis, valued at the price on the date
  being shown. Hourly fetch from CoinGecko with Coinbase as a fallback, both
  keyless, behind a `PriceProvider` interface. A daily close is cached so the net
  worth chart uses the price that actually applied on each date.
- Closes settle on the following day's fetch rather than at midnight, so a
  container stopped overnight leaves no permanent hole in the chart.
- **Property values** recorded against an as-of date and kept as history, with
  equity computed on read from a linked mortgage. Manual entry only — §8 rules
  out Zillow — behind a `ValuationProvider` interface.
- **In-app notification banners**: a failing sync, balances nobody has confirmed
  lately, accounts a sync guessed the type of, the uncategorized backlog, and a
  stale Bitcoin price. Computed on read and not dismissible.
- **Grouping colours** from a curated palette, enforced server-side, expressed as
  a soft tint that keeps near-black text above 10:1 contrast.
- **Dragging a delegation between groupings**, as an addition to the row menu
  rather than a replacement — dragging is not a keyboard route.
- **The Utilities page**: twelve months per utility, the monthly average, the
  suggested per-cycle amount, and what the line is actually funded at.
- **The Insights page** and all twelve catalog widgets, with the chosen layout
  persisted per user.
- **Balance history reconstructed from the ledger** rather than stored, so the
  time-series widgets cover history that arrived before the feature existed. See
  [ADR 013](docs/decisions/013-historical-balances-are-reconstructed-from-the-ledger.md).
- **Transaction pairing**: §7's heuristic exactly, suggested and confirmed, never
  applied silently. Confirming clears any categorization, since a transfer
  allocates to nothing.
- An account's type can be corrected from Settings → Accounts and from the row
  menu — the API always accepted it and no screen offered it.
- Container images published to GHCR from `main` and version tags, signed through
  Sigstore, and deployed **by digest with the signature verified before start**.
  See [ADR 012](docs/decisions/012-images-are-deployed-by-digest-with-verified-provenance.md).
- `scripts/deploy.sh`: one SSH command that resolves a tag to a digest, verifies
  it, pins it, and waits for the health endpoint.
- 110 further tests, and end-to-end coverage of every page added.

### Fixed

- `GET /api/rules/preview` read its `includeCategorized` flag with `Boolean()`,
  and `Boolean("false")` is `true` — so asking for the safe preview returned the
  count for the mode that overwrites categorizations made by hand.
- Reconcile never stamped the go-live date: the domain accepted one and the route
  never passed it.
- `npm run typecheck` did not cover the web application at all.
- Equity over time zipped two series positionally when each is truncated at its
  own earliest history, subtracting a mortgage balance from the wrong date.
- Unpairing did not refresh the suggestion list, so a reversed pair did not
  reappear until a reload.
- The container image was built by CI and never published, while the Compose file
  pointed at it. The first deploy would have failed at the pull.
- `actions/attest-build-provenance` cannot run on a user-owned private
  repository; images are signed directly through Sigstore instead.
- The README told the owner to authenticate to `ghcr.io` with a fine-grained
  token. GitHub Packages only supports a classic one, and `docker login` fails
  with `denied: denied`.
- Several end-to-end tests raced a write and passed only on a fast machine.

## [0.1.0-phase1] — 2026-08-09

Phase 1: everything needed to stop using the spreadsheet, on the LAN.

### Added

- Repository scaffold: npm workspaces, TypeScript project references, type-aware
  ESLint, Prettier, Vitest with separate unit and integration projects, and CI.
- `@budget/shared`: integer-cent money primitives (parsing, formatting, even and
  weighted distribution, JSON serialization), the budget identity and its
  labelling, and the domain vocabulary shared with the UI.
- PostgreSQL schema covering accounts, groupings, delegations, the delegation
  event ledger, delegate runs, envelope transfers, transactions and allocations,
  auto-categorization rules, users and sessions, sync runs, valuations, Bitcoin
  price history and settings.
- Hand-written integrity migration: case-insensitive partial unique indexes on
  live names, and check constraints the database enforces itself.
- Domain services: the event ledger with transactional cached balances, Delegate
  with preview and 12-hour undo, envelope transfers, manual adjustment,
  categorization and splits, pending reconciliation and reversal, archiving rules,
  and go-live reconciliation.
- `recompute-balances` CLI, with a read-only `--check` mode used by CI.
- 116 tests, including integration tests against a real PostgreSQL asserting the
  identity behaves correctly after delegate, undo, transfer, adjust, categorize,
  split, pending appearing, pending vanishing and archiving.
- Documentation: architecture, eight ADRs, phase-gated open questions.
- CI check rejecting the forbidden terminology for the Bitcoin asset class.
- Fastify application: validated environment configuration, structured logging
  with a correlation id per request and redaction of credentials, a domain-to-HTTP
  error mapping, a health check, and graceful shutdown on SIGTERM.
- Authentication: argon2id password hashing, PostgreSQL-backed sessions, first-run
  Super Admin creation, login and logout, forced password change on first login,
  and session id rotation on login and password change.
- User management for Admins: create, rename, change role, reset password,
  archive and restore, with Super Admin immunity enforced in the domain layer.
- 43 further integration tests covering session fixation, user enumeration, the
  temporary-password lockout, Super Admin immunity, and session revocation on
  archive and password reset.
- SimpleFIN sync: hourly `node-cron` job and a manual sync endpoint, 12-month
  backfill on first run, idempotent re-runs keyed on the feed's transaction id,
  automatic discovery of new accounts flagged for review, and the full pending
  lifecycle — settling under the same or a new id, and reversal when a pending
  transaction vanishes.
- `simplefin:claim` CLI, exchanging a one-time setup token for the access URL.
- Sync run history with counts and errors, exposed at `/api/sync/status` to drive
  a persistent failure banner.
- Protocol parsing that accepts both SimpleFIN protocol versions, rejects
  sub-cent precision rather than rounding it, and refuses non-USD accounts with a
  visible reason.
- 34 further tests covering idempotency, the pending lifecycle, the request
  window, and the guarantee that the access URL never leaves the server.
- Auto-categorization rules: matching on description (contains, starts-with,
  regular expression), amount range, account and direction; priority ordering
  with first match winning; applied automatically to transactions a sync
  imports; reorder, enable, archive, and "always categorize like this" from a
  transaction.
- Apply-to-existing bulk action with a read-only preview, which is what makes
  categorizing months of backlog before go-live reconciliation tractable.
- 28 further tests covering ordering, the refusal to overwrite a categorization
  made by hand, regular-expression safety, and cache-versus-ledger agreement
  after a bulk apply.
- Transactions API with search across description, account, delegation and
  amount; filters for date, account, delegation, kind, uncategorized and pending;
  splits with exact amounts or an even division; and bulk categorize.
- Budget API: the read model with groupings and totals, inline creation and
  editing, and Delegate with preview and 12-hour undo, Transfer, manual
  adjustment and Reconcile to Actual.
- The web application: app shell with a collapsible sidebar, authentication
  screens, first-run Super Admin creation, and the design tokens from
  `docs/design.md`.
- The Budget page — three sections, inline creation, click-to-edit money
  cells, the identity banner, Delegate with its confirmation and undo bar, and
  Transfer.
- The Transactions page: the uncategorized queue, a keyboard-driven delegation
  type-ahead, search, filters and bulk categorize.
- SimpleFIN connection from Settings, with the access URL encrypted at rest
  (AES-256-GCM) and taking precedence over the environment variable.
- Manual transaction entry, and a split editor that shows the remainder as
  amounts are typed and refuses to save until the parts sum to the whole.
- `GET /api/accounts`, since the Budget page read model deliberately carries only
  in-budget accounts and a manual transaction may belong to an off-budget one.
- The per-row menu on the Budget page: rename, the utility toggle, a note,
  manual adjustment, per-line history, move to grouping, and archive. A blocked
  archive offers Adjust and Transfer inline.
- Per-delegation history — the only place `adjust` events are ever visible,
  since the transaction journal exists for categorization rather than auditing.
- Inline grouping creation on the Budget page.
- Settings, one section per page: Sync, Accounts, Delegations, Groupings, Rules,
  Budget, Users, Reconcile and Archived.
- **Reconcile to Actual** — every delegation with its computed balance and an
  editable actual, committed in one batch. A line left blank is not touched, so
  it can be done in several sittings. The first commit is recorded as the go-live
  date.
- Settings → Budget: the identity tolerance and the undo window, both bounded,
  with the derived warning and danger thresholds stated on screen.
- Account management: create a manual account, edit it, and archive or restore
  it. A balance is editable only on a manual account, and an in-budget account
  holding money refuses to archive.
- The asset and debt row menu, sharing its mechanics with the delegation menu.
- Settings → Archived, backed by a new `GET /api/archived`.
- Settings → Rules with reordering, and apply-to-existing behind its preview.
- Settings → Users: create, change role, reset password, archive and restore,
  mirroring the server's Super Admin immunity rather than reimplementing it.
- Container images published to GHCR from `main` and version tags, with SLSA
  build provenance attested through Sigstore.
- `scripts/deploy.sh` — one SSH command that resolves a tag to a digest, verifies
  its provenance, pins it, and waits for the health endpoint.
- 70 end-to-end tests in a real browser covering the budget, transactions, manual
  entry and splits, both row menus, reconciliation, accounts, settings and rules.

### Fixed

- Backfill requests are split into 45-day windows. The bridge silently caps a
  longer range and reports it as a note rather than an error, so a twelve-month
  request returned three months while appearing to succeed — measured against
  real accounts, 275 transactions instead of 423.
- Account type is guessed from the institution and account name together. A real
  feed returns institution "Discover Credit Card" with account name "A Person
  (7169)", and reading the account name alone classified a credit card as an
  asset, which adds to the budget identity instead of subtracting from it.
- The Prisma CLI could not find the repository-root `.env`, so `npm run db:deploy`
  failed on a clean machine.
- `npm run simplefin:claim` failed with `ERR_MODULE_NOT_FOUND` and could never
  have run.
- The SimpleFIN response schema defaulted `accounts` to an empty array, so
  unrelated JSON parsed as zero accounts and recorded a successful sync.
- Integration test files ran concurrently against one database despite
  `fileParallelism: false`, which is a root-level Vitest option and is ignored
  inside a project. Replaced with a single fork for that project.
- A missing hashed asset returned `index.html` with a 200 and `text/html`,
  producing a blank page and a MIME error that pointed nowhere near the cause.
  End-to-end tests now assert content type rather than status.
- `GET /api/rules/preview` read its `includeCategorized` flag with `Boolean()`,
  and `Boolean("false")` is `true` — so asking for the safe preview returned the
  count for the mode that overwrites categorizations made by hand. That number is
  read immediately before deciding whether to rewrite a year of history.
- Reconcile never stamped the go-live date: the domain accepted one and the route
  never passed it, so `budget_settings.go_live_at` could not be set by any path
  through the application.
- `npm run typecheck` did not cover the web application at all — the root
  TypeScript project referenced only `packages/shared` and `apps/api`, so type
  errors in `apps/web` surfaced only at build time. Adding it found two real
  ones, including a query function receiving TanStack Query's context object as
  its first argument.
- A `<label>` wrapping its textarea took its accessible text from everything it
  contained, so a filled-in note field could no longer be found by its own label.
  Replaced with a `TextArea` primitive wiring label and control by `htmlFor`.
- Two end-to-end tests fired a mutation and immediately navigated away, so the
  next page rendered mid-write and the assertion then polled a static DOM. They
  passed for months and failed only on a slow first run after a cold start.
- The container image was built by CI and never published, while the Compose file
  pointed at `ghcr.io/aso42244/delegate:latest`. The documented first deploy
  would have failed at the pull.
