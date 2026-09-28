-- How often the household is paid.
--
-- The Utilities page turned a monthly average into a per-paycheck figure by
-- dividing by 26, which is right for exactly one cadence. This makes the
-- divisor a setting.
--
-- It changes no stored money. The amount to delegate on each line is applied
-- once per Delegate press whatever this says, and a cycle is still one press to
-- the next — nothing here schedules anything.
--
-- The default is `biweekly` on purpose: it is what the arithmetic assumed
-- before it was configurable, so an existing budget reads identically after
-- this migration runs.

CREATE TYPE "pay_cadence" AS ENUM ('weekly', 'biweekly', 'semimonthly', 'monthly');

ALTER TABLE "budget_settings"
  ADD COLUMN "pay_cadence" "pay_cadence" NOT NULL DEFAULT 'biweekly';
