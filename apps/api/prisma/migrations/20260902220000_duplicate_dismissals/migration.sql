-- "This is not a duplicate", remembered.
--
-- [ADR 049](../../../../docs/decisions/049-a-duplicate-is-proposed-never-archived.md)
-- had the panel propose and never act, and dismissal was deliberately not
-- stored — following [ADR 030](../../../../docs/decisions/030-a-cleared-check-is-proposed-never-cleared.md),
-- which argues that a refusal is not a fact worth keeping.
--
-- The first real run showed where that reasoning does not reach. Two genuinely
-- different payees, both $60.00, two days apart, were read as one charge twice.
-- Pressing "not a duplicate" cleared it until the next page load, and then it
-- came back — for ever, because nothing about those two rows will ever change.
-- A proposal that cannot be refused permanently is one somebody stops reading,
-- which is the same lesson `bill_overrides` learned about the thrift shop.
--
-- The difference from a cleared check is that a check's proposal expires by
-- itself: the check clears, or the payment is categorized, and the pairing stops
-- being offered. Two settled transactions are permanent, so the proposal about
-- them is permanent too, and refusing it has to be as well.
--
-- Keyed on the pair, not on a row. Saying "these two are not each other" leaves
-- both rows free to be proposed against anything else — which matters when a
-- charge really was imported three times and only one of the pairings is wrong.
CREATE TABLE "duplicate_dismissals" (
  "id" UUID PRIMARY KEY,

  -- Canonically ordered by id so that one pair has one row, whichever way round
  -- the detector happened to read them. The domain sorts before it writes; the
  -- check constraint is what makes that true of every row rather than of the
  -- rows one function wrote.
  "first_transaction_id"  UUID NOT NULL REFERENCES "transactions" ("id") ON DELETE CASCADE,
  "second_transaction_id" UUID NOT NULL REFERENCES "transactions" ("id") ON DELETE CASCADE,

  -- Who said so, and when. Not for an audit — for the case where somebody finds
  -- a duplicate by hand, wonders why it was never offered, and needs an answer.
  "dismissed_by" UUID REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "duplicate_dismissals_ordered" CHECK (
    "first_transaction_id" < "second_transaction_id"
  )
);

-- One dismissal per pair. The upsert that writes it depends on this.
CREATE UNIQUE INDEX "duplicate_dismissals_pair_key"
  ON "duplicate_dismissals" ("first_transaction_id", "second_transaction_id");
