-- Accounts and groupings can be put in an order.
--
-- Delegations have had a `position` since v0.24: the owner's groupings are named
-- "3 - Food" and "5 - Home" precisely because ordering was the thing missing,
-- and numbering them was the workaround. The same reasoning applies one level up
-- and one level across — the order accounts appear in is a fact about how this
-- household reads its own budget, and alphabetical is nobody's reading.
--
-- Default zero everywhere, which is what every existing row gets: with equal
-- positions the sort falls through to the name, so an untouched budget reads
-- exactly as it did the day before. A row only leaves the alphabet once somebody
-- moves it.
ALTER TABLE "accounts"  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "groupings" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
