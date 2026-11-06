-- Counter search trigram index (DEV-575 / #1382).
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- migration intentionally has NO BEGIN/COMMIT wrapper (Prisma must not wrap it
-- either — apply as a non-transactional migration).
-- Safe to re-run: IF NOT EXISTS on extension and index.
-- Timestamp 20261106150000 is after develop tip 20261102140100.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "pharmacy_medicines_counter_search_trgm_idx"
  ON "pharmacy_medicines" USING GIN (
    "productName" gin_trgm_ops,
    "brandName" gin_trgm_ops,
    "manufacturer" gin_trgm_ops,
    "drapRegistrationNumber" gin_trgm_ops
  );
