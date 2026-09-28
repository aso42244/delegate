-- A name to show, and a second factor that is no longer optional.

-- The username is an email address and reads as one everywhere it appears.
-- Null falls back to it, which is what every account did before this existed.
ALTER TABLE "users" ADD COLUMN "display_name" TEXT;

-- `require_totp` is gone: a second factor is required of everyone, always.
--
-- The setting never did what its name suggested. Sign-in demands the second
-- factor whenever an account has one confirmed, whatever this said — so it
-- could not rescue a locked-out account, and its only real effect was to permit
-- accounts with no second factor at all. That is not a state this household
-- wants to be able to reach.
ALTER TABLE "budget_settings" DROP COLUMN "require_totp";
