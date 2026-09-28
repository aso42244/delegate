-- Outstanding checks.
--
-- A check that has been written but not yet cashed is money the household has
-- spent and the bank has not seen. Modelled as a delegation, because that is
-- exactly what it is: an envelope holding the money until the check clears.
--
-- The budget identity is untouched by writing one. Moving $120 from Piano
-- Lessons to "Check 1062" leaves SUM(delegations) unchanged, and the bank
-- balance is unchanged too, because the bank does not know yet. When the check
-- clears, the bank transaction reduces the account and the allocation empties
-- the check line, and the identity balances again.

CREATE TYPE "DelegationKind" AS ENUM ('envelope', 'check');

ALTER TABLE "delegations"
  ADD COLUMN "kind" "DelegationKind" NOT NULL DEFAULT 'envelope',
  ADD COLUMN "check_number" TEXT,
  ADD COLUMN "check_memo" TEXT,
  ADD COLUMN "check_issued_at" TIMESTAMP(3),
  ADD COLUMN "check_source_delegation_id" UUID;

ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_check_source_delegation_id_fkey"
  FOREIGN KEY ("check_source_delegation_id") REFERENCES "delegations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A check carries its check fields; an envelope carries none of them. Enforced
-- here rather than in application code alone, so no future path can write half
-- a check.
ALTER TABLE "delegations"
  ADD CONSTRAINT "delegations_check_fields_match_kind" CHECK (
    ("kind" = 'check' AND "check_number" IS NOT NULL AND "check_issued_at" IS NOT NULL)
    OR
    ("kind" = 'envelope' AND "check_number" IS NULL AND "check_memo" IS NULL
      AND "check_issued_at" IS NULL AND "check_source_delegation_id" IS NULL)
  );

-- One outstanding check per number at a time. Archived checks are excluded, so a
-- number can be reused years later, which is what a chequebook does.
CREATE UNIQUE INDEX "delegations_open_check_number_key"
  ON "delegations" (lower("check_number"))
  WHERE "kind" = 'check' AND "archived_at" IS NULL;

CREATE INDEX "delegations_kind_idx" ON "delegations" ("kind");

-- The reserved grouping outstanding checks live in. A key rather than a name, so
-- the application finds it without depending on text a person could edit.
ALTER TABLE "groupings" ADD COLUMN "system_key" TEXT;

CREATE UNIQUE INDEX "groupings_system_key_key" ON "groupings" ("system_key")
  WHERE "system_key" IS NOT NULL;
