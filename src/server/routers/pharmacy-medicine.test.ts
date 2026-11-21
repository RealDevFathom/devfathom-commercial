import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  return { hasModule, verifyPin: vi.fn(async () => 'OK') };
});
vi.mock('@/lib/pharmacy/owner-data-export-pin', () => ({
  verifyOwnerExportPin: mocks.verifyPin,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
import { moduleForProcedure } from '@/lib/module-catalog';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
  };
}

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ingredient: model(),
    medicine: {
      ...model(),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: 'medicine_a', saleable: false }),
    },
    auditLog: model(),
    pharmacyCatalogueEdit: {
      ...model(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: object }) => ({
        id: 'edit',
        status: 'PENDING',
        ...data,
      })),
    },
    medicineProvenance: {
      ...model(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    medicineReviewDecision: model(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    presentation: model(),
    packLevel: model(),
    medicinePackMrp: model(),
    medicineBarcode: model(),
    medicineAlias: model(),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();
function caller(enabledModules = ['pharmacy-core'], role = 'ADMIN', actorId = 'user_a') {
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules,
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: actorId, role, status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

// DEV-19: catalogue approval is the exact pharmacy:catalogue-review grant.
function grantCatalogueReview(...userIds: string[]) {
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    organizationRole: null,
    permissionOverrides: userIds.includes(where.id)
      ? [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }]
      : [],
  }));
}

