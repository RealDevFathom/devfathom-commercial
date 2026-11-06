-- Fail if an index with this name exists, including an invalid leftover.
-- See docs/deploy-develop.md for recovery after an interrupted build.
CREATE INDEX CONCURRENTLY "pharmacy_medicines_counter_search_trgm_idx"
  ON "pharmacy_medicines" USING GIN (
    "productName" gin_trgm_ops,
    "brandName" gin_trgm_ops,
    "manufacturer" gin_trgm_ops,
    "drapRegistrationNumber" gin_trgm_ops
  );
