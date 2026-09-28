-- A TOTP code, once used, cannot be used again.
--
-- The verifier accepts a code for one period either side of now, so a code is
-- good for roughly ninety seconds. Nothing recorded that one had been spent, so
-- anybody who saw a code inside that window could use it a second time — and
-- with TLS terminated by a tunnel provider, "saw a code" is not hypothetical.
--
-- Recovery codes were already single-use. This gives TOTP the same property.
CREATE TABLE "totp_used_codes" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL,
  -- HMAC, not the code: a six-digit number in a nightly dump is worthless after
  -- ninety seconds, but there is no reason to write one down either.
  "code_hash"  TEXT NOT NULL,
  -- When this row stops mattering, so the table stays small on its own.
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "totp_used_codes_pkey" PRIMARY KEY ("id")
);

-- The uniqueness *is* the mechanism: a second use is a failed insert rather
-- than a read-then-write that two simultaneous requests could both pass.
CREATE UNIQUE INDEX "totp_used_codes_user_id_code_hash_key"
  ON "totp_used_codes"("user_id", "code_hash");
CREATE INDEX "totp_used_codes_expires_at_idx" ON "totp_used_codes"("expires_at");

ALTER TABLE "totp_used_codes"
  ADD CONSTRAINT "totp_used_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remote access over Tor, off until somebody turns it on from the LAN.
--
-- The onion service existing is not the same as it being open: the address is
-- unguessable, but an address that leaked would otherwise be a way in. With this
-- false, a request arriving over the onion address is refused before it reaches
-- anything.
ALTER TABLE "budget_settings"
  ADD COLUMN "remote_over_tor_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "remote_over_tor_enabled_at" TIMESTAMP(3);
