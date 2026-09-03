-- "That charge is this bill."
--
-- [ADR 045](../../../../docs/decisions/045-a-bill-is-inferred-not-entered.md) says
-- a bill is inferred from the register and stored nowhere, and that stays true:
-- this table holds no bills, schedules or amounts. It holds one fact the
-- inference cannot reach — that a particular transaction belongs to a particular
-- merchant's bill even though its description does not say so.
--
-- The first real run made the case twice over. A life-insurance payment arrived
-- and sat in the register while its bill read "Overdue - 5d", because the charge
-- was still pending and pending rows are excluded from the detection. And a
-- merchant that renames itself between charges gets a new merchant key, so the
-- old bill goes overdue for ever while the new one has too little history to be
-- detected at all. Neither is fixable by a threshold.
--
-- What a link does NOT do is change the schedule. The cadence and the typical
-- amount are still fitted from charges that matched on their own -- a linked
-- charge only answers "has it arrived", moves the last-seen date, and moves the
-- next expected date with it. Letting a link into the interval arithmetic would
-- let one correction drop a bill off the list entirely, by putting a gap in the
-- history that no longer fits the schedule.
CREATE TABLE "bill_links" (
  "id" UUID PRIMARY KEY,

  -- The merchant whose bill this charge belongs to. Not a foreign key, because
  -- there is no bills table to point at -- a bill is a computation. The same
  -- reason `bill_overrides` is keyed this way.
  "merchant_key" TEXT NOT NULL,

  -- One transaction belongs to at most one bill. Cascading, so a link cannot
  -- outlive the row it names.
  "transaction_id" UUID NOT NULL UNIQUE REFERENCES "transactions" ("id") ON DELETE CASCADE,

  "linked_by"  UUID REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every read is "what is linked to this merchant".
CREATE INDEX "bill_links_merchant_key_idx" ON "bill_links" ("merchant_key");
