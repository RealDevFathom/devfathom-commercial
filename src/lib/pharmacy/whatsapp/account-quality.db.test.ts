// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261029090000_whatsapp_account_quality_hold/migration.sql',
  'utf8'
);

describe.skipIf(!databaseUrl)('WhatsApp account-quality migration', () => {
  it('preserves recurring notifications while deduplicating only account-quality owner alerts', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      // Temporary objects shadow production names, including the enum. Roll back all DDL.
      await client.query(`
        CREATE TEMP TABLE notifications (
          id text PRIMARY KEY, "organizationId" text, "userId" text, type text,
          "entityId" text, "createdAt" timestamptz
        );
        CREATE TYPE pg_temp."PharmacyCampaignStatus" AS ENUM ('DRAFT', 'APPROVED', 'CAPTURED', 'REFUSED');
        CREATE TEMP TABLE pharmacy_campaigns (id text PRIMARY KEY);
        INSERT INTO notifications VALUES
          ('task-old', 'org-a', 'owner', 'task_assigned', 'task', '2026-01-01'),
          ('task-new', 'org-a', 'owner', 'task_assigned', 'task', '2026-01-02'),
          ('alert-old', 'org-a', 'owner', 'pharmacy_whatsapp_account_quality', 'waba:BAN', '2026-01-01'),
          ('alert-new', 'org-a', 'owner', 'pharmacy_whatsapp_account_quality', 'waba:BAN', '2026-01-02'),
          ('alert-tenant-b', 'org-b', 'owner', 'pharmacy_whatsapp_account_quality', 'waba:BAN', '2026-01-02'),
          ('alert-owner-b', 'org-a', 'other-owner', 'pharmacy_whatsapp_account_quality', 'waba:BAN', '2026-01-02');
      `);
      await client.query(migration);
      const { rows } = await client.query('SELECT id FROM notifications ORDER BY id');
      expect(rows.map(({ id }) => id)).toEqual([
        'alert-old',
        'alert-owner-b',
        'alert-tenant-b',
        'task-new',
        'task-old',
      ]);
      await client.query(`INSERT INTO notifications VALUES
        ('task-repeat', 'org-a', 'owner', 'task_assigned', 'task', now())`);
      const duplicate = await client.query(`INSERT INTO notifications VALUES
        ('alert-retry', 'org-a', 'owner', 'pharmacy_whatsapp_account_quality', 'waba:BAN', now())
        ON CONFLICT DO NOTHING RETURNING id`);
      expect(duplicate.rowCount).toBe(0);
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    }
  });
});
