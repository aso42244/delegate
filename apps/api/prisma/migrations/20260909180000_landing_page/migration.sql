-- Where each person lands when they open the application.
--
-- Per person rather than per household: the two people using this budget read it
-- for different reasons — one for a daily glance, one to work on it — and a
-- single household setting would make one of them wrong every day.
--
-- Nullable with no default, deliberately. Null means "never chose", which stays
-- distinguishable from "chose Overview" — and that is what lets the default move
-- later without silently overriding somebody's decision.
CREATE TYPE "landing_page" AS ENUM ('overview', 'budget');

ALTER TABLE "users" ADD COLUMN "landing_page" "landing_page";