beforeEach(() => {
  db = makeDb();
  mocks.verifyPin.mockReset().mockResolvedValue('OK');
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

const catalogueEdits = [
  [
    'proposeCatalogueEdit',
    { medicineId: 'medicine_a', changes: { productName: 'Changed' } },
    'pharmacyCatalogueEdit',
  ],
  ['decideCatalogueEdit', { editId: 'edit', decision: 'APPROVE' }, 'pharmacyCatalogueEdit'],
  ['createIngredient', { name: 'Paracetamol' }, 'ingredient'],
  ['createMedicine', { productName: 'Medicine', productFamily: 'PHARMACEUTICAL' }, 'medicine'],
  [
    'createPackLevel',
    {
      presentationId: 'presentation_a',
      versionGroupId: 'box',
      level: 'BOX',
      unitsPerParent: 20,
      effectiveFrom: new Date('2030-01-01'),
    },
    'packLevel',
  ],
  [
    'revisePackLevel',
    { id: 'pack_a', unitsPerParent: 30, effectiveFrom: new Date('2030-01-01') },
    'packLevel',
  ],
  [
    'recordPrintedMrp',
    { packLevelId: 'pack_a', batchReference: 'B1', printedMrpMinor: 1000 },
    'medicinePackMrp',
  ],
  [
    'addBarcode',
    { presentationId: 'presentation_a', type: 'GTIN', code: '123' },
    'medicineBarcode',
  ],
  ['addAlias', { medicineId: 'medicine_a', type: 'BRAND', value: 'Panadol' }, 'medicineAlias'],
] as const;

describe('catalogue edits require catalogue administration (DEV-19)', () => {
  it.each(catalogueEdits)(
    'refuses a cashier %s before any catalogue write',
    async (name, input, model) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
            { capability: 'pharmacy:orders', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      });
      db.presentation.findFirst.mockResolvedValue({ id: 'presentation_a' });
      db.packLevel.findFirst.mockResolvedValue({ id: 'pack_a', version: 1 });
      const procedure = caller(['pharmacy-core'], 'EMPLOYEE')[name] as (
        value: typeof input
      ) => Promise<unknown>;

      await expect(procedure(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db[model].create).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a pharmacy-wide role grant that lacks catalogue administration', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });

    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE').addAlias({
        medicineId: 'medicine_a',
        type: 'BRAND',
        value: 'Panadol',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicineAlias.create).not.toHaveBeenCalled();
  });

  it('queues a draft alias, refuses its editor, then lets another administrator approve the normalized write', async () => {
    grantCatalogueReview('user_a', 'user_b');
    db.medicine.findFirst.mockResolvedValue({
      id: 'medicine_a',
      saleable: false,
      updatedAt: new Date('2026-01-01'),
    });
    const proposal = await caller().addAlias({
      medicineId: 'medicine_a',
      type: 'BRAND',
      value: 'Panadol',
    });
    expect(proposal).toMatchObject({ status: 'PENDING' });
    expect(db.medicineAlias.create).not.toHaveBeenCalled();
    db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
    await expect(
      caller().decideCatalogueEdit({ editId: proposal.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await caller(['pharmacy-core'], 'ADMIN', 'user_b').decideCatalogueEdit({
      editId: proposal.id,
      decision: 'APPROVE',
    });
    await expect(db.medicineAlias.create.mock.results[0]!.value).resolves.toMatchObject({
      id: 'new',
      normalizedValue: 'panadol',
    });
    expect(db.medicineAlias.create).toHaveBeenCalledOnce();
  });

  it('queues a new ingredient for review instead of publishing it, then a reviewer approves it', async () => {
    const proposal = await caller().createIngredient({ name: 'Paracetamol' });
    expect(proposal).toMatchObject({
      status: 'PENDING',
      operation: 'createIngredient',
      medicineId: null,
      editorId: 'user_a',
    });
    expect(db.ingredient.create).not.toHaveBeenCalled();

    grantCatalogueReview('user_b');
    db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
    await expect(
      caller(['pharmacy-core'], 'ADMIN', 'user_b').decideCatalogueEdit({
        editId: proposal.id,
        decision: 'APPROVE',
      })
    ).resolves.toMatchObject({ status: 'APPROVED', staleEdits: 0 });
    expect(db.ingredient.create).toHaveBeenCalledExactlyOnceWith({
      data: { name: 'Paracetamol' },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'pharmacy.catalogueApproval',
          targetId: proposal.id,
        }),
      })
    );
  });

  it('refuses a duplicate ingredient before queueing it', async () => {
    db.ingredient.findFirst.mockResolvedValue({ id: 'ingredient_a', name: 'Paracetamol' });
    await expect(caller().createIngredient({ name: 'Paracetamol' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });

  it('refuses an administrator whose catalogue review is explicitly denied', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [{ capability: 'pharmacy:catalogue-review', effect: 'DENY' }],
    });
    await expect(
      caller(['pharmacy-core'], 'ADMIN', 'user_b').decideCatalogueEdit({
        editId: 'edit',
        decision: 'APPROVE',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyCatalogueEdit.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an administrator without the catalogue review grant', async () => {
    await expect(
      caller(['pharmacy-core'], 'ADMIN', 'user_b').decideCatalogueEdit({
        editId: 'edit',
        decision: 'REJECT',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('lets a pharmacist who is not an administrator approve and apply a queued edit', async () => {
    db.medicine.findFirst.mockResolvedValue({
      id: 'medicine_a',
      saleable: false,
      updatedAt: new Date('2026-01-01'),
    });
    const proposal = await caller().addAlias({
      medicineId: 'medicine_a',
      type: 'BRAND',
      value: 'Panadol',
    });
    db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      organizationRole:
        where.id === 'pharmacist_b'
          ? { permissions: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }] }
          : null,
      permissionOverrides: [],
    }));

    // The pharmacist still cannot submit catalogue edits of their own.
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE', 'pharmacist_b').addAlias({
        medicineId: 'medicine_a',
        type: 'BRAND',
        value: 'Other',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE', 'pharmacist_b').decideCatalogueEdit({
        editId: proposal.id,
        decision: 'APPROVE',
      })
    ).resolves.toMatchObject({ status: 'APPROVED' });
    expect(db.medicineAlias.create).toHaveBeenCalledOnce();
    expect(db.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'APPROVED', reviewerId: 'pharmacist_b' }),
      })
    );
  });

  it.each(['ACCEPTED', 'CORRECTED', 'REJECTED'])(
    'refuses a new medicine whose author declares its own %s review',
    async (status) => {
      await expect(
        caller().createMedicine({
          productName: 'Medicine',
          productFamily: 'PHARMACEUTICAL',
          provenance: [
            {
              field: 'productName',
              source: 'manual',
              sourceType: 'USER',
              retrievedAt: new Date('2026-01-01'),
              status: status as 'UNREVIEWED',
            },
          ],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.medicine.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a self-named reviewer and direct publication on creation', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            reviewer: 'user_a',
          } as never,
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'FRONT_SHOP',
        saleable: true as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('creates a new medicine as an unreviewed, unsaleable review candidate', async () => {
    await expect(
      caller().createMedicine({ productName: 'Medicine', productFamily: 'FRONT_SHOP' })
    ).resolves.toMatchObject({ id: 'new', saleable: false });
  });
});

describe('catalogue-edit capability, queue access and solo owner (DEV-19)', () => {
  const managerTemplate = {
    organizationRole: {
      permissions: [
        { capability: 'pharmacy:manage', effect: 'ALLOW' },
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ],
    },
    permissionOverrides: [],
  };
  const pharmacistTemplate = {
    organizationRole: {
      permissions: [
        { capability: 'pharmacy:dispense', effect: 'ALLOW' },
        { capability: 'pharmacy:catalogue-review', effect: 'ALLOW' },
      ],
    },
    permissionOverrides: [],
  };
  const edits = [
    ['createIngredient', { name: 'Paracetamol' }],
    ['createMedicine', { productName: 'Medicine', productFamily: 'FRONT_SHOP' }],
    ['proposeCatalogueEdit', { medicineId: 'medicine_a', changes: { productName: 'Changed' } }],
    ['addAlias', { medicineId: 'medicine_a', type: 'BRAND', value: 'Panadol' }],
  ] as const;

  it.each(edits)(
    'refuses %s to an administrator whose assigned role lacks catalogue editing',
    async (name, input) => {
      db.user.findUnique.mockResolvedValue(managerTemplate);
      const procedure = caller()[name] as (value: typeof input) => Promise<unknown>;
      await expect(procedure(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
      expect(db.medicine.create).not.toHaveBeenCalled();
      expect(db.ingredient.create).not.toHaveBeenCalled();
    }
  );

  it.each(edits)(
    'refuses %s to an administrator whose catalogue editing is explicitly denied',
    async (name, input) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: null,
        permissionOverrides: [{ capability: 'pharmacy:catalogue-edit', effect: 'DENY' }],
      });
      const procedure = caller()[name] as (value: typeof input) => Promise<unknown>;
      await expect(procedure(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
      expect(db.medicine.create).not.toHaveBeenCalled();
    }
  );

  it('lets the Owner template submit an edit for review', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });
    await expect(caller().createIngredient({ name: 'Paracetamol' })).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('lets a pharmacist reviewer read the queue but refuses a cashier', async () => {
    db.user.findUnique.mockResolvedValue(pharmacistTemplate);
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE', 'pharmacist_b').catalogueEdits()
    ).resolves.toEqual([]);
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE', 'pharmacist_b').catalogueQueueAccess()
    ).resolves.toEqual({
      canEdit: false,
      canDecide: true,
      ownerPinApproval: false,
      isOwner: false,
    });
    db.pharmacyCatalogueEdit.findMany.mockClear();

    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE', 'cashier_c').catalogueEdits()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyCatalogueEdit.findMany).not.toHaveBeenCalled();
  });

  it('tells an administrator without the review grant that they cannot decide', async () => {
    await expect(caller().catalogueQueueAccess()).resolves.toEqual({
      canEdit: true,
      canDecide: false,
      ownerPinApproval: false,
      isOwner: false,
    });
  });

  describe('owner on the default Owner template with no other reviewer', () => {
    const owner = {
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: {
        key: 'owner',
        isSystem: true,
        permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
      },
      permissionOverrides: [] as { capability: string; effect: string }[],
    };
    const cashier = {
      role: 'EMPLOYEE',
      organizationRole: {
        key: 'cashier',
        isSystem: true,
        permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    };
    const pharmacist = {
      role: 'EMPLOYEE',
      organizationRole: {
        key: 'pharmacist',
        isSystem: true,
        permissions: [
          { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          { capability: 'pharmacy:catalogue-review', effect: 'ALLOW' },
        ],
      },
      permissionOverrides: [],
    };
    type MemberRecord = { role: string; [field: string]: unknown };
    type Member = { id: string; status: string; record: MemberRecord };
    let members: Member[];
    function addMember(id: string, record: MemberRecord, status = 'ACTIVE') {
      members.push({ id, status, record });
    }
    function soloCaller(id = 'owner_a', role = 'ADMIN') {
      return pharmacyMedicineRouter.createCaller({
        db,
        entitlements: {
          organizationId: 'org_a',
          enabledModules: ['pharmacy-core'],
          activeSeats: 1,
          seatLimit: 10,
          modules: [],
          limits: {},
        },
        session: {
          expires: 'later',
          user: { id, role, status: 'ACTIVE', organizationId: 'org_a' },
        },
        organization: null,
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as unknown as TRPCContext);
    }
    beforeEach(() => {
      members = [{ id: 'owner_a', status: 'ACTIVE', record: owner }];
      db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
        const member = members.find((item) => item.id === where.id);
        return member ? { ...member.record, status: member.status } : null;
      });
      db.user.findMany.mockImplementation(
        async ({ where }: { where: { id?: { not?: string }; status?: { in?: string[] } } }) =>
          members
            .filter((item) => item.id !== where.id?.not)
            .filter((item) => !where.status?.in || where.status.in.includes(item.status))
            .map((item) => ({
              id: item.id,
              role: item.record.role,
              status: item.status,
              department: null,
            }))
      );
      db.medicine.findFirst.mockResolvedValue({
        id: 'medicine_a',
        saleable: false,
        updatedAt: new Date('2026-01-01'),
      });
    });

    it('approves their own queued edit only with a fresh PIN, and audits it', async () => {
      const proposal = await soloCaller().addAlias({
        medicineId: 'medicine_a',
        type: 'BRAND',
        value: 'Panadol',
      });
      db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
      await expect(soloCaller().catalogueQueueAccess()).resolves.toEqual({
        canEdit: true,
        canDecide: true,
        ownerPinApproval: true,
        isOwner: true,
      });

      await expect(
        soloCaller().decideCatalogueEdit({ editId: proposal.id, decision: 'APPROVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      mocks.verifyPin.mockResolvedValueOnce('INVALID');
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '0000',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.medicineAlias.create).not.toHaveBeenCalled();

      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
      expect(mocks.verifyPin).toHaveBeenLastCalledWith({
        organizationId: 'org_a',
        userId: 'owner_a',
        pin: '2468',
      });
      expect(db.medicineAlias.create).toHaveBeenCalledOnce();
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'pharmacy.catalogueSoloOwnerApproval',
            metadata: { soloOwner: true, pinVerified: true, reason: 'no other reviewer' },
          }),
        })
      );
    });

    it('needs a fresh PIN even for an edit a former member submitted', async () => {
      db.pharmacyCatalogueEdit.findFirst.mockResolvedValue({
        id: 'edit',
        status: 'PENDING',
        editorId: 'former_b',
        medicineId: 'medicine_a',
        operation: 'UPDATE_MEDICINE',
        changes: { productName: 'Changed' },
        expectedUpdatedAt: new Date('2026-01-01'),
      });
      await expect(
        soloCaller().decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.medicine.updateMany).not.toHaveBeenCalled();
    });

    async function queueOwnerAlias() {
      const proposal = await soloCaller().addAlias({
        medicineId: 'medicine_a',
        type: 'BRAND',
        value: 'Panadol',
      });
      db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
      return proposal;
    }

    it('Owner + Cashier: the owner approves with a fresh PIN, audited as no other reviewer', async () => {
      addMember('cashier_b', cashier);
      const proposal = await queueOwnerAlias();
      await expect(
        soloCaller().decideCatalogueEdit({ editId: proposal.id, decision: 'APPROVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
      expect(db.medicineAlias.create).toHaveBeenCalledOnce();
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'pharmacy.catalogueSoloOwnerApproval',
            actorId: 'owner_a',
            metadata: { soloOwner: true, pinVerified: true, reason: 'no other reviewer' },
          }),
        })
      );
    });

    it('Owner + Pharmacist: the owner is refused and the pharmacist approves', async () => {
      addMember('pharmacist_c', pharmacist);
      const proposal = await queueOwnerAlias();
      await expect(soloCaller().catalogueQueueAccess()).resolves.toEqual({
        canEdit: true,
        canDecide: false,
        ownerPinApproval: false,
        isOwner: true,
      });
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(mocks.verifyPin).not.toHaveBeenCalled();

      await expect(
        soloCaller('pharmacist_c', 'EMPLOYEE').decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
      expect(mocks.verifyPin).not.toHaveBeenCalled();
      expect(db.medicineAlias.create).toHaveBeenCalledOnce();
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'pharmacy.catalogueApproval',
            actorId: 'pharmacist_c',
          }),
        })
      );
    });

    it('Owner + Owner: neither approves their own edit, but each approves the other with their own PIN', async () => {
      addMember('owner_b', owner);
      const proposal = await queueOwnerAlias();
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.verifyPin).not.toHaveBeenCalled();
      expect(db.medicineAlias.create).not.toHaveBeenCalled();

      await expect(
        soloCaller('owner_b').decideCatalogueEdit({ editId: proposal.id, decision: 'APPROVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        soloCaller('owner_b').decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '1357',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
      expect(mocks.verifyPin).toHaveBeenCalledExactlyOnceWith({
        organizationId: 'org_a',
        userId: 'owner_b',
        pin: '1357',
      });
      expect(db.medicineAlias.create).toHaveBeenCalledOnce();
      expect(db.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'APPROVED', reviewerId: 'owner_b' }),
        })
      );
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'pharmacy.catalogueSoloOwnerApproval',
            actorId: 'owner_b',
            metadata: { soloOwner: true, pinVerified: true, reason: 'no other reviewer' },
          }),
        })
      );
    });

    it('lets an owner approve their own edit once the other owner is deactivated', async () => {
      addMember('owner_b', owner, 'DEACTIVATED');
      const proposal = await queueOwnerAlias();
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
    });

    it('falls back to the owner with a PIN once the only other reviewer is deactivated', async () => {
      addMember('pharmacist_c', pharmacist, 'DEACTIVATED');
      addMember('cashier_b', cashier);
      const proposal = await queueOwnerAlias();
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).resolves.toMatchObject({ status: 'APPROVED' });
      expect(mocks.verifyPin).toHaveBeenCalledOnce();
      expect(db.medicineAlias.create).toHaveBeenCalledOnce();
    });

    it('keeps a reviewer who is also the owner from approving their own edit while another reviewer exists', async () => {
      members[0]!.record = {
        ...owner,
        permissionOverrides: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }],
      };
      addMember('pharmacist_c', pharmacist);
      const proposal = await queueOwnerAlias();
      await expect(
        soloCaller().decideCatalogueEdit({
          editId: proposal.id,
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.medicineAlias.create).not.toHaveBeenCalled();
    });

    it('is refused when catalogue review is explicitly denied', async () => {
      db.user.findUnique.mockResolvedValue({
        ...owner,
        permissionOverrides: [{ capability: 'pharmacy:catalogue-review', effect: 'DENY' }],
      });
      await expect(
        soloCaller().decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE', soloPin: '2468' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(mocks.verifyPin).not.toHaveBeenCalled();
    });

    describe('DEV-976: who can approve the caller’s own edits, for the screen', () => {
      const names: Record<string, string> = {
        owner_a: 'Saad Owner',
        owner_b: 'Bilal Ahmed',
        pharmacist_c: 'Ayesha Khan',
        cashier_b: 'Cashier Fixture',
        pharmacist_d: 'Former Pharmacist',
      };
      beforeEach(() => {
        db.user.findMany.mockImplementation(
          async ({
            where,
          }: {
            where: { organizationId?: string; id?: { not?: string }; status?: { in?: string[] } };
          }) =>
            members
              .filter(() => !where.organizationId || where.organizationId === 'org_a')
              .filter((item) => item.id !== where.id?.not)
              .filter((item) => !where.status?.in || where.status.in.includes(item.status))
              .map((item) => ({
                id: item.id,
                name: names[item.id] ?? item.id,
                role: item.record.role,
                status: item.status,
                department: null,
                organizationId: 'org_a',
              }))
        );
      });

      it('Owner alone: may approve their own edit with a PIN, and names nobody', async () => {
        addMember('cashier_b', cashier);
        await expect(soloCaller().catalogueSelfApproval()).resolves.toEqual({
          canSelfApprove: true,
          reviewers: [],
        });
      });

      it('Owner + Owner: may not self-approve and names the other owner, as the decision refuses', async () => {
        addMember('owner_b', owner);
        addMember('cashier_b', cashier);
        await expect(soloCaller().catalogueSelfApproval()).resolves.toEqual({
          canSelfApprove: false,
          reviewers: ['Bilal Ahmed'],
        });
        const proposal = await queueOwnerAlias();
        await expect(
          soloCaller().decideCatalogueEdit({
            editId: proposal.id,
            decision: 'APPROVE',
            soloPin: '2468',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.verifyPin).not.toHaveBeenCalled();
      });

      it('Owner holding the review grant + Pharmacist: names only the active pharmacist', async () => {
        members[0]!.record = {
          ...owner,
          permissionOverrides: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }],
        };
        addMember('pharmacist_c', pharmacist);
        addMember('pharmacist_d', pharmacist, 'DEACTIVATED');
        addMember('cashier_b', cashier);
        const result = await soloCaller().catalogueSelfApproval();
        expect(result).toEqual({ canSelfApprove: false, reviewers: ['Ayesha Khan'] });
        expect(JSON.stringify(result)).not.toMatch(/pharmacist_c|@|Former Pharmacist/);
      });

      it('names a reviewer listed after the first 500 members (DEV-1004)', async () => {
        members[0]!.record = {
          ...owner,
          permissionOverrides: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }],
        };
        for (let n = 0; n < 600; n += 1)
          addMember(`cashier_${String(n).padStart(3, '0')}`, cashier);
        addMember('pharmacist_c', pharmacist);
        // The database pages the members as asked; the reviewer is on the second page.
        const listed = db.user.findMany.getMockImplementation()!;
        db.user.findMany.mockImplementation(
          async (args: { skip?: number; take?: number; where: never }) => {
            const all = (await listed(args)) as unknown[];
            const from = args.skip ?? 0;
            return args.take === undefined ? all.slice(from) : all.slice(from, from + args.take);
          }
        );
        await expect(soloCaller().catalogueSelfApproval()).resolves.toEqual({
          canSelfApprove: false,
          reviewers: ['Ayesha Khan'],
        });
      });

      it('gives a member without the review right nothing', async () => {
        addMember('cashier_b', cashier);
        addMember('pharmacist_c', pharmacist);
        await expect(
          soloCaller('cashier_b', 'EMPLOYEE').catalogueSelfApproval()
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(db.user.findMany).not.toHaveBeenCalled();
      });

      it('gives a caller from another organization nothing', async () => {
        addMember('pharmacist_c', pharmacist);
        const foreign = pharmacyMedicineRouter.createCaller({
          db,
          entitlements: {
            organizationId: 'org_a',
            enabledModules: ['pharmacy-core'],
            activeSeats: 1,
            seatLimit: 10,
            modules: [],
            limits: {},
          },
          session: {
            expires: 'later',
            user: { id: 'owner_a', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_b' },
          },
          organization: null,
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext);
        await expect(foreign.catalogueSelfApproval()).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(db.user.findMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ select: expect.objectContaining({ name: true }) })
        );
      });

      it('marks the edits the caller submitted in the queue', async () => {
        db.pharmacyCatalogueEdit.findMany.mockResolvedValue([
          {
            id: 'mine',
            editorId: 'owner_a',
            expectedUpdatedAt: new Date(0),
            medicine: null,
            operation: 'createStagedMedicines',
            changes: {},
          },
          {
            id: 'theirs',
            editorId: 'pharmacist_c',
            expectedUpdatedAt: new Date(0),
            medicine: null,
            operation: 'createIngredient',
            changes: {},
          },
        ]);
        const edits = await soloCaller().catalogueEdits();
        expect(edits.map((edit) => [edit.id, edit.ownEdit])).toEqual([
          ['mine', true],
          ['theirs', false],
        ]);
      });
    });
  });
});

