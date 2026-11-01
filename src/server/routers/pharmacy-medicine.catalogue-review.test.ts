import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
import type { AuditDetail } from '../audit';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE'; rules: Rule[] | null; overrides?: Rule[] };

const allow = (...capabilities: string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));

/** Users shaped like the pharmacy role templates (src/lib/vertical-catalog.ts). */
const PEOPLE: Record<string, Person> = {
  cashier: {
    id: 'cashier',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:counter', 'pharmacy:orders'),
  },
  adminCashier: {
    id: 'admin-cashier',
    role: 'ADMIN',
    rules: allow('pharmacy:counter', 'pharmacy:orders'),
  },
  pharmacist: {
    id: 'pharmacist',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'),
  },
  pharmacist2: {
    id: 'pharmacist-2',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'),
  },
  manager: {
    id: 'manager',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement'),
  },
  owner: {
    id: 'owner',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:*', 'reports:operational', 'reports:financial'),
  },
  editor: { id: 'editor', role: 'EMPLOYEE', rules: allow('pharmacy:catalogue-edit') },
  deniedPharmacist: {
    id: 'denied-pharmacist',
    role: 'EMPLOYEE',
    rules: allow('pharmacy:catalogue-review'),
    overrides: [{ capability: 'pharmacy:catalogue-edit', effect: 'DENY' }],
  },
  // A tenant administrator without an organization role (the legacy solo owner).
  admin: { id: 'admin', role: 'ADMIN', rules: null },
};

const PACK = {
  id: 'pack-1',
  presentationId: 'presentation-1',
  parentPackLevelId: null,
  versionGroupId: 'group-1',
  version: 1,
  level: 'STRIP',
  unitsPerParent: 10,
  effectiveTo: null,
};

const EDITS = [
  ['createIngredient', 'INGREDIENT', { name: 'Paracetamol' }, 'ingredient'],
  [
    'createMedicine',
    'MEDICINE',
    { productName: 'Panadol', productFamily: 'PHARMACEUTICAL' },
    'medicine',
  ],
  [
    'createPackLevel',
    'PACK_LEVEL',
    {
      presentationId: 'presentation-1',
      versionGroupId: 'group-2',
      level: 'BOX',
      unitsPerParent: 30,
      effectiveFrom: new Date('2026-11-01T00:00:00Z'),
    },
    'packLevel',
  ],
  [
    'revisePackLevel',
    'PACK_REVISION',
    { id: 'pack-1', unitsPerParent: 20, effectiveFrom: new Date('2026-12-01T00:00:00Z') },
    'packLevel',
  ],
  [
    'recordPrintedMrp',
    'PRINTED_MRP',
    { packLevelId: 'pack-1', batchReference: 'B-1', printedMrpMinor: 12_000 },
    'medicinePackMrp',
  ],
  [
    'addBarcode',
    'BARCODE',
    { presentationId: 'presentation-1', packLevelId: 'pack-1', type: 'GTIN', code: '8961234' },
    'medicineBarcode',
  ],
  [
    'addAlias',
    'ALIAS',
    { medicineId: 'medicine-1', type: 'BRAND', value: 'Panadol' },
    'medicineAlias',
  ],
] as const;

type EditName = (typeof EDITS)[number][0];
type Delegate = (typeof EDITS)[number][3];

