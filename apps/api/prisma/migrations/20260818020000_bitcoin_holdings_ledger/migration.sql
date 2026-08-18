-- Bitcoin holdings become a dated ledger.
--
-- The quantity was one number on the account, so the net worth chart applied
-- today's quantity to every past date — it said so in a comment, for want of
-- anywhere to read history from. This is that history.
--
-- Same shape as delegation_events: append-only, reversal by stamping rather
-- than deleting, with the cached sum on `accounts.bitcoin_sats` that
-- recompute-balances can rebuild and check.

CREATE TYPE "bitcoin_event_type" AS ENUM (
  'opening', 'purchase', 'sale', 'transfer_in', 'transfer_out', 'adjustment'
);

CREATE TABLE "bitcoin_holding_events" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id"  UUID NOT NULL,
  -- The date the quantity changed, not the date it was typed in.
  "occurred_at" DATE NOT NULL,
  -- Signed: negative for a sale or a transfer out.
  "delta_sats"  BIGINT NOT NULL,
  "event_type"  "bitcoin_event_type" NOT NULL,
  -- What one whole Bitcoin cost, in cents, at the time. Null where it does not
  -- apply: a transfer between your own wallets buys nothing, and inventing a
  -- price there would invent a gain.
  "price_cents" BIGINT,
  "note"        TEXT,
  "actor_id"    UUID,
  "reversed_at" TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bitcoin_holding_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bitcoin_holding_events_account_id_occurred_at_idx"
  ON "bitcoin_holding_events"("account_id", "occurred_at");
CREATE INDEX "bitcoin_holding_events_reversed_at_idx"
  ON "bitcoin_holding_events"("reversed_at");

ALTER TABLE "bitcoin_holding_events"
  ADD CONSTRAINT "bitcoin_holding_events_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bitcoin_holding_events"
  ADD CONSTRAINT "bitcoin_holding_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every holding that already exists gets an opening event for what it holds, so
-- the cache and the ledger agree from the first moment the ledger exists. Dated
-- from when the balance was last confirmed: that is the most recent moment the
-- quantity is known to have been right, and claiming an earlier one would put
-- Bitcoin on the chart before it was held.
INSERT INTO "bitcoin_holding_events"
  ("account_id", "occurred_at", "delta_sats", "event_type", "note")
SELECT
  "id",
  COALESCE("balance_as_of", "created_at")::date,
  "bitcoin_sats",
  'opening',
  'Opening balance, from before holdings were dated.'
FROM "accounts"
WHERE "bitcoin_sats" IS NOT NULL AND "bitcoin_sats" <> 0;
