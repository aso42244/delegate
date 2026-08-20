-- Delegations can be put in an order.
--
-- Alphabetical was the only order this application had. That is why a household
-- ends up naming its groupings "3 - Food" and "5 - Home": numbering by hand to
-- buy back an ordering the software would not give them.

ALTER TABLE "delegations" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfilled to the order the budget shows today, so nothing moves on upgrade.
-- Gaps of ten, matching the rules table: inserting between two neighbours does
-- not have to renumber the whole list.
WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY grouping_id
           ORDER BY lower(name), id
         ) * 10 AS seq
  FROM "delegations"
)
UPDATE "delegations" d
SET "position" = ordered.seq
FROM ordered
WHERE d.id = ordered.id;

-- The read path is "every live delegation, in order", so the index carries the
-- sort rather than leaving it to a sort node on every page load.
CREATE INDEX "delegations_grouping_id_position_idx"
  ON "delegations"("grouping_id", "position");
