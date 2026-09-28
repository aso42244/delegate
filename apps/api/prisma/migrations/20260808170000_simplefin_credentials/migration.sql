-- The SimpleFIN access URL, stored encrypted (AES-256-GCM) rather than in the
-- clear: it is a bearer credential for the household's bank data, and this table
-- lands in every nightly pg_dump. Null means the environment variable is used.
ALTER TABLE "budget_settings"
  ADD COLUMN "simplefin_access_url_encrypted" TEXT,
  ADD COLUMN "simplefin_connected_at" TIMESTAMP(3);
