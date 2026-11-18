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

// The catalogue administrator's capability lookup (no role overrides).
const adminActor = {
  findUnique: vi.fn(async () => ({ organizationRole: null, permissionOverrides: [] })),
};

function caller(db: { user?: object; [delegate: string]: unknown }, actorId = 'admin-a') {
  return router({ pharmacyMedicine: pharmacyMedicineRouter }).createCaller({
    db: { ...db, user: { ...adminActor, ...db.user } },
    entitlements: {
      organizationId: 'org-a',
      enabledModules: ['pharmacy-core'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: actorId, role: 'ADMIN', status: 'ACTIVE' },
    },
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
    const packs: Array<object> = [];
    const medicine = {
      id: 'published-medicine',
      saleable: true,
      updatedAt: new Date('2026-09-01'),
    };
    const edit: Record<string, unknown> = {
      id: 'pending-edit',
      status: 'PENDING',
    };
    const db = {
      presentation: {
        findFirst: vi.fn(async () => ({
          id: input.presentationId,
          medicineId: medicine.id,
        })),
      },
      packLevel: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: object }) => {
          const pack = { id: 'new-pack', parentPackLevelId: null, effectiveTo: null, ...data };
          packs.push(pack);
          return pack;
        }),
      },
      pharmacyBranch: { findMany: vi.fn(async () => []) },
      pharmacyStockLocation: { findMany: vi.fn(async () => []) },
      pharmacySupplier: { findMany: vi.fn(async () => []) },
      user: { ...adminActor, findMany: vi.fn(async () => []) },
      medicine: {
        findFirst: vi.fn(async () => medicine),
        updateMany: vi.fn(async ({ data }: { data: object }) => {
          Object.assign(medicine, data);
          return { count: 1 };
        }),
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
    Object.assign(db, {
      auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
      pharmacyCatalogueEdit: {
        create: vi.fn(async ({ data }: { data: object }) => Object.assign(edit, data)),
        findFirst: vi.fn(async () => edit),
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async ({ data }: { data: object }) => {
          Object.assign(edit, data);
          return { count: 1 };
        }),
      },
      $transaction: async (run: (tx: unknown) => unknown) => run(db),
    });
    const proposed = await caller(db).createPackLevel(input);
    expect(proposed).toMatchObject({ status: 'PENDING' });
    expect(packs).toEqual([]);
    await caller(db, 'reviewer-a').decideCatalogueEdit({
      editId: proposed.id,
      decision: 'APPROVE',
    });
    const workspace = await purchasingWorkspace(
      db as unknown as Parameters<typeof purchasingWorkspace>[0],
      { organizationId: 'org-a', actorId: 'admin-a' },
      { at: new Date('2026-09-06') }
    );
    expect(workspace.medicines[0].packs).toEqual([
      expect.objectContaining({
        packLevelId: 'new-pack',
        canonicalUnitsPerPack: 10,
        presentation: '10 tablets',
        level: 'STRIP',
      }),
    ]);
    const earlier = await purchasingWorkspace(
      db as unknown as Parameters<typeof purchasingWorkspace>[0],
      { organizationId: 'org-a' },
      { at: new Date('2026-08-01') }
    );
    expect(earlier.medicines[0].packs).toEqual([]);
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

  it('refuses a second identical open pack and never writes it', async () => {
    const create = vi.fn();
    const findFirst = vi.fn(async () => ({ id: 'existing' }));
    await expect(
      caller({
        presentation: { findFirst: vi.fn(async () => ({ id: input.presentationId })) },
        packLevel: { findFirst, create },
      }).createPackLevel(input)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('already exists'),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        presentationId: input.presentationId,
        parentPackLevelId: null,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveTo: null,
      }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('maps a unique-index race to the same conflict', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    const medicine = { id: 'published-medicine', updatedAt: new Date('2026-09-01') };
    const edit: Record<string, unknown> = { id: 'pending-edit', status: 'PENDING' };
    const db: Record<string, unknown> = {
      presentation: {
        findFirst: vi.fn(async () => ({ id: input.presentationId, medicineId: medicine.id })),
      },
      packLevel: { findFirst: vi.fn(async () => null), create },
      // The replayed command re-checks the reviewer's capability on the transaction.
      user: adminActor,
      medicine: {
        findFirst: vi.fn(async () => medicine),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
      pharmacyCatalogueEdit: {
        create: vi.fn(async ({ data }: { data: object }) => Object.assign(edit, data)),
        findFirst: vi.fn(async () => edit),
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    db.$transaction = async (run: (tx: unknown) => unknown) => run(db);
    // A published pack edit is queued; the pack is written when an independent
    // reviewer's approval replays it, which is where the unique index can race.
    const proposed = await caller(db).createPackLevel(input);
    expect(proposed).toMatchObject({ status: 'PENDING' });
    expect(create).not.toHaveBeenCalled();
    await expect(
      caller(db, 'reviewer-a').decideCatalogueEdit({ editId: proposed.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(create).toHaveBeenCalledOnce();
  });
});
