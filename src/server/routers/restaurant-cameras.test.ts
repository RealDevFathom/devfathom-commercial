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
    expect(source).toContain('authenticateOperator');
  });
  test('fails closed when persistent camera credential encryption is not configured', () => {
    expect(source).toContain('const key = process.env.CAMERA_CREDENTIAL_KEY;');
    expect(source).toContain("code: 'INTERNAL_SERVER_ERROR'");
    expect(source).toContain('Camera credential storage is not configured.');
    expect(source).not.toContain("process.env.CAMERA_CREDENTIAL_KEY ?? randomBytes");
  });
});
