-- Time-based one-time passwords, and the recovery codes that go with them.
--
-- The shared secret is stored **encrypted** (AES-256-GCM, key derived from
-- SESSION_SECRET) rather than in the clear, for the same reason as the SimpleFIN
-- credential: this table is in every nightly pg_dump, and the dump is the copy
-- most likely to leave the device. A plaintext TOTP secret in a stolen dump is a
-- working second factor for whoever holds it.
ALTER TABLE "users"
  ADD COLUMN "totp_secret_encrypted" TEXT,
  ADD COLUMN "totp_confirmed_at" TIMESTAMP(3);

-- One row per code, hashed with argon2id exactly like a password. A recovery
-- code is a credential: it bypasses the second factor entirely, so a readable
-- one in a dump is the same problem as a readable password.
CREATE TABLE "recovery_codes" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"   UUID         NOT NULL,
  "code_hash" TEXT         NOT NULL,
  -- Set when spent. Nothing is deleted, so "you have used 7 of 10" is
  -- answerable, and a code cannot be silently reused.
  "used_at"   TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "recovery_codes_user_id_used_at_idx" ON "recovery_codes"("user_id", "used_at");
