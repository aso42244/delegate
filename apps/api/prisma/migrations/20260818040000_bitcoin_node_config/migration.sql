-- Where Bitcoin address data is asked for.
--
-- A pinned singleton, like budget_settings. The URL is checked before it is
-- stored rather than when it is used: plaintext is permitted only to an onion
-- address or a private one, so a public endpoint cannot be configured over
-- http and quietly send every address lookup in the clear.

CREATE TABLE "bitcoin_node_config" (
  "id"              INTEGER NOT NULL DEFAULT 1,
  "mode"            TEXT NOT NULL DEFAULT 'none',
  "base_url"        TEXT,
  "use_tor"         BOOLEAN NOT NULL DEFAULT false,
  "last_checked_at" TIMESTAMP(3),
  "last_height"     INTEGER,
  "last_error"      TEXT,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bitcoin_node_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "bitcoin_node_config" ("id", "mode") VALUES (1, 'none');
