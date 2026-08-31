-- The financial picture, recorded nightly.
--
-- The delegation ledger gives envelopes a full history. Account balances and net
-- worth never had one: only current state exists, so Insights could show today
-- and never a trend, and every day that passed without capturing state was a day
-- of history permanently lost.
--
-- ADR 035 supersedes ADR 013, which decided the opposite in August for a reason
-- that has since expired — that snapshots "begin the day the feature ships,
-- useless for the twelve months of history the owner is about to import". The
-- import happened months ago, and the cost ADR 013 recorded and accepted ("a gap
-- in the transactions becomes a wrong balance, silently") is exactly what a
-- stored observation fixes.
--
-- Purely additive. Three new tables, one new type, one new nullable column on a
-- single-row settings table. Nothing existing is altered, dropped or rewritten,
-- so this is safe to run against a database with live data in it.

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
--
-- Per row, never per day. A single date can legitimately mix reconstructed
-- delegations with interpolated accounts, and collapsing that to one flag per
-- day would report the whole picture as an estimate because one account was.
--
-- Declared strongest first. The domain's `weakestProvenance` depends on that
-- order: an aggregate is only as good as the weakest row that fed it.
CREATE TYPE "snapshot_provenance" AS ENUM (
  'observed',       -- captured live by the nightly job
  'reconstructed',  -- derived exactly from a ledger or from posted transactions
  'carried',        -- a manual value carried forward from the last human entry
  'interpolated'    -- a last-resort estimate; no exact derivation was possible
);

-- ---------------------------------------------------------------------------
-- One row per account per day
-- ---------------------------------------------------------------------------
CREATE TABLE "account_snapshots" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_date" DATE NOT NULL,
  "account_id"    UUID NOT NULL,

  -- Positive magnitude, exactly as accounts.balance_cents is: a $500 card debt
  -- is 50000 here too, and the aggregate subtracts it.
  --
  -- For a Bitcoin holding this is the market value on that date, quantity times
  -- price — not the account's balance_cents, which is zero unless the holding is
  -- in-budget and would otherwise report a real holding as worth nothing.
  "balance_cents" BIGINT NOT NULL,

  "provenance"    "snapshot_provenance" NOT NULL,

  -- The classification as it stood that night, not as it stands now. Reading
  -- these from the account at query time would let re-typing a card as an asset,
  -- or taking the house out of net worth, silently rewrite a year of charts.
  "account_type"  "account_type" NOT NULL,
  "in_budget"     BOOLEAN NOT NULL,
  "in_net_worth"  BOOLEAN NOT NULL,

  -- Bitcoin only, null on every other account. Persisted so the market value on
  -- that date is explainable from the row itself and never has to be re-derived
  -- from two ledgers and a price table.
  "quantity_sats" BIGINT,
  "price_cents"   BIGINT,

  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "account_snapshots_pkey" PRIMARY KEY ("id")
);

-- Idempotency: the nightly job upserts on this, so a re-run for a date that
-- already has rows cannot duplicate them. It also serves the range scan — every
-- account between two dates reads it left to right.
CREATE UNIQUE INDEX "account_snapshots_snapshot_date_account_id_key"
  ON "account_snapshots"("snapshot_date", "account_id");

-- The other direction: one account, scanned across dates. What the account
-- picker on the balance-history widget actually asks for.
CREATE INDEX "account_snapshots_account_id_snapshot_date_idx"
  ON "account_snapshots"("account_id", "snapshot_date");

ALTER TABLE "account_snapshots"
  ADD CONSTRAINT "account_snapshots_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One row per delegation per day
-- ---------------------------------------------------------------------------
CREATE TABLE "delegation_snapshots" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_date" DATE NOT NULL,
  "delegation_id" UUID NOT NULL,
  "balance_cents" BIGINT NOT NULL,
  "provenance"    "snapshot_provenance" NOT NULL,

  -- Which grouping this delegation sat in that night. Captured rather than
  -- joined, for the same reason the account classification above is: the
  -- drill-down aggregates one series per grouping, and reading membership live
  -- would mean moving Grocery from "3 - Food" to "5 - Home" retroactively moved
  -- a year of its history with it.
  "grouping_id"   UUID,

  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "delegation_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delegation_snapshots_snapshot_date_delegation_id_key"
  ON "delegation_snapshots"("snapshot_date", "delegation_id");

