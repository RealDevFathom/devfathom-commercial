import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260830070000_restaurant_notification_webhook/migration.sql',
  'utf8'
);

describe('restaurant notification webhook migration', () => {
  it('adds only the webhook channel and its delivered outcome', () => {
    expect(migration).toContain(`ADD VALUE 'WEBHOOK'`);
    expect(migration).toContain(`ADD VALUE 'DELIVERED_WEBHOOK'`);
  });

  it('forces tenant RLS and constrains secret, endpoint, and failure fields', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "tenant_isolation"');
    expect(migration).toContain('restaurant_notification_webhooks_endpoint_ck');
    expect(migration).toContain('restaurant_notification_webhooks_secret_ck');
    expect(migration).toContain('restaurant_notification_webhooks_failure_ck');
    expect(migration).toContain('restaurant_notification_webhooks_organizationId_fkey');
    expect(migration).toContain('REFERENCES "organizations"("id")');
  });
});
