-- Counter search (DEV-575 / #1382): drop any leftover/invalid index before
-- recreate. Must be the only statement in this file — CREATE/DROP INDEX
-- CONCURRENTLY cannot run inside a transaction block (Postgres 25001), and
-- Prisma wraps multi-statement migrations in one transaction.
--
-- Retry hazard: a failed concurrent CREATE leaves pg_index.indisvalid=false;
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS then no-ops. Drop first so recreate
-- can succeed. Prisma only re-runs while this migration is not yet applied.

DROP INDEX CONCURRENTLY IF EXISTS "pharmacy_medicines_counter_search_trgm_idx";