function makeDb(members: Person[]) {
  const changes: Array<Record<string, unknown>> = [];
  const catalogue = () => ({
    findFirst: vi.fn(),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: 'published-1', ...data })),
    update: vi.fn(async ({ data }: { data: object }) => ({ ...PACK, ...data })),
  });
  const db = {
    changes,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const person = Object.values(PEOPLE).find((item) => item.id === where.id);
        if (!person) return null;
        return {
          organizationRole: person.rules ? { permissions: person.rules } : null,
          permissionOverrides: person.overrides ?? [],
        };
      }),
      findMany: vi.fn(async ({ where }: { where: { id: { not: string } } }) =>
        members
          .filter((member) => member.id !== where.id.not)
          .map(({ id, role }) => ({ id, role, department: null, status: 'ACTIVE' }))
      ),
    },
    ingredient: catalogue(),
    medicine: catalogue(),
    presentation: catalogue(),
    packLevel: catalogue(),
    medicinePackMrp: catalogue(),
    medicineBarcode: catalogue(),
    medicineAlias: catalogue(),
    pharmacyCatalogueChange: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `change-${changes.length + 1}`,
          status: 'PENDING',
          proposedAt: new Date('2026-11-01T10:00:00Z'),
          reviewedBy: null,
          reviewMode: null,
          publishedRecordId: null,
          ...data,
        };
        changes.push(row);
        return { ...row };
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = changes.find((item) => item.id === where.id);
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { status: string } }) =>
        changes.filter((item) => item.status === where.status).map((item) => ({ ...item }))
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status: string }; data: object }) => {
          const row = changes.find((item) => item.id === where.id && item.status === where.status);
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        }
      ),
    },
  };
  db.presentation.findFirst.mockResolvedValue({ id: 'presentation-1', presentation: '10 tablets' });
  db.packLevel.findFirst.mockResolvedValue(PACK);
  db.medicine.findFirst.mockResolvedValue({ id: 'medicine-1' });
  return Object.assign(db, {
    $transaction: vi.fn(async (run: (tx: typeof db) => unknown) => run(db)),
  });
}

type Db = ReturnType<typeof makeDb>;

function caller(db: Db, person: Person) {
  const ctx = {
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: person.id, role: person.role, status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as AuditDetail },
  };
  return {
    audit: ctx.audit,
    api: pharmacyMedicineRouter.createCaller(ctx as unknown as TRPCContext),
  };
}

function propose(db: Db, person: Person, name: EditName) {
  const [, , input] = EDITS.find(([edit]) => edit === name)!;
  const { api } = caller(db, person);
  const run = api[name] as unknown as (value: unknown) => Promise<{ id: string; status: string }>;
  return run(input);
}

function writes(db: Db, delegate: Delegate) {
  return db[delegate].create.mock.calls.length;
}

const everyone = Object.values(PEOPLE);

describe('catalogue edits need the catalogue-edit capability', () => {
  let db: Db;
  beforeEach(() => {
    db = makeDb(everyone);
  });

  it.each(EDITS.map(([name, , , delegate]) => [name, delegate] as const))(
    'refuses a cashier on %s before anything is stored',
    async (name, delegate) => {
      await expect(propose(db, PEOPLE.cashier, name)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyCatalogueChange.create).not.toHaveBeenCalled();
      expect(writes(db, delegate)).toBe(0);
    }
  );

  it.each(EDITS.map(([name]) => [name] as const))(
    'refuses a tenant administrator whose assigned role is Cashier on %s',
    async (name) => {
      await expect(propose(db, PEOPLE.adminCashier, name)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.pharmacyCatalogueChange.create).not.toHaveBeenCalled();
    }
  );

  it('honours an explicit catalogue-edit DENY over the reviewer equivalent', async () => {
    await expect(propose(db, PEOPLE.deniedPharmacist, 'addAlias')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyCatalogueChange.create).not.toHaveBeenCalled();
  });

  it.each([
    ['catalogue-edit grant', PEOPLE.editor],
    ['Owner (pharmacy:*)', PEOPLE.owner],
    ['Pharmacist (catalogue-review)', PEOPLE.pharmacist],
    ['Manager (pharmacy:manage)', PEOPLE.manager],
    ['tenant administrator without a role', PEOPLE.admin],
  ])('lets the %s propose an edit', async (_, person) => {
    await expect(propose(db, person, 'createIngredient')).resolves.toMatchObject({
      status: 'PENDING',
      kind: 'INGREDIENT',
      proposedBy: person.id,
    });
  });
});