CREATE INDEX "delegation_snapshots_delegation_id_snapshot_date_idx"
  ON "delegation_snapshots"("delegation_id", "snapshot_date");

-- The default view of the drill-down: every delegation of one grouping, across a
-- date range, aggregated.
CREATE INDEX "delegation_snapshots_grouping_id_snapshot_date_idx"
  ON "delegation_snapshots"("grouping_id", "snapshot_date");

ALTER TABLE "delegation_snapshots"
  ADD CONSTRAINT "delegation_snapshots_delegation_id_fkey"
  FOREIGN KEY ("delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delegation_snapshots"
  ADD CONSTRAINT "delegation_snapshots_grouping_id_fkey"
  FOREIGN KEY ("grouping_id") REFERENCES "groupings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One row per day: the whole picture
-- ---------------------------------------------------------------------------
--
-- Stored rather than recomputed from the two tables above. The point is that the
-- chart reflects what the application actually showed on that date — after an
-- account is archived, after a holding is retired, after the in-budget
-- classification changes. A total recomputed from today's classification is a
-- different number wearing the same date.
--
-- Two scopes, because the application has two and they answer different
-- questions. Three totals could not serve both: net worth includes the house and
-- the mortgage, and the identity is precisely the reading that excludes them.
CREATE TABLE "aggregate_snapshots" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_date" DATE NOT NULL,

  -- Net worth scope: every account marked in_net_worth, house and mortgage
  -- included. Debts are positive magnitudes, so net worth is assets − debts.
  "net_worth_assets_cents" BIGINT NOT NULL,
  "net_worth_debts_cents"  BIGINT NOT NULL,
  "net_worth_cents"        BIGINT NOT NULL,

  -- Budget scope: in_budget only, which is what the identity reads.
  "budget_assets_cents"     BIGINT NOT NULL,
  "budget_debts_cents"      BIGINT NOT NULL,
  "total_delegations_cents" BIGINT NOT NULL,

  -- The fourth term of the identity: categorized pending transactions the
  -- account balances do not carry yet. Its own column rather than folded into
  -- the identity alone, so the row explains itself and the amount in flight is
  -- answerable on its own. See ADR 020.
  "pending_categorized_cents" BIGINT NOT NULL,

  -- budget_assets − budget_debts − delegations + pending_categorized. The same
  -- four-term figure as the chip beside the Budget page title. Omitting the
  -- pending term would make this wander by whatever is categorized and not yet
  -- posted, and that wander would read as miscategorisation when it is only the
  -- settlement lag.
  "identity_value_cents" BIGINT NOT NULL,

  -- The weakest provenance among every row that fed this day. An aggregate built
  -- from one interpolated account is an interpolated aggregate, whatever the
  -- other forty rows were.
  "provenance" "snapshot_provenance" NOT NULL,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "aggregate_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "aggregate_snapshots_snapshot_date_key"
  ON "aggregate_snapshots"("snapshot_date");

-- ---------------------------------------------------------------------------
-- The schedule timezone becomes a setting
-- ---------------------------------------------------------------------------
--
-- Nullable, and null on the existing row. Null means "whatever SCHEDULE_TIMEZONE
-- says", which is how every existing deployment behaves and keeps behaving until
-- somebody picks a zone in Settings — so this migration changes when nothing
-- fires.
--
-- The environment variable stays the floor rather than being migrated away: it
-- is what the container has before it can reach the database, and a first boot
-- against an empty schema still has to know when to run.
--
-- It governs when jobs fire and nothing else. The process clock is untouched,
-- because moving it would move every date the domain computes.
ALTER TABLE "budget_settings"
  ADD COLUMN "schedule_timezone" TEXT;
