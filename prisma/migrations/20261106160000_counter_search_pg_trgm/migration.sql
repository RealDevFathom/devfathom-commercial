-- Counter search (DEV-575 / #1382): enable pg_trgm for GIN trigram ops.
-- Kept in its own migration so the later CONCURRENTLY index steps are
-- single-statement and can run outside a transaction block.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
