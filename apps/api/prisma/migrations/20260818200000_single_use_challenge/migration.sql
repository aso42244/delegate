-- A second-factor challenge can be presented once.
--
-- It proves a password was accepted moments ago and is accepted by exactly one
-- route, but it was replayable inside its five-minute life: anybody who saw one
-- could present it again with a fresh TOTP code. Bounded by the rate limit and
-- by codes now being single-use, so this was never the way in — it is the last
-- replayable thing in the sign-in path, and it costs one small table to close.
CREATE TABLE "used_challenges" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  -- HMAC, not the challenge itself.
  "challenge_hash" TEXT NOT NULL,
  "expires_at"     TIMESTAMP(3) NOT NULL,
  "used_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "used_challenges_pkey" PRIMARY KEY ("id")
);

-- The uniqueness is the mechanism, not a check before a write.
CREATE UNIQUE INDEX "used_challenges_challenge_hash_key" ON "used_challenges"("challenge_hash");
CREATE INDEX "used_challenges_expires_at_idx" ON "used_challenges"("expires_at");
