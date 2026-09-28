-- Whether an overdue recurring bill is announced.
--
-- Recurring bills are worked out from history and stored nowhere, so this is the
-- only column the feature needs: the page is always available, and this decides
-- whether a bill that has not arrived on time puts a pill in the page header.
--
-- On by default, because a bill that stopped arriving is the whole reason to
-- detect one at all — a failed autopay is invisible until the balance is wrong.
-- Off is for a household that finds the detection noisy, which is a judgement
-- only they can make against their own register.
ALTER TABLE "budget_settings"
  ADD COLUMN "recurring_alerts_enabled" BOOLEAN NOT NULL DEFAULT true;
