-- Two-factor authentication becomes required, and the default for new installs.
--
-- It was optional so that shipping the mechanism could not lock a running
-- household out between the code landing and them enrolling. That reason has
-- expired: every account on this deployment has one, and the interface now has a
-- way back for an account that does not — before this, turning the requirement
-- on 403'd an un-enrolled user out of every route including the settings page
-- that offers enrolment.
--
-- Default true as well, so a fresh install is secure without anybody choosing
-- it. The first user is sent to enrolment immediately rather than being locked
-- out, which is what makes that safe.
ALTER TABLE "budget_settings" ALTER COLUMN "require_totp" SET DEFAULT true;

UPDATE "budget_settings" SET "require_totp" = true WHERE "id" = 1;
