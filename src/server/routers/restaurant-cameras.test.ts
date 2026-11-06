import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
const source = readFileSync('src/server/routers/restaurant-cameras.ts', 'utf8');
describe('restaurant cameras router security contract', () => {
  test('uses strict tenant inputs without accepting organizationId', () => {
    expect(source).toContain("hasModule(ctx.entitlements, 'restaurant-integrations')");
    expect(source).toContain('z.object(shape).strict()');
    expect(source).not.toContain('strict({ organizationId');
  });
  test('keeps approver proof additive to the acting identity', () => {
    expect(source).toContain('buildCoAuthorizationRecord');
    expect(source).toContain('actingStaffProfileId: input.actingStaffProfileId');
    expect(source).toContain('approvingStaffProfileId: input.approvingStaffProfileId');
    expect(source).toContain('authenticateCoAuthorizationOperator');
    expect(source).toContain('buildAuthenticatedCoAuthorizationRecord');
    expect(source).toContain('await resolveRestaurantActor(ctx, [gateway.branchId])');
    expect(source).toContain('input.actingStaffProfileId !== actor.staffProfileId');
    const authSource = readFileSync('src/lib/restaurant/co-authorization.ts', 'utf8');
    expect(authSource).toContain('await authenticateOperator(db,');
  });
  test('fails closed when persistent camera credential encryption is not configured', () => {
    expect(source).toContain('const key = process.env.CAMERA_CREDENTIAL_KEY;');
    expect(source).toContain("code: 'INTERNAL_SERVER_ERROR'");
    expect(source).toContain('Camera credential storage is not configured.');
    expect(source).not.toContain('process.env.CAMERA_CREDENTIAL_KEY ?? randomBytes');
  });
  test('does not return gateway URLs and gates simulated operations behind runtime availability', () => {
    const serializedGateway = source.slice(
      source.indexOf('return rows.map'),
      source.indexOf('enrollGateway:')
    );
    expect(serializedGateway).not.toContain('baseUrl: row.baseUrl');
    expect(source).toContain('cameraGatewayPublicState(cameraGatewayRuntime)');
    expect(source).toContain('requireCameraGateway().listRecordings');
    expect(source).toContain('requireCameraGateway().testConnection');
  });
  test('authorizes camera enrollment against an active gateway in the selected branch', () => {
    expect(source).toContain(
      "where: { id: input.gatewayId, branchId: input.branchId, status: 'ACTIVE' }"
    );
    expect(source).toContain("message: 'Camera gateway unavailable.'");
  });
});
