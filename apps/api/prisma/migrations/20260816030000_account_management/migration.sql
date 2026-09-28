-- Who owns an account's lifecycle.
--
-- A Bitcoin holding and a property stay ordinary rows in `accounts` — the
-- identity, the budget read model and the net worth chart all read that table.
-- What moves is who creates and retires them: their own Settings tab, rather
-- than Settings → Accounts by hand.

CREATE TYPE "account_management" AS ENUM ('none', 'bitcoin', 'property');

ALTER TABLE "accounts"
  ADD COLUMN "managed_as" "account_management" NOT NULL DEFAULT 'none',
  ADD COLUMN "bitcoin_revalued_at" TIMESTAMP(3);

-- Backfill from what each row already demonstrates about itself. A holding is
-- an account carrying satoshis; a property is one with a recorded valuation.
UPDATE "accounts" SET "managed_as" = 'bitcoin' WHERE "bitcoin_sats" IS NOT NULL;

UPDATE "accounts" SET "managed_as" = 'property'
WHERE "managed_as" = 'none'
  AND "id" IN (SELECT DISTINCT "account_id" FROM "account_valuations");

-- A property is also an account something else points a mortgage at, even if
-- nobody has valued it yet.
UPDATE "accounts" SET "managed_as" = 'property'
WHERE "managed_as" = 'none'
  AND "mortgage_account_id" IS NOT NULL;

CREATE INDEX "accounts_managed_as_idx" ON "accounts"("managed_as");

-- Shown once rather than on every toggle. A warning repeated every time is one
-- nobody reads.
ALTER TABLE "budget_settings"
  ADD COLUMN "bitcoin_in_budget_ack_at" TIMESTAMP(3);
