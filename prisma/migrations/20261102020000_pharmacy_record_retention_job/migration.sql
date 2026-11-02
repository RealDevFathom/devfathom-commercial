-- DEV-96: daily, bounded pharmacy record retention purge per tenant, queued by
-- the platform worker. The value is added but not used in this migration, so
-- ALTER TYPE ... ADD VALUE is safe inside the migration transaction.
ALTER TYPE "PlatformJobType" ADD VALUE 'pharmacy.retention.v1';
