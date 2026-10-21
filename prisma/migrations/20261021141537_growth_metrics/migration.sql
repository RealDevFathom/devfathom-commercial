ALTER TABLE "growth_settings" ADD COLUMN "lastMetricsRunAt" TIMESTAMP(3);
ALTER TABLE "customer_metrics" ALTER COLUMN "spend90dMinor" TYPE BIGINT;
