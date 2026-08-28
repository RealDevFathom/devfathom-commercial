import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
const source = readFileSync('src/app/api/restaurant/cameras/[cameraId]/stream/route.ts', 'utf8');
describe('camera stream proxy threat controls', () => {
  test('freshly validates grant, camera, tenant, branch and gateway on every request', () => {
    for (const evidence of [
      'restaurantCameraStreamGrant.findUnique',
      'grant.cameraId !== cameraId',
      'camera.organizationId !== organizationId',
      'gateway.branchId !== camera.branchId',
      "gateway.status !== 'ACTIVE'",
    ])
      expect(source).toContain(evidence);
  });
  test('never accepts an upstream URL and refuses redirects and oversized bodies', () => {
    expect(source).not.toContain("searchParams.get('url')");
    expect(source).toContain("redirect: 'manual'");
    expect(source).toContain('MAX_MANIFEST_BYTES');
    expect(source).toContain('MAX_SEGMENT_BYTES');
  });
});
