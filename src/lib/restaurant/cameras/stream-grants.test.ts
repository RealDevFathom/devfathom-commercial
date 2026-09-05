import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/server/trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return { router: t.router, adminProcedure: t.procedure };
});
vi.mock('@/server/audit', () => ({ annotateAudit: vi.fn() }));
vi.mock('@/lib/restaurant/camera-presets', () => ({ listActiveCameraBrandPresets: vi.fn() }));
vi.mock('@/lib/restaurant/terminal-auth', () => ({ authenticateOperator: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/lib/restaurant/camera-gateway-runtime', () => ({
  cameraGatewayRuntime: { mode: 'mediamtx', available: true, adapter: {} },
  cameraGatewayPublicState: vi.fn(),
}));
import { restaurantCamerasRouter } from '@/server/routers/restaurant-cameras';
import { annotateAudit } from '@/server/audit';

const camera = { id: 'c', organizationId: 'org', branchId: 'b', gatewayId: 'gw', enabled: true };
const gateway = {
  id: 'gw',
  organizationId: 'org',
  branchId: 'b',
  status: 'ACTIVE',
  revokedAt: null as Date | null,
};
const previous = {
  id: 'old',
  cameraId: 'c',
  organizationId: 'org',
  viewerId: 'u',
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null as Date | null,
};
const create = vi.fn(async () => ({ id: 'new', expiresAt: new Date(Date.now() + 60_000) }));
const cameraRead = vi.fn(),
  gatewayRead = vi.fn(),
  previousRead = vi.fn();
const context = {
  entitlements: {},
  session: { user: { id: 'u', organizationId: 'org' } },
  db: {
    restaurantCamera: { findUnique: cameraRead },
    restaurantCameraGateway: { findUnique: gatewayRead },
    restaurantCameraStreamGrant: { findUnique: previousRead, create },
  },
};
const caller = restaurantCamerasRouter.createCaller(
  context as unknown as Parameters<typeof restaurantCamerasRouter.createCaller>[0]
);
beforeEach(() => {
  vi.clearAllMocks();
  cameraRead.mockResolvedValue({ ...camera });
  gatewayRead.mockResolvedValue({ ...gateway });
  previousRead.mockResolvedValue({ ...previous, expiresAt: new Date(Date.now() + 60_000) });
});

test('initial and renewed grants retain 60 second expiry and current viewer', async () => {
  await caller.issueStreamGrant({ cameraId: 'c' });
  await caller.issueStreamGrant({ cameraId: 'c', previousGrantId: 'old' });
  expect(create).toHaveBeenCalledTimes(2);
  expect(annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
  const data = (
    create.mock.calls[1] as unknown as [{ data: { viewerId: string; expiresAt: Date } }]
  )[0].data;
  expect(data.viewerId).toBe('u');
  expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(59_000);
  expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
});

test('renewal denies revoked, expired, missing, cross-user, cross-camera and cross-tenant grants', async () => {
  for (const value of [
    null,
    { ...previous, revokedAt: new Date() },
    { ...previous, expiresAt: new Date(0) },
    { ...previous, viewerId: 'other' },
    { ...previous, cameraId: 'other' },
    { ...previous, organizationId: 'other' },
  ]) {
    previousRead.mockResolvedValue(value);
    await expect(
      caller.issueStreamGrant({ cameraId: 'c', previousGrantId: 'old' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(create).not.toHaveBeenCalled();
});

test('issuance denies disabled camera and revoked, missing or cross-branch gateway', async () => {
  cameraRead.mockResolvedValue({ ...camera, enabled: false });
  await expect(caller.issueStreamGrant({ cameraId: 'c' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  cameraRead.mockResolvedValue(camera);
  for (const value of [
    null,
    { ...gateway, revokedAt: new Date() },
    { ...gateway, status: 'REVOKED' },
    { ...gateway, branchId: 'other' },
    { ...gateway, organizationId: 'other' },
  ]) {
    gatewayRead.mockResolvedValue(value);
    await expect(caller.issueStreamGrant({ cameraId: 'c' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  }
  expect(create).not.toHaveBeenCalled();
});

test('recording RPC reports unsupported explicitly', async () => {
  await expect(caller.listRecordings({ cameraId: 'c' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('Recordings unsupported'),
  });
});
