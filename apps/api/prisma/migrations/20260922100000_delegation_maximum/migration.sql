-- A maximum: the most a line is allowed to hold when Delegate is pressed.
--
-- A target says what a line is saving towards and writes nothing (ADR 047). A
-- maximum is the other half of that sentence and it *does* write: the household
-- delegates $200 a paycheck into a line capped at $400, and once the line holds
-- $275 the next press puts in $125 rather than $200. The $75 is not moved
-- anywhere — it simply stays undelegated, which is the reading at the top of the
-- page, available for whatever the payday actually needs.
--
-- Nullable, and null means no maximum, which is what every existing row gets.
-- Nothing is rewritten and no line behaves differently on upgrade.
ALTER TABLE "delegations"
  ADD COLUMN "max_balance_cents" BIGINT;

-- A maximum of zero or less is not a maximum, it is an instruction never to
-- fund the line — which is what an empty amount to delegate already says, and
-- says without making every future press silently do nothing. Clearing one is
-- what a null is for.
ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_max_is_positive" CHECK (
    "max_balance_cents" IS NULL OR "max_balance_cents" > 0
  );
