import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ hasModule: vi.fn(() => true) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: guards.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import { router, type TRPCContext } from '@/server/trpc';
import { purchasingWorkspace } from '@/lib/pharmacy/purchasing-console';

function caller(db: object) {
  // The pack procedures require pharmacy:procurement (real ABAC); grant it to this actor.
  const withGrant = db as { user?: object };
  withGrant.user = {
    ...(withGrant.user ?? {}),
    findUnique: vi.fn(async () => ({
      organizationRole: { permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] },
      permissionOverrides: [],
    })),
  };
  return router({ pharmacyMedicine: pharmacyMedicineRouter }).createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: { expires: 'later', user: { id: 'admin-a', role: 'ADMIN', status: 'ACTIVE' } },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyMedicine;
}
const input = {
  presentationId: 'published-presentation',
  versionGroupId: 'new-pack-group',
  level: 'STRIP' as const,
  unitsPerParent: 10,
  effectiveFrom: new Date('2026-09-01'),
};
beforeEach(() => {
  guards.hasModule.mockReturnValue(true);
});

describe('existing pack procedure to receiving options (in-memory delegates, no DB)', () => {
  it('makes the created effective pack selectable with the derived unit count', async () => {
    const packs: Array<object> = [
      {
        id: 'unit-leaf',
        level: 'UNIT',
        unitsPerParent: 10,
        parentPackLevelId: 'new-pack',
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
      },
    ];
    const db = {
      presentation: { findFirst: vi.fn(async () => ({ id: input.presentationId })) },
      packLevel: {
        create: vi.fn(async ({ data }: { data: object }) => {
          const pack = { id: 'new-pack', parentPackLevelId: null, effectiveTo: null, ...data };
          packs.push(pack);
          return pack;
        }),
      },
      pharmacyBranch: { findMany: vi.fn(async () => []) },
      pharmacyStockLocation: { findMany: vi.fn(async () => []) },
      pharmacySupplier: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) },
      medicine: {
        findMany: vi.fn(async () => [
          {
            id: 'published-medicine',
            productName: 'Paracetamol',
            brandName: 'Panadol',
            coldChain: false,
            controlled: false,
            presentations: [
              { id: input.presentationId, presentation: '10 tablets', packLevels: packs },
            ],
          },
        ]),
      },
    };
    await caller(db).createPackLevel(input);
    const workspace = await purchasingWorkspace(
      db as unknown as Parameters<typeof purchasingWorkspace>[0],
      { organizationId: 'org-a', actorId: 'admin-a' },
      { at: new Date('2026-09-06') }
    );
    // The UNIT leaf is itself a (1-unit) purchasable level; the created STRIP must be
    // selectable with its derived unit count.
    expect(workspace.medicines[0].packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packLevelId: 'new-pack',
          canonicalUnitsPerPack: 10,
          presentation: '10 tablets',
          level: 'STRIP',
        }),
      ])
    );
    const earlier = await purchasingWorkspace(
      db as unknown as Parameters<typeof purchasingWorkspace>[0],
      { organizationId: 'org-a' },
      { at: new Date('2026-08-01') }
    );
    expect(
      earlier.medicines[0].packs.map((p: { packLevelId: string }) => p.packLevelId)
    ).not.toContain('new-pack');
  });

  it.each([0, -1, 1.5])('rejects invalid units %s before persistence', async (unitsPerParent) => {
    const create = vi.fn();
    await expect(
      caller({ packLevel: { create } }).createPackLevel({ ...input, unitsPerParent })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the existing scoped-presentation denial', async () => {
    const create = vi.fn();
    await expect(
      caller({
        presentation: { findFirst: vi.fn(async () => null) },
        packLevel: { create },
      }).createPackLevel(input)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Presentation is outside this workspace.',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the existing module denial on the namespaced procedure', async () => {
    guards.hasModule.mockReturnValue(false);
    const create = vi.fn();
    await expect(caller({ packLevel: { create } }).createPackLevel(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(create).not.toHaveBeenCalled();
  });
});
