-- Whether every account must have a second factor before it can reach anything.
--
-- §10 makes TOTP mandatory before any internet exposure. It is a setting rather
-- than an unconditional rule so that shipping the code cannot lock the household
-- out of a running deployment in the gap between the release landing and them
-- enrolling. Turning it on is the last step of Phase 3, not the first.
ALTER TABLE "budget_settings"
  ADD COLUMN "require_totp" BOOLEAN NOT NULL DEFAULT false;
