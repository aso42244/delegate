-- Brokerage positions, their purchase lots, and the benchmark they are judged
-- against. ADR 080.
--
-- Shares are millionths of a share in BIGINT, money is cents in BIGINT, and
-- nothing is deleted: a position the feed stops reporting is archived, a lot
-- taken back is archived.

CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "feed_key" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT,
    "shares_micros" BIGINT NOT NULL,
    "market_value_cents" BIGINT NOT NULL,
    "feed_cost_basis_cents" BIGINT,
    "as_of" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "positions_account_id_feed_key_key" ON "positions"("account_id", "feed_key");

ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "position_lots" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "purchased_on" DATE NOT NULL,
    "shares_micros" BIGINT NOT NULL,
    "cost_cents" BIGINT NOT NULL,
    "note" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_lots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "position_lots_shares_positive" CHECK ("shares_micros" > 0),
    CONSTRAINT "position_lots_cost_not_negative" CHECK ("cost_cents" >= 0)
);

CREATE INDEX "position_lots_position_id_idx" ON "position_lots"("position_id");

ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_position_id_fkey"
    FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "index_prices" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "price_date" DATE NOT NULL,
    "close_cents" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "index_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "index_prices_symbol_price_date_key" ON "index_prices"("symbol", "price_date");
