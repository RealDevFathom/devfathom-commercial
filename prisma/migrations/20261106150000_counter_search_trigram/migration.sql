-- Counter search trigram index (DEV-575 / #1382).
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- migration intentionally has NO BEGIN/COMMIT wrapper (Prisma must not wrap it
-- either — apply as a non-transactional migration).
-- Timestamp 20261106150000 is after develop tip 20261102140100.
--
-- Retry hazard: a failed concurrent build leaves an invalid index
-- (pg_index.indisvalid = false). CREATE INDEX CONCURRENTLY IF NOT EXISTS then
-- no-ops on retry, and Prisma may mark the migration applied while search stays
-- unusable. Drop the same-named index first (including an invalid leftover),
-- then recreate. Prisma only re-runs this while the migration is not yet
-- applied, so a healthy index is not dropped on every deploy.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX CONCURRENTLY IF EXISTS "pharmacy_medicines_counter_search_trgm_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "pharmacy_medicines_counter_search_trgm_idx"
  ON "pharmacy_medicines" USING GIN (
    "productName" gin_trgm_ops,
    "brandName" gin_trgm_ops,
    "manufacturer" gin_trgm_ops,
    "drapRegistrationNumber" gin_trgm_ops
  );
