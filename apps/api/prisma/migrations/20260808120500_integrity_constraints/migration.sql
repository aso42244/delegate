-- Constraints Prisma's schema language cannot express, plus the settings row.
--
-- These live in a hand-written migration on purpose. They are the difference
-- between "the application tries not to write bad data" and "the database will
-- not accept bad data" — the second is the one that survives a bug in a service
-- layer, a CLI command, or a manual psql session at 1am.

-- ---------------------------------------------------------------------------
-- Case-insensitive name uniqueness, among live rows only.
--
-- Archiving must not permanently reserve a name: the owner may archive "Car
-- Insurance" and legitimately create it again next year. A plain UNIQUE would
-- forbid that, so these are partial indexes on archived_at IS NULL. They are
-- also lower()-based, because "Grocery" and "grocery" as two separate envelopes
-- is a data-entry mistake every time, not a feature.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX groupings_section_name_live_key
  ON groupings (section, lower(name))
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX delegations_name_live_key
  ON delegations (lower(name))
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX accounts_name_live_key
  ON accounts (lower(name))
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

-- A property cannot be secured against itself.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_mortgage_not_self
  CHECK (mortgage_account_id IS NULL OR mortgage_account_id <> id);

-- Bitcoin is a quantity of satoshis. A negative holding is not a thing.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_bitcoin_sats_non_negative
  CHECK (bitcoin_sats IS NULL OR bitcoin_sats >= 0);

-- Null means "never goes stale". Zero or negative would mean "always stale",
-- which is a misconfiguration rather than an intent.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_staleness_interval_positive
  CHECK (staleness_interval_days IS NULL OR staleness_interval_days > 0);

-- A SimpleFIN account without the id we sync it by is unreachable; a manual
-- account has no external id at all. Both directions are enforced.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_external_id_matches_source
  CHECK (
    (source = 'manual' AND external_id IS NULL)
    OR (source = 'simplefin' AND external_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Envelope transfers
-- ---------------------------------------------------------------------------

-- Direction is carried by the two delegation references, so the amount is a
-- magnitude. A signed amount here would make the direction ambiguous.
ALTER TABLE delegation_transfers
  ADD CONSTRAINT delegation_transfers_amount_positive
  CHECK (amount_cents > 0);

ALTER TABLE delegation_transfers
  ADD CONSTRAINT delegation_transfers_distinct_lines
  CHECK (from_delegation_id <> to_delegation_id);

-- ---------------------------------------------------------------------------
-- Allocations
-- ---------------------------------------------------------------------------

-- A zero-amount allocation moves nothing and only serves to make a transaction
-- look categorized when it is not.
ALTER TABLE transaction_allocations
  ADD CONSTRAINT transaction_allocations_amount_non_zero
  CHECK (amount_cents <> 0);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

ALTER TABLE categorization_rules
  ADD CONSTRAINT categorization_rules_priority_non_negative
  CHECK (priority >= 0);

ALTER TABLE categorization_rules
  ADD CONSTRAINT categorization_rules_amount_range_ordered
  CHECK (
    amount_min_cents IS NULL
    OR amount_max_cents IS NULL
    OR amount_min_cents <= amount_max_cents
  );

ALTER TABLE categorization_rules
  ADD CONSTRAINT categorization_rules_match_value_not_blank
  CHECK (length(btrim(match_value)) > 0);

-- ---------------------------------------------------------------------------
-- Delegate runs
-- ---------------------------------------------------------------------------

ALTER TABLE delegate_runs
  ADD CONSTRAINT delegate_runs_line_count_non_negative
  CHECK (line_count >= 0);

-- ---------------------------------------------------------------------------
-- Bitcoin prices
-- ---------------------------------------------------------------------------

-- A zero or negative price means the feed returned garbage. Better to reject the
-- row and hold the last known price than to persist a value that would render a
-- Bitcoin holding as worthless.
ALTER TABLE bitcoin_prices
  ADD CONSTRAINT bitcoin_prices_price_positive
  CHECK (price_cents > 0);

-- ---------------------------------------------------------------------------
-- Settings singleton
-- ---------------------------------------------------------------------------

ALTER TABLE budget_settings
  ADD CONSTRAINT budget_settings_single_row
  CHECK (id = 1);

ALTER TABLE budget_settings
  ADD CONSTRAINT budget_settings_undo_window_non_negative
  CHECK (undo_window_hours >= 0);

ALTER TABLE budget_settings
  ADD CONSTRAINT budget_settings_tolerance_non_negative
  CHECK (identity_tolerance_cents >= 0);

-- Seed the one row every environment needs. Defaults match the spec: a 12 hour
-- undo window and a $5.00 identity tolerance.
INSERT INTO budget_settings (id, undo_window_hours, identity_tolerance_cents, updated_at)
VALUES (1, 12, 500, now())
ON CONFLICT (id) DO NOTHING;
