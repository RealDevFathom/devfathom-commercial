-- Counter search (DEV-575 / #1382): GIN trigram index for pharmacy counter
-- product/brand/manufacturer/DRAP search. Must be the only statement in this
-- file so Prisma does not wrap CONCURRENTLY in a transaction (25001 / P3018).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "pharmacy_medicines_counter_search_trgm_idx"
  ON "pharmacy_medicines" USING GIN (
    "productName" gin_trgm_ops,
    "brandName" gin_trgm_ops,
    "manufacturer" gin_trgm_ops,
    "drapRegistrationNumber" gin_trgm_ops
  );
