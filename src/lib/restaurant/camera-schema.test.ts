import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const TEST_DATABASE_URL = process.env.CAMERA_TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const migration = readFileSync(
  'prisma/migrations/20260827070000_restaurant_cameras/migration.sql',
  'utf8'
);

describe('camera schema governance', () => {
  test('preset model is global and contains no secret column', () => {
    const block = schema.match(/model PlatformCameraBrandPreset \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).not.toContain('organizationId');
    expect(block.toLowerCase()).not.toContain('secret');
  });
  test('all tenant tables force RLS and preset policy is control-plane only', () => {
    for (const table of [
      'restaurant_camera_gateways',
      'restaurant_camera_credentials',
      'restaurant_cameras',
      'restaurant_camera_stream_grants',
    ])
      expect(migration).toContain(table);
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "control_plane_only"');
  });
  test('transport source contains no second WebRTC literal', () => {
    const contract = readFileSync('src/lib/restaurant/camera-gateway.ts', 'utf8').toLowerCase();
    expect(contract).not.toContain("'web" + "rtc'");
  });
});

describeIfDatabase('camera schema governance (real PostgreSQL)', () => {
  test('forced RLS and policies are visible to a non-superuser, non-bypass role', async () => {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const role = await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `
        SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
         WHERE relname = ANY($1::text[])
         ORDER BY relname
      `,
        [
          [
            'restaurant_camera_gateways',
            'restaurant_camera_credentials',
            'restaurant_cameras',
            'restaurant_camera_stream_grants',
            'platform_camera_brand_presets',
          ],
        ]
      );
      expect(tables.rows).toHaveLength(5);
      expect(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

      const policies = await client.query<{ tablename: string; policyname: string }>(
        `
        SELECT tablename, policyname
          FROM pg_policies
         WHERE tablename = ANY($1::text[])
         ORDER BY tablename
      `,
        [tables.rows.map((row) => row.relname)]
      );
      expect(
        policies.rows
          .filter((row) => row.policyname === 'tenant_isolation')
          .map((row) => row.tablename)
      ).toHaveLength(4);
      expect(policies.rows).toContainEqual({
        tablename: 'platform_camera_brand_presets',
        policyname: 'control_plane_only',
      });
    } finally {
      await client.end();
    }
  });
});
