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
  test('fails closed before reading grants or gateway URLs when runtime support is unavailable', () => {
    const availabilityCheck = source.indexOf('if (!cameraGatewayRuntime.available)');
    expect(availabilityCheck).toBeGreaterThan(-1);
    expect(availabilityCheck).toBeLessThan(source.indexOf('searchParams.get'));
    expect(source).toContain("response('Camera gateway unavailable', 503)");
  });
  test('blocks demo tenants before entitlement, grant, or gateway access', () => {
    const demoGuard = source.indexOf('if (actor.organization.isDemo)');
    expect(demoGuard).toBeGreaterThan(-1);
    expect(source).toContain("response('Not available in demo.', 403)");
    expect(demoGuard).toBeLessThan(source.indexOf('resolveOrganizationEntitlements', demoGuard));
    expect(demoGuard).toBeLessThan(
      source.indexOf('restaurantCameraStreamGrant.findUnique', demoGuard)
    );
  });
});
