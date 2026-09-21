-- A credential for a program, because a session cookie is for a browser.
--
-- Delegate has had no machine credential since the Model Context Protocol
-- work was withdrawn and `20260819180000_drop_api_tokens` removed the table it
-- used. Eventide now reads this budget through a narrow, read-only door
-- (ADR 070), and something outside the browser has to be able to knock on it:
-- no cookie jar, no second-factor prompt, and no sign-in page to be shown.
--
-- The name is the same as the table that was dropped; the shape is not. The old
-- one carried a scope and a selector and could be read-write. This one is
-- narrower on purpose (ADR 069):
--
--   * It authenticates **as a person**, so `user_id` is NOT NULL. Whatever the
--     token reads, it reads with that account's whole access. A nullable owner
--     would make every lookup return a row that may or may not carry a person,
--     and that null check would be the only thing between a stranger and the
--     budget. A type that cannot express the unsafe case is worth more than a
--     check that remembers to.
--   * It reaches the read door and nothing else. There is no scope column
--     because there is nothing to choose between.
--   * It is looked up by the digest of the secret, so there is no selector: one
--     indexed seek, then a constant-time compare of what the seek found.
--
-- What is stored is SHA-256 of the secret, never the secret. Every nightly
-- pg_dump contains this table, and a dump that hands over a working credential
-- is the reason a password is not stored either. A high-entropy random secret
-- wants a fast digest rather than a password hash: it cannot be guessed and it
-- is checked on every request.
--
-- Revoking sets `revoked_at`. Nothing here is hard-deleted, and a revoked row
-- is exactly the record somebody wants when asking "which machine had this,
-- and when did it last read the budget".

-- Issuing and revoking one is a change to a credential, which is exactly what
-- the log ADR 041 built is for. Added before the table so the two are one
-- migration; nothing in this file uses the new values, which is what lets the
-- ALTER TYPE run inside the migration's transaction.
ALTER TYPE "auth_event_kind" ADD VALUE 'api_token_created';
ALTER TYPE "auth_event_kind" ADD VALUE 'api_token_revoked';

CREATE TABLE "api_tokens" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  -- What the holder is called, in the household's words. A label, never a hint.
  "name"           TEXT NOT NULL,
  -- SHA-256 of the secret, hex. Never the secret.
  "token_hash"     TEXT NOT NULL,
  "user_id"        UUID NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Stamped on every accepted read, so a machine nobody is running is visible
  -- before anybody has to wonder about it.
  "last_used_at"   TIMESTAMP(3),
  -- The address as the server resolved it, so it already honours TRUST_PROXY.
  -- Text rather than INET for the reason `auth_events.ip` is: over Tor this is
  -- the loopback address of the SOCKS hop and means nothing.
  "last_used_from" TEXT,
  "revoked_at"     TIMESTAMP(3),

  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- The lookup path for every request at the read door. Unique because two rows
-- with one digest would be two credentials nothing could tell apart.
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");
-- The Settings card lists a person's own tokens.
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- Cascade: nothing hard-deletes a user here (they archive), so this is a guard
-- against a future that has not happened yet — a deleted account must not
-- leave a working credential behind.
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
