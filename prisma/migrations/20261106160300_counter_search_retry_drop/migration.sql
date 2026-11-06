-- Repair a potentially invalid index left by a failed earlier concurrent build.
-- Keep this as the only statement: PostgreSQL forbids CONCURRENTLY in a transaction.
DROP INDEX CONCURRENTLY IF EXISTS "pharmacy_medicines_counter_search_trgm_idx";
