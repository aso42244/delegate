-- "These are not a pair", remembered.
--
-- The same defect `duplicate_dismissals` was created for, in the sibling
-- feature, found the same way: by somebody pressing the button and watching the
-- suggestion come back on the next page load.
--
-- "Not a pair" was React state — a Set in the component, discarded on reload.
-- So a wrong transfer suggestion returned for ever, because the two transactions
-- it is about are settled and nothing about them will ever change.
--
-- `docs/handoff.md` wrote the rule down after the duplicates version of this:
-- before treating a refusal as not worth keeping, check whether the thing being
-- proposed about can expire on its own. A cleared check's proposal can — the
-- check clears and the offer stops. Two settled transactions cannot. So the
-- refusal has to be storable, and this is that store.
--
-- Keyed on the pair rather than on a row, for the reason duplicates are: saying
-- "these two are not each other" must leave both free to be proposed against
-- anything else. A current account with two $200 movements in one week has one
-- correct pairing and one wrong one, and refusing the wrong one must not hide
-- the right one.
CREATE TABLE "pair_dismissals" (
  "id" UUID PRIMARY KEY,

  -- Canonically ordered by id, so one pair is one row whichever way the
  -- detector read it. The domain sorts before writing; the check constraint is
  -- what makes that true of every row rather than of the rows one function
  -- happened to write.
  "first_transaction_id"  UUID NOT NULL REFERENCES "transactions" ("id") ON DELETE CASCADE,
  "second_transaction_id" UUID NOT NULL REFERENCES "transactions" ("id") ON DELETE CASCADE,

  "dismissed_by" UUID REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pair_dismissals_ordered" CHECK (
    "first_transaction_id" < "second_transaction_id"
  )
);

-- One dismissal per pair. The upsert that writes it depends on this.
CREATE UNIQUE INDEX "pair_dismissals_pair_key"
  ON "pair_dismissals" ("first_transaction_id", "second_transaction_id");
