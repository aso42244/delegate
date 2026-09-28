-- Which side of the page a tile lives on.
--
-- Overview has two regions now: the main grid, and a single column down the
-- right beneath the budget panel. They are not the same shape and cannot be
-- expressed by position alone — the main grid holds up to two tiles a row, the
-- sidebar holds exactly one, and a tile moves between them by being dragged.
--
-- A column rather than a convention over `row` (negative numbers for the
-- sidebar, say). A convention would be invisible to anybody reading the table
-- and would need decoding at every call site; a column says what it is.
--
-- Default 'main', so every layout that exists keeps exactly the arrangement it
-- has. Nothing moves on upgrade.
ALTER TABLE "overview_tiles" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'main';

-- Rows are read per region, in order.
CREATE INDEX "overview_tiles_user_id_region_row_position_idx"
    ON "overview_tiles" ("user_id", "region", "row", "position");
