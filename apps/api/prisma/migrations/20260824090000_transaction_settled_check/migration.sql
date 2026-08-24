-- A transaction that settled an outstanding check remembers which one.
--
-- `clearCheck` allocates the payment to the delegation the check was drawn on —
-- never to the check line, because money spent on piano lessons was spent on
-- piano lessons whether or not it travelled by check — and then archives the
-- check. Correct, and it left nothing on the transaction saying a check was
-- involved at all. The register could not mark the row, and the only way back to
-- the check number was reading delegation history.
--
-- Nullable, and null for every row that predates this: there is no way to
-- reconstruct which payment settled which check after the fact, and guessing at
-- it from amounts and dates is exactly the loose matching the confirm flow
-- exists to avoid. Old rows simply carry no chip.
ALTER TABLE "transactions"
  ADD COLUMN "settled_check_delegation_id" UUID;

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_settled_check_delegation_id_fkey"
  FOREIGN KEY ("settled_check_delegation_id") REFERENCES "delegations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One check is settled by one transaction. The partial index enforces that and
-- costs nothing on the rows where the column is null, which is nearly all of
-- them.
CREATE UNIQUE INDEX "transactions_settled_check_delegation_id_key"
  ON "transactions" ("settled_check_delegation_id")
  WHERE "settled_check_delegation_id" IS NOT NULL;
