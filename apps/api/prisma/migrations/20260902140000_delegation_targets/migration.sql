-- A target: what this line is saving towards, and by when.
--
-- The owner has been writing "$2200, Dec 27" into `notes` and doing the
-- per-paycheck arithmetic in his head. `notes` was left freeform for exactly
-- this reason — the architecture note beside it says structured target fields
-- stay a purely additive migration — and this is that migration.
--
-- Both columns are nullable and null means "no target", which is what every
-- existing row gets. Nothing is rewritten and no line behaves differently on
-- upgrade.
--
-- `target_date` is a DATE rather than a timestamp because it is a **date key**:
-- a day already decided, needing no zone to read. ADR 037 — an instant needs a
-- zone to place in a day, and a decided day does not.
ALTER TABLE "delegations"
  ADD COLUMN "target_cents" BIGINT,
  ADD COLUMN "target_date"  DATE;

-- A date with no amount is a deadline for nothing: it would render as a target
-- on the row and compute against a null. The amount is the target; the date is
-- optional and turns "keep this much here" into "have this much by then".
ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_target_date_needs_amount" CHECK (
    "target_date" IS NULL OR "target_cents" IS NOT NULL
  );

-- A target of zero or less is not a target. Nothing would ever be behind on it,
-- and clearing one is what a null is for.
ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_target_is_positive" CHECK (
    "target_cents" IS NULL OR "target_cents" > 0
  );
