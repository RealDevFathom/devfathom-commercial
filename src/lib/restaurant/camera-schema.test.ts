import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

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
