-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('asset', 'debt');

-- CreateEnum
CREATE TYPE "account_source" AS ENUM ('simplefin', 'manual');

-- CreateEnum
CREATE TYPE "grouping_section" AS ENUM ('assets', 'debts', 'delegations');

-- CreateEnum
CREATE TYPE "delegation_event_type" AS ENUM ('delegate', 'categorize', 'transfer', 'adjust');

-- CreateEnum
CREATE TYPE "transaction_kind" AS ENUM ('normal', 'income', 'transfer');

-- CreateEnum
CREATE TYPE "rule_match_mode" AS ENUM ('contains', 'starts_with', 'regex');

-- CreateEnum
CREATE TYPE "rule_direction" AS ENUM ('any', 'debit', 'credit');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'admin', 'super_admin');

-- CreateEnum
CREATE TYPE "sync_run_status" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'user',
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groupings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "section" "grouping_section" NOT NULL,
    "color" TEXT,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groupings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "account_type" NOT NULL,
    "source" "account_source" NOT NULL,
    "in_budget" BOOLEAN NOT NULL DEFAULT true,
    "in_net_worth" BOOLEAN NOT NULL DEFAULT true,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "balance_as_of" TIMESTAMP(3),
    "staleness_interval_days" INTEGER,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "external_id" TEXT,
    "grouping_id" UUID,
    "mortgage_account_id" UUID,
    "bitcoin_sats" BIGINT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_valuations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "value_cents" BIGINT NOT NULL,
    "as_of" DATE NOT NULL,
    "note" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "grouping_id" UUID,
    "amount_to_delegate_cents" BIGINT,
    "is_utility" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegation_events" (
    "id" UUID NOT NULL,
    "delegation_id" UUID NOT NULL,
    "delta_cents" BIGINT NOT NULL,
    "event_type" "delegation_event_type" NOT NULL,
    "batch_id" UUID,
    "transaction_id" UUID,
    "delegate_run_id" UUID,
    "delegation_transfer_id" UUID,
    "actor_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegate_runs" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),

    CONSTRAINT "delegate_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegation_transfers" (
    "id" UUID NOT NULL,
    "from_delegation_id" UUID NOT NULL,
    "to_delegation_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "batch_id" UUID NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMP(3),

    CONSTRAINT "delegation_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "description_raw" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "external_id" TEXT,
    "source" "account_source" NOT NULL DEFAULT 'manual',
    "paired_transaction_id" UUID,
    "kind" "transaction_kind" NOT NULL DEFAULT 'normal',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_allocations" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "delegation_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorization_rules" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "priority" INTEGER NOT NULL,
    "match_mode" "rule_match_mode" NOT NULL,
    "match_value" TEXT NOT NULL,
    "amount_min_cents" BIGINT,
    "amount_max_cents" BIGINT,
    "account_id" UUID,
    "direction" "rule_direction" NOT NULL DEFAULT 'any',
    "delegation_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categorization_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "sync_run_status" NOT NULL DEFAULT 'running',
    "accounts_touched" INTEGER NOT NULL DEFAULT 0,
    "transactions_added" INTEGER NOT NULL DEFAULT 0,
    "transactions_updated" INTEGER NOT NULL DEFAULT 0,
    "transactions_reversed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bitcoin_prices" (
    "id" UUID NOT NULL,
    "price_date" DATE NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "is_close" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bitcoin_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "undo_window_hours" INTEGER NOT NULL DEFAULT 12,
    "identity_tolerance_cents" BIGINT NOT NULL DEFAULT 500,
    "go_live_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_archived_at_idx" ON "users"("archived_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "groupings_section_name_idx" ON "groupings"("section", "name");

-- CreateIndex
CREATE INDEX "groupings_archived_at_idx" ON "groupings"("archived_at");

-- CreateIndex
CREATE INDEX "accounts_archived_at_idx" ON "accounts"("archived_at");

-- CreateIndex
CREATE INDEX "accounts_in_budget_idx" ON "accounts"("in_budget");

-- CreateIndex
CREATE INDEX "accounts_in_net_worth_idx" ON "accounts"("in_net_worth");

-- CreateIndex
CREATE INDEX "accounts_grouping_id_idx" ON "accounts"("grouping_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_source_external_id_key" ON "accounts"("source", "external_id");

-- CreateIndex
CREATE INDEX "account_valuations_account_id_as_of_idx" ON "account_valuations"("account_id", "as_of");

-- CreateIndex
CREATE UNIQUE INDEX "account_valuations_account_id_as_of_key" ON "account_valuations"("account_id", "as_of");

-- CreateIndex
CREATE INDEX "delegations_archived_at_idx" ON "delegations"("archived_at");

-- CreateIndex
CREATE INDEX "delegations_grouping_id_idx" ON "delegations"("grouping_id");

-- CreateIndex
CREATE INDEX "delegations_is_utility_idx" ON "delegations"("is_utility");

-- CreateIndex
CREATE INDEX "delegation_events_delegation_id_reversed_at_idx" ON "delegation_events"("delegation_id", "reversed_at");

-- CreateIndex
CREATE INDEX "delegation_events_batch_id_idx" ON "delegation_events"("batch_id");

-- CreateIndex
CREATE INDEX "delegation_events_transaction_id_idx" ON "delegation_events"("transaction_id");

-- CreateIndex
CREATE INDEX "delegation_events_event_type_idx" ON "delegation_events"("event_type");

-- CreateIndex
CREATE INDEX "delegation_events_occurred_at_idx" ON "delegation_events"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "delegate_runs_batch_id_key" ON "delegate_runs"("batch_id");

-- CreateIndex
CREATE INDEX "delegate_runs_created_at_idx" ON "delegate_runs"("created_at");

-- CreateIndex
CREATE INDEX "delegate_runs_undone_at_idx" ON "delegate_runs"("undone_at");

-- CreateIndex
CREATE INDEX "delegation_transfers_batch_id_idx" ON "delegation_transfers"("batch_id");

-- CreateIndex
CREATE INDEX "delegation_transfers_created_at_idx" ON "delegation_transfers"("created_at");

-- CreateIndex
CREATE INDEX "transactions_posted_at_idx" ON "transactions"("posted_at");

-- CreateIndex
CREATE INDEX "transactions_account_id_posted_at_idx" ON "transactions"("account_id", "posted_at");

-- CreateIndex
CREATE INDEX "transactions_pending_idx" ON "transactions"("pending");

-- CreateIndex
CREATE INDEX "transactions_kind_idx" ON "transactions"("kind");

-- CreateIndex
CREATE INDEX "transactions_archived_at_idx" ON "transactions"("archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_account_id_external_id_key" ON "transactions"("account_id", "external_id");

-- CreateIndex
CREATE INDEX "transaction_allocations_delegation_id_idx" ON "transaction_allocations"("delegation_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_allocations_transaction_id_delegation_id_key" ON "transaction_allocations"("transaction_id", "delegation_id");

-- CreateIndex
CREATE INDEX "categorization_rules_priority_idx" ON "categorization_rules"("priority");

-- CreateIndex
CREATE INDEX "categorization_rules_archived_at_idx" ON "categorization_rules"("archived_at");

-- CreateIndex
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs"("started_at");

-- CreateIndex
CREATE INDEX "sync_runs_status_idx" ON "sync_runs"("status");

-- CreateIndex
CREATE INDEX "bitcoin_prices_price_date_idx" ON "bitcoin_prices"("price_date");

-- CreateIndex
CREATE UNIQUE INDEX "bitcoin_prices_price_date_is_close_key" ON "bitcoin_prices"("price_date", "is_close");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_grouping_id_fkey" FOREIGN KEY ("grouping_id") REFERENCES "groupings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_mortgage_account_id_fkey" FOREIGN KEY ("mortgage_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_valuations" ADD CONSTRAINT "account_valuations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_valuations" ADD CONSTRAINT "account_valuations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_grouping_id_fkey" FOREIGN KEY ("grouping_id") REFERENCES "groupings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_delegate_run_id_fkey" FOREIGN KEY ("delegate_run_id") REFERENCES "delegate_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_delegation_transfer_id_fkey" FOREIGN KEY ("delegation_transfer_id") REFERENCES "delegation_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegate_runs" ADD CONSTRAINT "delegate_runs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_transfers" ADD CONSTRAINT "delegation_transfers_from_delegation_id_fkey" FOREIGN KEY ("from_delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_transfers" ADD CONSTRAINT "delegation_transfers_to_delegation_id_fkey" FOREIGN KEY ("to_delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_transfers" ADD CONSTRAINT "delegation_transfers_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paired_transaction_id_fkey" FOREIGN KEY ("paired_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_allocations" ADD CONSTRAINT "transaction_allocations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_allocations" ADD CONSTRAINT "transaction_allocations_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
