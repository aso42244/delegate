-- A rule does one of two things, and until now it could only do one of them.
--
-- Every rule assigned a delegation. That left the one transaction which arrives
-- most predictably of all — the paycheck, same payer, same fortnight — as the
-- one thing no rule could ever handle: a synced deposit lands as `normal`, sits
-- in the uncategorized queue, and waits for somebody to label it income by hand.
-- Every fortnight, for ever.
--
-- So a rule now carries an action rather than a destination: it assigns a
-- delegation, or it says what the transaction *is*. Exactly one of the two, and
-- the check constraint below is what makes "exactly" true rather than merely
-- intended — a rule with both would categorize a row the domain forbids
-- allocations on, and a rule with neither would match and then do nothing.
--
-- `delegation_id` becomes nullable to allow the second shape. Every existing
-- row keeps its delegation and a null `set_kind`, which is exactly what it did
-- yesterday; nothing is rewritten and no behaviour changes on upgrade.
ALTER TABLE "categorization_rules"
  ADD COLUMN "set_kind" "transaction_kind";

ALTER TABLE "categorization_rules"
  ALTER COLUMN "delegation_id" DROP NOT NULL;

-- `normal` is excluded deliberately. Only `normal` rows are examined in the
-- first place, so a rule labelling one `normal` would match and change nothing —
-- a rule that appears to work and does not is worse than one that is refused.
ALTER TABLE "categorization_rules"
  ADD CONSTRAINT "categorization_rules_one_action" CHECK (
    ("delegation_id" IS NOT NULL AND "set_kind" IS NULL)
    OR ("delegation_id" IS NULL AND "set_kind" IN ('income', 'transfer'))
  );