describe('pharmacy medicine tenant and entitlement boundaries', () => {
  it('rejects a cross-tenant ingredient ID substitution', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: [{ ingredientId: 'ingredient_from_org_b', value: 500, unit: 'mg' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects oversized medicine collections before database work', async () => {
    const strength = { ingredientId: 'ingredient_a', value: 500, unit: 'mg' };
    const assertion = {
      field: 'productName',
      source: 'manual',
      sourceType: 'USER' as const,
      retrievedAt: new Date('2026-01-01'),
      status: 'UNREVIEWED' as const,
    };

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: Array.from({ length: 21 }, () => strength),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: Array.from({ length: 21 }, () => assertion),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.ingredient.findFirst).not.toHaveBeenCalled();
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('accepts medicine collections and ingredient IDs at their limits', async () => {
    const ingredientId = 'i'.repeat(200);
    db.ingredient.findFirst.mockResolvedValue({ id: ingredientId });
    const assertion = {
      field: 'productName',
      source: 'manual',
      sourceType: 'USER' as const,
      retrievedAt: new Date('2026-01-01'),
      status: 'UNREVIEWED' as const,
    };

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: Array.from({ length: 20 }, () => ({
          ingredientId,
          value: 500,
          unit: 'mg',
        })),
        provenance: Array.from({ length: 20 }, () => assertion),
      })
    ).resolves.toMatchObject({ id: 'new' });

    expect(db.ingredient.findFirst).toHaveBeenCalledTimes(20);
    expect(db.medicine.create).toHaveBeenCalledOnce();
  });

  it.each([
    ['string', 'x'.repeat(2_000)],
    ['array', Array.from({ length: 20 }, () => 'value')],
    [
      'object and keys',
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [String(index).padStart(100, 'k'), index])
      ),
    ],
    ['nesting', [[[['value']]]]],
    [
      'aggregate nodes',
      Array.from({ length: 20 }, (_, row) =>
        Array.from({ length: 20 }, (_, column) =>
          Array.from({ length: row * 20 + column < 179 ? 2 : 1 }, () => null)
        )
      ),
    ],
    ['aggregate characters', Array.from({ length: 10 }, () => 'x'.repeat(2_000))],
  ])('persists a provenance assertedValue at the %s limit', async (_, value) => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: value,
          },
        ],
      })
    ).resolves.toMatchObject({ id: 'new' });

    expect(db.medicine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provenance: { create: [expect.objectContaining({ assertedValue: value })] },
        }),
      })
    );
  });

  it.each([
    ['string', 'x'.repeat(2_001)],
    ['array', Array.from({ length: 21 }, () => 'value')],
    [
      'object',
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, index])),
    ],
    ['nesting', [[[[['too deep']]]]]],
  ])('rejects an oversized provenance assertedValue %s before database work', async (_, value) => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: value,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects provenance assertedValue trees over the aggregate node budget', async () => {
    const leaves = Array.from({ length: 20 }, () => 'value');
    const branch = Array.from({ length: 20 }, () => leaves);
    const broadTree = Array.from({ length: 20 }, () => branch);

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: broadTree,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects provenance assertedValue trees over the aggregate character budget', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: Array.from({ length: 11 }, () => 'x'.repeat(2_000)),
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects an oversized ingredient ID before database work', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: [{ ingredientId: 'x'.repeat(201), value: 500, unit: 'mg' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.ingredient.findFirst).not.toHaveBeenCalled();
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects oversized assertion publication before opening a transaction', async () => {
    // DEV-923: reviewing and publishing need the exact catalogue review grant.
    grantCatalogueReview('user_a');
    await expect(
      caller().publishAssertions({
        assertionIds: Array.from({ length: 21 }, (_, index) => `assertion_${index}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().publishAssertions({ assertionIds: ['x'.repeat(201)] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects oversized review decision IDs before opening a transaction', async () => {
    grantCatalogueReview('user_a');
    const oversizedId = 'x'.repeat(201);

    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'ACCEPT',
        medicineIds: [oversizedId],
        payload: { assertionIds: ['assertion'] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'ACCEPT',
        medicineIds: ['medicine'],
        payload: { assertionIds: [oversizedId] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'CORRECT',
        medicineIds: ['medicine'],
        payload: {
          assertionIds: ['assertion'],
          corrections: [{ assertionId: oversizedId, value: 'corrected' }],
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant presentation ID substitution', async () => {
    await expect(
      caller().createPackLevel({
        presentationId: 'presentation_from_org_b',
        versionGroupId: 'box',
        level: 'BOX',
        unitsPerParent: 20,
        effectiveFrom: new Date('2030-01-01'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.packLevel.create).not.toHaveBeenCalled();
  });

  it('refuses a non-admin printed MRP rounding rule, since it lowers posted prices', async () => {
    db.packLevel.findFirst.mockResolvedValue({
      id: 'pack_a',
      presentation: { medicineId: 'medicine_a' },
    });
    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE').recordPrintedMrp({
        packLevelId: 'pack_a',
        batchReference: 'B-1',
        printedMrpMinor: 1000,
        roundingIncrementMinor: 60,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicinePackMrp.create).not.toHaveBeenCalled();
  });

  it('holds a draft printed MRP rounding rule until another administrator approves it', async () => {
    grantCatalogueReview('user_b');
    db.packLevel.findFirst.mockResolvedValue({
      id: 'pack_a',
      presentation: { medicineId: 'medicine_a' },
    });
    db.medicine.findFirst.mockResolvedValue({
      id: 'medicine_a',
      saleable: false,
      updatedAt: new Date('2026-01-01'),
    });
    const proposal = await caller().recordPrintedMrp({
      packLevelId: 'pack_a',
      batchReference: 'B-1',
      printedMrpMinor: 1000,
      roundingIncrementMinor: 5,
    });
    expect(proposal).toMatchObject({ status: 'PENDING' });
    expect(db.medicinePackMrp.create).not.toHaveBeenCalled();
    db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(proposal);
    await caller(['pharmacy-core'], 'ADMIN', 'user_b').decideCatalogueEdit({
      editId: proposal.id,
      decision: 'APPROVE',
    });
    await expect(db.medicinePackMrp.create.mock.results[0]!.value).resolves.toMatchObject({
      packLevelId: 'pack_a',
      roundingIncrementMinor: 5,
    });
  });

  it('maps the public router prefix to the pharmacy-core entitlement', () => {
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });
});

describe('non-drug retail catalogue fields (#718)', () => {
  it('creates a front-shop item with a shop retail price, category and EAN-13', async () => {
    await caller().createMedicine({
      productName: 'Baby lotion 200 ml',
      productFamily: 'FRONT_SHOP',
      presentation: { presentation: 'Bottle 200 ml' },
      retailPriceMinor: 45_000,
      retailCategory: ' Baby care ',
      ean13: '4006381333931',
    });
    const data = db.medicine.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      productFamily: 'FRONT_SHOP',
      retailPriceMinor: 45_000,
      retailCategory: 'Baby care',
      presentations: {
        create: {
          presentation: 'Bottle 200 ml',
          barcodes: { create: { type: 'GTIN', code: '4006381333931' } },
        },
      },
    });
    expect(data).not.toHaveProperty('ean13');
  });

  it('refuses a shop retail price on a medicine and an invalid EAN-13', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Syrup',
        productFamily: 'PHARMACEUTICAL',
        retailPriceMinor: 9_000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createMedicine({
        productName: 'Shampoo',
        productFamily: 'FRONT_SHOP',
        presentation: { presentation: 'Bottle' },
        ean13: '4006381333932',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('sets retail details on a front-shop item but refuses a medicine', async () => {
    db.medicine.findFirst.mockResolvedValueOnce({ id: 'soap', productFamily: 'FRONT_SHOP' });
    await caller().setRetailDetails({
      medicineId: 'soap',
      retailPriceMinor: 12_000,
      retailCategory: 'FMCG',
    });
    expect(db.pharmacyCatalogueEdit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        medicineId: 'soap',
        editorId: 'user_a',
        changes: { retailPriceMinor: 12_000, retailCategory: 'FMCG' },
      }),
    });
    expect(db.medicine.update).not.toHaveBeenCalled();

    db.medicine.findFirst.mockResolvedValueOnce({ id: 'syrup', productFamily: 'PHARMACEUTICAL' });
    await expect(
      caller().setRetailDetails({
        medicineId: 'syrup',
        retailPriceMinor: 9_000,
        retailCategory: null,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyCatalogueEdit.create).toHaveBeenCalledTimes(1);
    expect(db.medicine.update).not.toHaveBeenCalled();
  });
});

describe('DEV-766 catalogue review separation and immutable evidence', () => {
  beforeEach(() => grantCatalogueReview('user_a'));
  const original = {
    id: 'assertion',
    medicineId: 'medicine_a',
    editorId: 'user_b',
    supersededBy: [],
    field: 'productName',
    source: 'Owner file',
    sourceType: 'IMPORT',
    retrievedAt: new Date('2026-01-01'),
    status: 'UNREVIEWED',
    confidence: null,
    assertedValue: {
      value: 'Original',
      connectorId: 'manual-file',
      sourceLabel: 'Fixture',
      batchId: 'batch',
      rowSourceKey: 'row',
      rights: {
        acquisition: 'Fixture',
        cache: 'Fixture',
        redistribution: 'None',
        deletion: 'Fixture',
      },
      blockingIssues: [],
    },
  };
  const reviewInput = {
    duplicateKey: 'fixture',
    medicineIds: ['medicine_a'],
    payload: { assertionIds: ['assertion'] },
  };
  it.each(['ACCEPT', 'CORRECT'] as const)(
    'refuses an editor approving their own %s without solo-owner PIN evidence',
    async (action) => {
      db.medicineProvenance.findMany.mockResolvedValue([{ ...original, editorId: 'user_a' }]);
      await expect(
        caller().recordReviewDecision(
          action === 'CORRECT'
            ? {
                ...reviewInput,
                action,
                payload: {
                  ...reviewInput.payload,
                  corrections: [{ assertionId: 'assertion', value: 'Changed' }],
                },
              }
            : { ...reviewInput, action }
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.medicineProvenance.create).not.toHaveBeenCalled();
      expect(db.medicineReviewDecision.create).not.toHaveBeenCalled();
    }
  );
  it('appends acceptance by a different reviewer, retaining the source assertion', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([original]);
    await caller().recordReviewDecision({ ...reviewInput, action: 'ACCEPT' });
    expect(db.medicineProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supersedesId: 'assertion',
        status: 'ACCEPTED',
        editorId: 'user_b',
        reviewer: 'user_a',
        assertedValue: original.assertedValue,
      }),
    });
    expect(db.medicineProvenance.updateMany).not.toHaveBeenCalled();
    expect(db.medicineReviewDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payload: { assertionIds: ['new'] } }),
    });
  });
  it('holds a reviewer correction as a new edit instead of letting the reviewer approve it', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([original]);
    await caller().recordReviewDecision({
      ...reviewInput,
      action: 'CORRECT',
      payload: {
        assertionIds: ['assertion'],
        corrections: [{ assertionId: 'assertion', value: 'Changed' }],
      },
    });
    expect(db.medicineProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supersedesId: 'assertion',
        status: 'UNREVIEWED',
        editorId: 'user_a',
        reviewer: null,
        sourceType: 'USER',
        assertedValue: expect.objectContaining({ value: 'Changed' }),
      }),
    });
    expect(db.medicineProvenance.updateMany).not.toHaveBeenCalled();
  });
  it('refuses acceptance when historical editor evidence is unavailable', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([{ ...original, editorId: null }]);
    await expect(
      caller().recordReviewDecision({ ...reviewInput, action: 'ACCEPT' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicineProvenance.create).not.toHaveBeenCalled();
  });
  it('refuses to review a source assertion already superseded by review evidence', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([
      { ...original, supersededBy: [{ id: 'reviewed' }] },
    ]);
    await expect(
      caller().recordReviewDecision({ ...reviewInput, action: 'ACCEPT' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicineProvenance.create).not.toHaveBeenCalled();
  });
  it.each([
    [
      'addAlias',
      { medicineId: 'medicine_a', type: 'BRAND', value: 'Proposed alias' },
      'medicineAlias',
    ],
    [
      'createPackLevel',
      {
        presentationId: 'presentation_a',
        versionGroupId: 'group',
        level: 'BOX',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
      'packLevel',
    ],
    [
      'revisePackLevel',
      {
        id: 'pack_a',
        unitsPerParent: 20,
        effectiveFrom: new Date('2026-01-01'),
      },
      'packLevel',
    ],
    [
      'addBarcode',
      { presentationId: 'presentation_a', type: 'GTIN', code: '123' },
      'medicineBarcode',
    ],
    ['setPackBarcode', { packLevelId: 'pack_a', code: '123' }, 'medicineBarcode'],
    [
      'recordPrintedMrp',
      {
        packLevelId: 'pack_a',
        batchReference: 'Fixture',
        printedMrpMinor: 1000,
      },
      'medicinePackMrp',
    ],
  ] as const)('holds published %s changes for approval', async (name, input, model) => {
    db.medicine.findFirst.mockResolvedValue({
      id: 'medicine_a',
      saleable: true,
      updatedAt: new Date('2026-01-01'),
    });
    db.presentation.findFirst.mockResolvedValue({
      id: 'presentation_a',
      medicineId: 'medicine_a',
    });
    const pack = {
      id: 'pack_a',
      presentationId: 'presentation_a',
      presentation: { medicineId: 'medicine_a' },
      barcodes: [],
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: null,
    };
    // The duplicate-pack lookup (by level) finds nothing; lookups by id find the pack.
    db.packLevel.findFirst.mockImplementation(async ({ where }: { where: object }) =>
      'level' in where ? null : pack
    );
    const procedure = caller()[name] as (value: typeof input) => Promise<unknown>;
    await expect(procedure(input)).resolves.toMatchObject({
      status: 'PENDING',
    });
    expect(db.pharmacyCatalogueEdit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ editorId: 'user_a', operation: name }),
    });
    expect(db[model].create).not.toHaveBeenCalled();
    expect(db.packLevel.update).not.toHaveBeenCalled();
  });
});
