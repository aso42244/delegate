-- Tiles form rows, and a row divides its width evenly among its members.
--
-- This replaces the per-tile `span` that shipped in v0.56.0. That vocabulary —
-- third, half, two-thirds, full — was `SettingsCard`'s, and borrowing it was
-- right for a page of independent cards and wrong for a dashboard: it cannot
-- express "these three share a row". Two tiles each declaring `half` only look
-- like a row by coincidence, and the moment a third is added between them the
-- arrangement means something nobody asked for.
--
-- A row states the relationship instead, and the width falls out of it. One tile
-- in a row is full width, two are halves, three are thirds, four are quarters.
-- The grid is **twelve** columns rather than six for exactly that reason: 12
-- divides by 1, 2, 3 and 4 with nothing left over, and six cannot express a
-- quarter without a half-column.
--
-- `position` keeps its meaning but narrows: it is the order **within** a row now
-- rather than across the whole page. `row` orders the rows.
--
-- Backfill puts every existing tile in its own row, in the order it was already
-- in. That is exactly what a page of `full`-width tiles already looked like, so
-- nobody's arrangement changes on upgrade — which matters, because this ships to
-- a deployment already running v0.56.0.
ALTER TABLE "overview_tiles" ADD COLUMN "row" INTEGER NOT NULL DEFAULT 0;

UPDATE "overview_tiles" SET "row" = "position";

-- `span` is superseded rather than deprecated. Leaving it would be a column that
-- means nothing, read by nothing, that the next person has to work out is dead —
-- and a stored width would silently disagree with the width the row implies.
ALTER TABLE "overview_tiles" DROP COLUMN "span";

DROP INDEX IF EXISTS "overview_tiles_user_id_position_idx";
CREATE INDEX "overview_tiles_user_id_row_position_idx"
    ON "overview_tiles" ("user_id", "row", "position");
