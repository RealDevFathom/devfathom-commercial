-- Match the existing case-insensitive substring predicates without narrowing
-- brand/generic/manufacturer/registration searches to prefixes.
-- pg_trgm is installed by the medicine-catalogue migration.
CREATE INDEX "pharmacy_medicines_counter_search_trgm_idx"
  ON "pharmacy_medicines" USING GIN (
    "productName" gin_trgm_ops,
    "brandName" gin_trgm_ops,
    "manufacturer" gin_trgm_ops,
    "drapRegistrationNumber" gin_trgm_ops
  );
