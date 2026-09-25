-- Whether an institution's reported balance already carries its pending charges.
--
-- The identity adds categorized pending charges back (ADR 020) because the feed's
-- `balance` is meant to be the settled one. Not every institution reads the
-- specification that way: one folds a pending ACH debit into the balance it
-- reports, so the charge is counted once there and again in the fourth term, and
-- the budget reads over-delegated by exactly its amount. ADR 074.
--
-- False, which is the behaviour every account had before this column existed, so
-- nothing reads differently on upgrade.
ALTER TABLE "accounts"
  ADD COLUMN "balance_includes_pending" BOOLEAN NOT NULL DEFAULT false;
