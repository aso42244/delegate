-- A target that comes round again.
--
-- The first one entered against real data was home insurance: $2,200, due on the
-- last day of April and again on the last day of October. A single date could
-- record the April one and then went stale the moment it passed, leaving the
-- household to retype the same target twice a year — which is the arithmetic
-- targets were built to stop doing by hand.
--
-- So `target_date` becomes an **anchor** rather than a deadline: one occurrence
-- of the series, and the interval says how the rest follow. Null interval is a
-- one-off, which is what every existing row is and what it stays.
--
-- Months rather than days, because that is the unit these actually use —
-- monthly, quarterly, twice a year, yearly — and because a bill due on the last
-- day of April is due on the last day of October, which no number of days
-- expresses. The end-of-month rule lives in `@budget/shared` beside the rest of
-- the arithmetic.
ALTER TABLE "delegations"
  ADD COLUMN "target_interval_months" INTEGER;

-- An interval with no date has nothing to repeat from. A hundred and twenty
-- months is ten years, which is past the point where a household is saving
-- towards a thing rather than simply holding money.
ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_target_interval_needs_date" CHECK (
    "target_interval_months" IS NULL
    OR ("target_date" IS NOT NULL AND "target_interval_months" BETWEEN 1 AND 120)
  );
