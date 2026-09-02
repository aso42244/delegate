-- What a person says about a detected bill.
--
-- [ADR 045](../../../../docs/decisions/045-a-bill-is-inferred-not-entered.md) says
-- bills are stored nowhere, and that stays true: this table holds no bills. It
-- holds the household's corrections to what the detection concluded, which is a
-- different kind of fact and the only kind that cannot be derived.
--
-- The first real run made the case. A thrift shop visited every fortnight was
-- listed as a fortnightly bill — the detection cannot know it is a shop, and no
-- threshold would tell it, because the shape of the spending is genuinely that
-- of a bill. A heuristic that cannot be corrected is one somebody stops reading.
--
-- Keyed by the merchant key rather than by a transaction: it is the *merchant*
-- that is not a bill, and the charges it is inferred from change every month.
-- If a feed reworded a description enough to move it to a new key the correction
-- would stop applying and the row would come back — visible, recoverable, and
-- preferable to keying on something that changes more often.
CREATE TABLE "bill_overrides" (
  "id"           UUID PRIMARY KEY,
  "merchant_key" TEXT NOT NULL,

  -- What it was called when the correction was made. Only so the list of
  -- hidden bills can name them: a hidden merchant has no detected bill to take
  -- a name from, by definition.
  "label" TEXT NOT NULL,

  -- Taken off the list. Never a deleted row: putting one back flips this, and
  -- the record of having hidden it survives either way.
  "hidden" BOOLEAN NOT NULL DEFAULT false,

  -- A name to show instead of the bank's. Null keeps the feed's description,
  -- which is what every row starts with.
  "display_name" TEXT,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

-- One correction per merchant. The upsert that writes it depends on this.
CREATE UNIQUE INDEX "bill_overrides_merchant_key_key" ON "bill_overrides" ("merchant_key");

-- A row that hides nothing and renames nothing is a row with nothing to say.
-- It cannot be written by the domain, and this stops one arriving another way.
ALTER TABLE "bill_overrides"
  ADD CONSTRAINT "bill_overrides_says_something" CHECK (
    "hidden" = true OR "display_name" IS NOT NULL
  );
