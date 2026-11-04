// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

// Schema fixtures need owner authority; the runtime role keeps database CREATE revoked.
const databaseUrl = process.env.OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261021190000_qa304_contract_disabled_override_cleanup/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)(
  'QA-304 contract entitlement override preservation',
  () => {
    it('preserves manual denials identical to the old sync and all other overrides on replay', async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const schema = `qa304_${randomUUID().replaceAll('-', '')}`;

      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(`
        CREATE TABLE organizations (id text PRIMARY KEY, "packageId" text);
        CREATE TABLE platform_package_modules
          ("packageId" text, "moduleId" text, enabled boolean NOT NULL);
        CREATE TABLE platform_contracts
          (id text PRIMARY KEY, "organizationId" text NOT NULL, number text NOT NULL);
        CREATE TABLE organization_modules (
          id text PRIMARY KEY, "organizationId" text NOT NULL, "moduleId" text NOT NULL,
          status text NOT NULL, "seatLimit" integer, "expiresAt" timestamp,
          overrides jsonb, reason text,
          UNIQUE ("organizationId", "moduleId")
        );
        INSERT INTO organizations VALUES
          ('org', 'package'), ('other-org', 'other-package'), ('no-package', NULL);
        INSERT INTO platform_package_modules VALUES
          ('package', 'manual', true), ('package', 'ambiguous', true),
          ('package', 'admin-reason', true), ('package', 'custom-seat', true),
          ('package', 'custom-expiry', true), ('package', 'custom-json', true),
          ('package', 'foreign-contract', true), ('package', 'enabled', true),
          ('package', 'trial', true), ('package', 'expired', true),
          ('package', 'package-disabled', false), ('other-package', 'manual', true);
        INSERT INTO platform_contracts VALUES
          ('contract', 'org', 'CON-304'), ('other-contract', 'other-org', 'OTHER');
        INSERT INTO organization_modules VALUES
          ('manual-contract-reason', 'org', 'manual', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('ambiguous-contract-shaped', 'org', 'ambiguous', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('admin-reason', 'org', 'admin-reason', 'DISABLED', NULL, NULL, NULL, 'Disabled by admin'),
          ('custom-seat', 'org', 'custom-seat', 'DISABLED', 3, NULL, NULL, 'Contract CON-304'),
          ('custom-expiry', 'org', 'custom-expiry', 'DISABLED', NULL, '2027-01-01', NULL, 'Contract CON-304'),
          ('custom-json', 'org', 'custom-json', 'DISABLED', NULL, NULL, '{"cap":3}', 'Contract CON-304'),
          ('foreign-contract', 'org', 'foreign-contract', 'DISABLED', NULL, NULL, NULL, 'Contract OTHER'),
          ('package-disabled', 'org', 'package-disabled', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('enabled', 'org', 'enabled', 'ENABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('trial', 'org', 'trial', 'TRIAL', NULL, NULL, NULL, 'Contract CON-304'),
          ('expired', 'org', 'expired', 'EXPIRED', NULL, NULL, NULL, 'Contract CON-304'),
          ('other-org', 'other-org', 'manual', 'DISABLED', NULL, NULL, NULL, 'Contract OTHER'),
          ('no-package', 'no-package', 'manual', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304');
      `);
        const before = (await client.query('SELECT * FROM organization_modules ORDER BY id')).rows;
        expect(before).toHaveLength(13);

        await client.query(sql);
        const afterFirstRun = (await client.query('SELECT * FROM organization_modules ORDER BY id'))
          .rows;
        expect(afterFirstRun).toEqual(before);
        expect(afterFirstRun.find(({ id }) => id === 'manual-contract-reason')).toMatchObject({
          status: 'DISABLED',
          seatLimit: null,
          expiresAt: null,
          overrides: null,
          reason: 'Contract CON-304',
        });

        await client.query(sql);
        expect((await client.query('SELECT * FROM organization_modules ORDER BY id')).rows).toEqual(
          before
        );
      } finally {
        // Synthetic schema/rows are transaction-local; never delete persistent data.
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('does nothing when the catalog tables do not exist', async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const schema = `qa304_guard_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await expect(client.query(sql)).resolves.toBeDefined();
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });
  }
);
