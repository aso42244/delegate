-- A short name for an account, and a chosen chart for an insight tile.
--
-- Both are display, and both are nullable so that absent means "use what you
-- were using before" rather than a value someone has to pick.

-- Bank names are long: "Citibank Costco VISA Costco Anywhere Visa® Card by
-- Citi-7459" is a column of its own on every transaction row. The real name
-- stays in Settings, where identifying the account is the point.
ALTER TABLE "accounts" ADD COLUMN "nickname" TEXT;

-- Null means the widget's own default. Validated in the application against a
-- per-widget list, because which charts suit which data is a fact about the
-- widget rather than about the database.
ALTER TABLE "insight_layouts" ADD COLUMN "display" TEXT;
