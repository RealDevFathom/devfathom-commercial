/**
 * DEV-751 — the evidence route authorises through the REAL pharmacy SOP router
 * mounted under its `pharmacySop` namespace, so the tRPC module gate sees the
 * path `pharmacySop.evidenceTarget` (→ `pharmacy-safety`). A router-local
 * caller would see the path `evidenceTarget`, which maps to no module at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(['sop:complete']),
  attachEvidence: vi.fn(),
  createTRPCContext: vi.fn(),
  deleteUpload: vi.fn(),
  putUpload: vi.fn(),
  resolveTenantActor: vi.fn(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    assertOccurrenceAtSite: vi.fn(),
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async (_subject, action: string) => mocks.granted.has(action)) };
});
vi.mock('@/lib/pharmacy/sop-adapter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-adapter')>(
    '@/lib/pharmacy/sop-adapter'
  )),
  ...mocks.adapter,
}));
vi.mock('@/lib/restaurant/sop-execution', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-execution')>(
    '@/lib/restaurant/sop-execution'
  )),
  attachEvidence: mocks.attachEvidence,
}));
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  deleteUpload: mocks.deleteUpload,
  putUpload: mocks.putUpload,
}));
vi.mock('@/server/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/trpc')>()),
  createTRPCContext: mocks.createTRPCContext,
}));
// The real pharmacy SOP router under its real namespace, without loading every
// other router in the application.
vi.mock('@/server/routers/_app', async () => {
  const { router } = await import('@/server/trpc');
  const { pharmacySopRouter } = await import('@/server/routers/pharmacy-sop');
  return { appRouter: router({ pharmacySop: pharmacySopRouter }) };
});

import { POST } from './route';
import { moduleForProcedure } from '@/lib/module-catalog';

process.env.AUTH_SECRET = 'pharmacy-sop-evidence-gate-test-secret';

function request() {
  const form = new FormData();
  form.set('pharmacyBranchId', 'pbranch_1');
  form.set('occurrenceId', 'occ_1');
  form.set('file', new File(['proof'], 'proof.png', { type: 'image/png' }));
  return {
    formData: async () => form,
    headers: new Headers({ origin: 'https://devfathom.test' }),
    url: 'https://devfathom.test/api/pharmacy/sop/evidence',
  } as Request;
}

function context(enabledModules: string[]) {
  const session = {
    expires: 'later',
    user: {
      id: 'user_1',
      organizationId: 'org_1',
      role: 'EMPLOYEE',
      department: 'OPERATIONS',
      status: 'ACTIVE',
    },
  };
  // The tenant db the route's attach transaction uses: the receipt write is
  // the only db call the route itself makes on a brand-new upload.
  const db: Record<string, unknown> = {
    pharmacySopEvidenceCapture: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    // The in-transaction share-lock re-check before attaching proof.
    $queryRaw: vi.fn().mockResolvedValue([]),
    restaurantSopOccurrence: {
      findFirst: vi.fn().mockResolvedValue({
        status: 'IN_PROGRESS',
        assignedStaffProfileId: 'staff_me',
        claimedByStaffProfileId: null,
      }),
    },
  };
  db.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db));
  return {
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules,
      modules: [],
      limits: {},
      activeSeats: 1,
      seatLimit: 10,
    },
    session,
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.granted = new Set(['sop:complete']);
  mocks.resolveTenantActor.mockResolvedValue({
    session: context([]).session,
    organization: { id: 'org_1' },
    support: null,
  });
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue({
    pharmacyBranchId: 'pbranch_1',
    sopBranchId: 'sopbranch_1',
    timezone: 'UTC',
    businessDayCutoff: '00:00',
  });
  mocks.adapter.resolvePharmacySopActor.mockResolvedValue({
    staffProfileId: 'staff_me',
    displayName: 'Me',
    userId: 'user_1',
  });
  mocks.adapter.assertOccurrenceAtSite.mockResolvedValue({
    id: 'occ_1',
    status: 'IN_PROGRESS',
    templateVersionId: 'ver_1',
    assignedStaffProfileId: 'staff_me',
    claimedByStaffProfileId: null,
    poolJobRoleId: null,
  });
  mocks.putUpload.mockResolvedValue(undefined);
  mocks.attachEvidence.mockResolvedValue({
    evidenceId: 'ev_1',
    contentHash: 'abc',
    createdAt: new Date(),
    created: true,
  });
});

describe('pharmacy SOP evidence route module gate', () => {
  it('the procedure path the route uses is gated on pharmacy-safety', () => {
    expect(moduleForProcedure('pharmacySop.evidenceTarget')).toBe('pharmacy-safety');
    // What a router-local caller would have reported: no module at all.
    expect(moduleForProcedure('evidenceTarget')).toBeNull();
  });

  it('refuses a tenant without pharmacy-safety before any scope work or storage', async () => {
    mocks.createTRPCContext.mockResolvedValue(context(['pharmacy-core', 'restaurant-sop']));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it('admits a pharmacy-safety tenant through the same real procedure', async () => {
    mocks.createTRPCContext.mockResolvedValue(context(['pharmacy-core', 'pharmacy-safety']));
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.adapter.resolvePharmacySopSite).toHaveBeenCalledOnce();
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ pharmacySopEvidenceCapture: expect.anything() }),
      expect.objectContaining({
        occurrenceId: 'occ_1',
        uploaderStaffProfileId: 'staff_me',
        storageRef: expect.stringMatching(/^\/api\/files\/pharmacy-sop-/),
      })
    );
  });

  it('still needs sop:complete with the module present', async () => {
    mocks.granted = new Set();
    mocks.createTRPCContext.mockResolvedValue(context(['pharmacy-core', 'pharmacy-safety']));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });
});
