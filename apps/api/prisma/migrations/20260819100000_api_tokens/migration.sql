-- A credential for a program, because the session cookie is for a browser.
--
-- The Model Context Protocol server needs to authenticate without a cookie jar
-- and without being able to answer a TOTP prompt. Everything it may do is
-- decided by `scope` plus the route allowlist in the application; nothing here
-- grants anything on its own.

CREATE TYPE "api_token_scope" AS ENUM ('read', 'read_write');

CREATE TABLE "api_tokens" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "name"         TEXT NOT NULL,
  -- The public half, presented in the clear on every request.
  "selector"     TEXT NOT NULL,
  -- SHA-256 of the secret half. Never the token.
  "secret_hash"  TEXT NOT NULL,
  "scope"        "api_token_scope" NOT NULL DEFAULT 'read',
  "user_id"      UUID NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "expires_at"   TIMESTAMP(3),
  "revoked_at"   TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- The lookup path for every authenticated request. Unique because a collision
-- would make two tokens indistinguishable before their secrets are compared.
CREATE UNIQUE INDEX "api_tokens_selector_key" ON "api_tokens"("selector");
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- Cascade: deleting a user must not leave a working credential behind.
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
