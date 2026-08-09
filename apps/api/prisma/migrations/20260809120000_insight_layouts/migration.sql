-- Which Insights widgets a person has on their page, and in what order.
--
-- Per user rather than per household: §9.4 says the layout persists per user,
-- and two people looking at one budget can reasonably want to see different
-- things about it.
--
-- The widget is identified by a string key rather than a foreign key to a
-- catalog table. The catalog is a fixed list in code — §9.4 chose a fixed set of
-- built-in widgets over a generic chart builder — so a table would be a second
-- place for that list to disagree with itself.
CREATE TABLE "insight_layouts" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID         NOT NULL,
  "widget_key" TEXT         NOT NULL,
  "position"   INTEGER      NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "insight_layouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "insight_layouts_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One row per widget per person: turning a widget on twice is not a thing.
CREATE UNIQUE INDEX "insight_layouts_user_id_widget_key_key"
  ON "insight_layouts"("user_id", "widget_key");

CREATE INDEX "insight_layouts_user_id_position_idx"
  ON "insight_layouts"("user_id", "position");
