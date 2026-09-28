-- Which way requests actually went.
--
-- A public node is tried over Tor first and falls back to clearnet if the proxy
-- is not reachable. That fallback must never be silent: without this column the
-- interface can say "it answered" while having no idea whether the household's
-- IP address was hidden or handed over.
ALTER TABLE "bitcoin_node_config" ADD COLUMN "last_route" TEXT;

-- `use_tor` was a question put to the owner. It is now decided by the address:
-- private goes direct, onion goes over Tor, everything else prefers Tor. The
-- column stays for one release so a rollback has somewhere to land.
