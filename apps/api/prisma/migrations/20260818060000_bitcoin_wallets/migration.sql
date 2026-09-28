-- Wallets watched by extended public key or descriptor.
--
-- The descriptor is encrypted at rest. It cannot spend, so the risk is not
-- theft — but it reveals every address the wallet will ever use, permanently,
-- which is a more durable loss than a balance. The database is dumped nightly,
-- so it gets the same treatment as the SimpleFIN credential.

CREATE TABLE "bitcoin_wallets" (
  "id"                           UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id"                   UUID NOT NULL,
  "label"                        TEXT NOT NULL,
  "kind"                         TEXT NOT NULL,
  "receive_descriptor_encrypted" TEXT NOT NULL,
  "change_descriptor_encrypted"  TEXT NOT NULL,
  -- Shown so the owner can confirm the right wallet without seeing the key.
  "first_address"                TEXT NOT NULL,
  "gap_limit"                    INTEGER NOT NULL DEFAULT 20,
  "last_scanned_at"              TIMESTAMP(3),
  "last_error"                   TEXT,
  "last_balance_sats"            BIGINT,
  "archived_at"                  TIMESTAMP(3),
  "created_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bitcoin_wallets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bitcoin_wallets_account_id_idx" ON "bitcoin_wallets"("account_id");

ALTER TABLE "bitcoin_wallets"
  ADD CONSTRAINT "bitcoin_wallets_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The derived addresses a scan has looked at, cached so a rescan does not start
-- from zero and so the interface can show what was found rather than a total.
CREATE TABLE "bitcoin_wallet_addresses" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_id"    UUID NOT NULL,
  -- 0 = receive, 1 = change.
  "chain"        INTEGER NOT NULL,
  "index"        INTEGER NOT NULL,
  "address"      TEXT NOT NULL,
  "balance_sats" BIGINT NOT NULL DEFAULT 0,
  "tx_count"     INTEGER NOT NULL DEFAULT 0,
  "last_seen_at" TIMESTAMP(3),

  CONSTRAINT "bitcoin_wallet_addresses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bitcoin_wallet_addresses_wallet_id_chain_index_key"
  ON "bitcoin_wallet_addresses"("wallet_id", "chain", "index");
CREATE INDEX "bitcoin_wallet_addresses_wallet_id_idx"
  ON "bitcoin_wallet_addresses"("wallet_id");

ALTER TABLE "bitcoin_wallet_addresses"
  ADD CONSTRAINT "bitcoin_wallet_addresses_wallet_id_fkey"
  FOREIGN KEY ("wallet_id") REFERENCES "bitcoin_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
