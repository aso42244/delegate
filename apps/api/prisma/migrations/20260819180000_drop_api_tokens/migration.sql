-- Removes the API token table again.
--
-- The MCP work it existed for was withdrawn. The table is dropped rather than
-- the creating migration being deleted: migrations are forward-only (ADR 003),
-- and the deployment has already applied `20260819100000_api_tokens`. Removing
-- that file would leave a row in `_prisma_migrations` naming a migration that
-- no longer exists, which `migrate deploy` reports as drift and refuses.
--
-- This is the one place in the schema where dropping is right rather than
-- archiving. Nothing here is a record of anything the household did — the rows
-- are credentials, and a credential for a feature that no longer exists should
-- not survive in a backup.

DROP TABLE IF EXISTS "api_tokens";
DROP TYPE IF EXISTS "api_token_scope";
