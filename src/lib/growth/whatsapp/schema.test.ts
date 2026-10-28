import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261021143000_growth_wa_channel/migration.sql'),
  'utf8'
);
const cascade = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261021160000_growth_wa_settings_cascade/migration.sql'),
  'utf8'
);

describe('growth WhatsApp migration', () => {
  it('stores the webhook secret, forces tenant isolation, and dedupes provider ids', () => {
    for (const table of [
      'growth_wa_settings',
      'growth_wa_customers',
      'growth_wa_messages',
      'growth_wa_templates',
    ]) {
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON "${table}"`);
    }
    expect(sql).toContain('"waWebhookSecretHash" TEXT');
    expect(sql).toContain('"waWebhookSecretEnc" TEXT');
    expect(sql).toContain('UNIQUE ("organizationId", "waMessageId")');
    expect(sql).toContain("current_setting('app.is_platform_admin', true) = 'true'");
    expect(sql).not.toContain('growth_settings');
    expect(sql).not.toContain('message_log');
  });

  it('puts organizationId on all four growth_wa tables and cascades settings', () => {
    for (const table of [
      'growth_wa_settings',
      'growth_wa_customers',
      'growth_wa_messages',
      'growth_wa_templates',
    ]) {
      const block = sql.split(`CREATE TABLE "${table}"`)[1]?.split('CREATE TABLE')[0] ?? '';
      expect(block).toContain('"organizationId"');
    }
    expect(cascade).toContain('growth_wa_settings');
    expect(cascade).toContain('ON DELETE CASCADE');
  });
});
