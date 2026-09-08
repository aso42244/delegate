-- The Overview page's layout: which tiles a person has, in what order, at what
-- width.
--
-- A separate table from `insight_layouts` rather than three columns added to it,
-- and the reason is the transition rather than the shape. Overview replaces
-- Insights, but not in one release — the tiles are ported in batches, and both
-- pages exist while that happens. Sharing one table would mean adding a tile on
-- Insights silently added it to Overview, and removing one from Overview took it
-- off Insights: two pages editing one list, each unaware the other exists. That
-- is a defect nobody would find until they had already lost an arrangement.
--
-- `insight_layouts` is therefore untouched here and is dropped in the release
-- that deletes the Insights page, by which time nothing reads it.
--
-- `span` is the width on a desktop grid, in the six-column vocabulary
-- `SettingsCard` already uses — third, half, two-thirds, full. Deliberately the
-- same four words rather than a second scale: docs/ui-system.md §11 records that
-- a field's `width` and a card's `span` were nearly given one name, and two
-- vocabularies under one idea is a trap for whoever reads it next. A phone
-- ignores this column entirely — every tile is full width there — so it is a
-- fact about the grid rather than about the tile.
--
-- Default 'full', because a tile that has not been thought about should take the
-- width every card here has always taken.
--
-- `display` carries the same meaning it does on `insight_layouts`: which chart
-- this tile is drawn as, null meaning the widget's own default.
CREATE TABLE "overview_tiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "widget_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "span" TEXT NOT NULL DEFAULT 'full',
    "display" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overview_tiles_pkey" PRIMARY KEY ("id")
);

-- A widget appears once on a page. The layout is written by deleting the set and
-- rewriting it, so this constraint is not what keeps the writer honest — it is
-- what stops a future partial writer from producing a page that draws one tile
-- twice and reorders unpredictably.
CREATE UNIQUE INDEX "overview_tiles_user_id_widget_key_key"
    ON "overview_tiles" ("user_id", "widget_key");

-- Every read of this table is one person's tiles in order.
CREATE INDEX "overview_tiles_user_id_position_idx"
    ON "overview_tiles" ("user_id", "position");

ALTER TABLE "overview_tiles"
    ADD CONSTRAINT "overview_tiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
