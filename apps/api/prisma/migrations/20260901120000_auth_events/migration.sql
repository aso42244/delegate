-- A record of what happened to credentials, and a screen that shows it.
--
-- Carried open since the August review and declined twice, for a reason worth
-- keeping: **a table nobody queries is worse than no table**, because it looks
-- like a control while nothing reads it. That is the nightly-backup trap, which
-- this project has already paid for once — the failure was recorded correctly,
-- into a log nothing read, for weeks.
--
-- So this ships with the screen, not before it. Settings → Users shows the most
-- recent events without being asked, the way the backup card shows the newest
-- dump. If the screen were ever removed, this table should go with it.
--
-- Purely additive: one new table, one new type. Nothing existing is altered.

-- ---------------------------------------------------------------------------
-- What is worth recording
-- ---------------------------------------------------------------------------
--
-- Credentials only. Not "who looked at the budget" — everybody in this household
-- sees the whole budget by design, so a read is not an event, and recording one
-- per page view would bury the twelve lines a year that matter.
--
-- An enum rather than free text: a typo'd kind is a row that no screen and no
-- query will ever find, which is the same failure as not writing it at all.
CREATE TYPE "auth_event_kind" AS ENUM (
  'signed_in',            -- a completed sign-in, both factors
  'sign_in_failed',       -- the password was refused
  'second_factor_failed', -- the password was accepted and the code was not
  'signed_out',
  'password_changed',     -- by the account itself
  'password_reset',       -- by an administrator; actor_id is who
  'two_factor_enrolled',
  'two_factor_disabled',  -- by the account itself, with its password
  'two_factor_reset',     -- by an administrator; actor_id is who
  'account_created',
  'account_archived',
  'account_restored'
);

CREATE TABLE "auth_events" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "kind"        "auth_event_kind" NOT NULL,

  -- Who it was about.
  --
  -- `subject` is always present and is what the screen reads: a username when it
  -- names a real account, and a short keyed digest (`unknown:xxxxxxxx`) when it
  -- does not. A failed sign-in is the reason for that rule — the login form has
  -- two fields, and a password typed into the top one must never be written
  -- down. A name that matches no account is quite often exactly that.
  "subject"     TEXT NOT NULL,

  -- Set when the account is known, and kept ON DELETE SET NULL rather than
  -- CASCADE: an audit row outliving the account it describes is the point.
  -- Nothing hard-deletes a user anyway (they archive), so this is a guard
  -- against a future that has not happened yet.
  "user_id"     UUID,

  -- Who *did* it, when that is somebody else — an administrator resetting a
  -- password or a second factor. Null when the subject acted on themselves.
  "actor_id"    UUID,

  -- The address the request came from, as the server resolved it, which means
  -- it already honours TRUST_PROXY. Null when there is none to record.
  --
  -- Text rather than INET: over Tor this is the loopback address of the SOCKS
  -- hop and means nothing, and a column typed as an address invites somebody to
  -- do arithmetic on a value that is sometimes a fiction.
  "ip"          TEXT,

  CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "auth_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- The screen reads the newest first and nothing else reads this at all.
CREATE INDEX "auth_events_occurred_at_idx" ON "auth_events" ("occurred_at" DESC);

-- ---------------------------------------------------------------------------
-- Why this one is pruned, when nothing else here is
-- ---------------------------------------------------------------------------
--
-- "Nothing is ever hard-deleted" is a rule about the household's *data* —
-- accounts, transactions, delegations — where an archived row stays resolvable
-- so an old transaction still renders `Grocery (archived)`. This is not that. It
-- is an operational log, and it is the one table in this schema an
-- **unauthenticated** stranger can cause writes to: every refused sign-in is a
-- row. The rate limit caps that at ten per five minutes per address, which is
-- slow enough not to matter and fast enough to be unbounded over a year.
--
-- Rows older than the retention window are deleted at sign-in, on the same
-- sweep that removes expired sessions. See `pruneAuthEvents`.
