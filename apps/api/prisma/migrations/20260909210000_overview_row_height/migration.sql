-- How tall a row on Overview is, in pixels.
--
-- Per row rather than per tile, and stored on every tile in the row because a
-- row is not a record here — it is a number that two or three tiles happen to
-- share. A read takes the largest of them, so a row whose members disagree is
-- still a row rather than a ragged edge, and dragging writes the same value to
-- each member.
--
-- Null is the tile's own height, which is what every existing row keeps.
ALTER TABLE "overview_tiles" ADD COLUMN "height_px" INTEGER;
