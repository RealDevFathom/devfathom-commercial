-- Shared fixed-window counters. This table is not tenant data: limits are
-- evaluated before a tenant scope exists, so row level security is intentionally
-- not enabled. The application role still must not be SUPERUSER or BYPASSRLS;
-- that is enforced at process startup for the tenant tables.
CREATE TABLE "rate_limit_buckets" (
  "key" TEXT PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "resetAt" TIMESTAMPTZ NOT NULL
);

CREATE INDEX "rate_limit_buckets_reset_at" ON "rate_limit_buckets" ("resetAt");
