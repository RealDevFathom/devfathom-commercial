import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraPrivacyRouter } from '@/lib/cameras/privacy';
import { verticalForModuleKey } from '@/lib/module-catalog';
import type { TRPCContext } from '../trpc';
import { restaurantCamerasRouter } from './restaurant-cameras';

vi.mock('@/lib/restaurant/camera-gateway-runtime', () => ({
  cameraGatewayRuntime: { available: true, adapter: {} },
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
const camera = {
  id: 'camera',
  organizationId: 'org',
  branchId: 'branch',
  gatewayId: 'gateway',
  enabled: true,
};
const db = {
  user: {
    findUnique: async () => ({
      organizationRole: { permissions: [{ capability: 'admin:access', effect: 'ALLOW' }] },
      permissionOverrides: [],
    }),
  },
  restaurantCamera: {
    findMany: vi.fn(async () => [camera]),
    findUnique: vi.fn(async () => camera),
  },
  restaurantCameraGateway: {
    findUnique: vi.fn(async () => ({
      organizationId: 'org',
      branchId: 'branch',
      status: 'ACTIVE',
    })),
  },
  restaurantCameraStreamGrant: {
    create: vi.fn(async () => ({ id: 'grant', expiresAt: new Date() })),
  },
};
function context(support: { id: string } | null) {
  return {
    support,
    db,
    organization: { id: 'org', vertical: verticalForModuleKey('restaurant-integrations') },
    session: { user: { id: 'viewer', organizationId: 'org', role: 'ADMIN', status: 'ACTIVE' } },
    entitlements: { organizationId: 'org', enabledModules: ['restaurant-integrations'] },
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext;
}
describe('restaurant camera access', () => {
  beforeEach(() => vi.clearAllMocks());
  it('refuses inventory and grants before accessing cameras for a support session', async () => {
    const ctx = context({ id: 'support' });
    const api = restaurantCamerasRouter.createCaller(ctx);
    const privacy = cameraPrivacyRouter.createCaller(ctx);
    await expect(privacy.view({ vertical: 'restaurant' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      privacy.revokeGrant({ vertical: 'restaurant', grantId: 'grant' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.issueStreamGrant({ cameraId: camera.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantCamera.findMany).not.toHaveBeenCalled();
    expect(db.restaurantCamera.findUnique).not.toHaveBeenCalled();
    expect(db.restaurantCameraStreamGrant.create).not.toHaveBeenCalled();
  });
  it('lists cameras and issues a viewer-bound grant for a tenant administrator', async () => {
    const api = restaurantCamerasRouter.createCaller(context(null));
    await expect(api.list()).resolves.toEqual([camera]);
    await expect(api.issueStreamGrant({ cameraId: camera.id })).resolves.toMatchObject({
      grantId: 'grant',
    });
    expect(db.restaurantCameraStreamGrant.create).toHaveBeenCalledWith({
      data: { cameraId: camera.id, viewerId: 'viewer', expiresAt: expect.any(Date) },
    });
  });
});