describe('a catalogue edit stays pending until reviewed', () => {
  let db: Db;
  beforeEach(() => {
    db = makeDb(everyone);
  });

  it.each(EDITS.map(([name, kind, , delegate]) => [name, kind, delegate] as const))(
    '%s is stored as a pending change and published only on approval',
    async (name, kind, delegate) => {
      const change = await propose(db, PEOPLE.pharmacist, name);
      expect(change).toMatchObject({ status: 'PENDING', kind, proposedBy: 'pharmacist' });
      expect(writes(db, delegate)).toBe(0);

      const listed = await caller(db, PEOPLE.pharmacist2).api.catalogueChanges();
      expect(listed.changes).toEqual([
        expect.objectContaining({ id: change.id, status: 'PENDING', canDecide: true }),
      ]);
      expect(writes(db, delegate)).toBe(0);

      const reviewer = caller(db, PEOPLE.pharmacist2);
      await expect(
        reviewer.api.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' })
      ).resolves.toMatchObject({
        status: 'APPROVED',
        proposedBy: 'pharmacist',
        reviewedBy: 'pharmacist-2',
        reviewMode: 'SECOND_REVIEWER',
        publishedRecordId: 'published-1',
      });
      expect(writes(db, delegate)).toBe(1);
      expect(reviewer.audit.detail).toMatchObject({
        action: 'pharmacy.catalogue-change.approve',
        targetType: 'PharmacyCatalogueChange',
        targetId: change.id,
        metadata: expect.objectContaining({
          proposedBy: 'pharmacist',
          reviewedBy: 'pharmacist-2',
          reviewMode: 'SECOND_REVIEWER',
        }),
      });
    }
  );

  it('publishes the reviewed dates and values the proposer submitted', async () => {
    const change = await propose(db, PEOPLE.pharmacist, 'createPackLevel');
    await caller(db, PEOPLE.pharmacist2).api.decideCatalogueChange({
      changeId: change.id,
      decision: 'APPROVE',
    });
    expect(db.packLevel.create).toHaveBeenCalledWith({
      data: {
        presentationId: 'presentation-1',
        versionGroupId: 'group-2',
        level: 'BOX',
        unitsPerParent: 30,
        effectiveFrom: new Date('2026-11-01T00:00:00Z'),
        version: 1,
      },
    });
  });

  it('records the proposer in the audit detail', async () => {
    const proposer = caller(db, PEOPLE.pharmacist);
    const change = await proposer.api.addBarcode({
      presentationId: 'presentation-1',
      type: 'GTIN',
      code: '8961234',
    });
    expect(proposer.audit.detail).toMatchObject({
      action: 'pharmacy.catalogue-change.propose',
      targetId: change.id,
      metadata: expect.objectContaining({ proposedBy: 'pharmacist', status: 'PENDING' }),
    });
  });

  it('rejecting a change writes nothing to the catalogue', async () => {
    const change = await propose(db, PEOPLE.pharmacist, 'recordPrintedMrp');
    await expect(
      caller(db, PEOPLE.pharmacist2).api.decideCatalogueChange({
        changeId: change.id,
        decision: 'REJECT',
        note: 'MRP does not match the pack',
      })
    ).resolves.toMatchObject({
      status: 'REJECTED',
      reviewedBy: 'pharmacist-2',
      publishedRecordId: null,
    });
    expect(writes(db, 'medicinePackMrp')).toBe(0);
  });

  it('decides a change only once', async () => {
    const change = await propose(db, PEOPLE.pharmacist, 'addAlias');
    const reviewer = caller(db, PEOPLE.pharmacist2).api;
    await reviewer.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' });
    await expect(
      reviewer.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(writes(db, 'medicineAlias')).toBe(1);
  });

  it.each([
    ['cashier', PEOPLE.cashier],
    ['manager', PEOPLE.manager],
    ['catalogue editor', PEOPLE.editor],
    ['Owner (wildcard grants never include catalogue review)', PEOPLE.owner],
  ])('refuses a %s as reviewer', async (_, person) => {
    const change = await propose(db, PEOPLE.pharmacist, 'createIngredient');
    await expect(
      caller(db, person).api.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes(db, 'ingredient')).toBe(0);
    expect(db.changes[0]).toMatchObject({ status: 'PENDING' });
  });

  it('re-validates tenant references when publishing', async () => {
    const change = await propose(db, PEOPLE.pharmacist, 'addBarcode');
    db.presentation.findFirst.mockResolvedValue(null);
    await expect(
      caller(db, PEOPLE.pharmacist2).api.decideCatalogueChange({
        changeId: change.id,
        decision: 'APPROVE',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes(db, 'medicineBarcode')).toBe(0);
    expect(db.changes[0]).toMatchObject({ status: 'PENDING' });
  });

  it('refuses a barcode or alias that points outside the workspace', async () => {
    db.presentation.findFirst.mockResolvedValue(null);
    db.medicine.findFirst.mockResolvedValue(null);
    await expect(propose(db, PEOPLE.pharmacist, 'addBarcode')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(propose(db, PEOPLE.pharmacist, 'addAlias')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyCatalogueChange.create).not.toHaveBeenCalled();
  });
});

describe('self-review is refused except for a solo owner', () => {
  it('refuses a reviewer deciding their own change', async () => {
    const db = makeDb(everyone);
    const change = await propose(db, PEOPLE.pharmacist, 'createMedicine');
    const self = caller(db, PEOPLE.pharmacist).api;
    await expect(
      self.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('You proposed'),
    });
    await expect(
      self.decideCatalogueChange({ changeId: change.id, decision: 'REJECT' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes(db, 'medicine')).toBe(0);
    expect(db.changes[0]).toMatchObject({ status: 'PENDING' });
    const listed = await self.catalogueChanges();
    expect(listed.changes[0]).toMatchObject({ canDecide: false });
  });

  it('refuses an administrator self-review while another reviewer exists', async () => {
    const db = makeDb([PEOPLE.admin, PEOPLE.pharmacist]);
    const change = await propose(db, PEOPLE.admin, 'createPackLevel');
    await expect(
      caller(db, PEOPLE.admin).api.decideCatalogueChange({
        changeId: change.id,
        decision: 'APPROVE',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes(db, 'packLevel')).toBe(0);
  });

  it('lets a solo owner approve their own change directly', async () => {
    // The only other member is a cashier, who can never review.
    const db = makeDb([PEOPLE.admin, PEOPLE.cashier]);
    const change = await propose(db, PEOPLE.admin, 'addAlias');
    expect(writes(db, 'medicineAlias')).toBe(0);
    const owner = caller(db, PEOPLE.admin);
    const listed = await owner.api.catalogueChanges();
    expect(listed.viewer).toMatchObject({ soloOwner: true });
    expect(listed.changes[0]).toMatchObject({ canDecide: true });
    await expect(
      owner.api.decideCatalogueChange({ changeId: change.id, decision: 'APPROVE' })
    ).resolves.toMatchObject({
      status: 'APPROVED',
      proposedBy: 'admin',
      reviewedBy: 'admin',
      reviewMode: 'SOLO_OWNER',
    });
    expect(writes(db, 'medicineAlias')).toBe(1);
    expect(owner.audit.detail.metadata).toMatchObject({
      proposedBy: 'admin',
      reviewedBy: 'admin',
      reviewMode: 'SOLO_OWNER',
    });
  });

  it('does not treat a non-administrator as a solo owner', async () => {
    const db = makeDb([PEOPLE.pharmacist]);
    const change = await propose(db, PEOPLE.pharmacist, 'createIngredient');
    await expect(
      caller(db, PEOPLE.pharmacist).api.decideCatalogueChange({
        changeId: change.id,
        decision: 'APPROVE',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a cashier the review queue', async () => {
    const db = makeDb(everyone);
    await expect(caller(db, PEOPLE.cashier).api.catalogueChanges()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
