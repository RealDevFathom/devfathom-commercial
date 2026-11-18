import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: string) => Promise<boolean>>(async () => true),
  hasModule: vi.fn(() => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string; status?: string }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    status: user.status ?? null,
  }),
}));
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

import { DRAP_REGISTRY_RIGHTS } from '@/lib/pharmacy/reference-connectors';
import type { TRPCContext } from '../trpc';
import { pharmacyMedicineRouter } from './pharmacy-medicine';

function caller(db: object) {
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org-a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'editor-a', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

// Synthetic DRAP-shaped fixture; not a real registration.
const referenceRow = {
  id: 'ref-1',
  inputDigest: 'digest-a',
  rowSourceKey: 'drap-SYN-0001',
  createdAt: new Date('2030-01-02'),
  payload: {
    values: {
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      drapRegistrationNumber: 'SYN-0001',
      rx: 'true',
      controlled: 'true',
    },
    source: {
      connectorId: 'drap-registry',
      label: 'DRAP registry file',
      fileName: 'synthetic-drap.csv',
      batchId: 'batch-synthetic',
      rowSourceKey: 'drap-SYN-0001',
      rights: DRAP_REGISTRY_RIGHTS,
    },
  },
};

function db(options: { duplicate?: boolean; reference?: typeof referenceRow | null } = {}) {
  return {
    pharmacyReferenceConnector: { findFirst: vi.fn(async () => ({ id: 'conn-drap' })) },
    pharmacyReferenceConnectorProposal: {
      findFirst: vi.fn(async () =>
        options.reference === undefined ? referenceRow : options.reference
      ),
      findMany: vi.fn(async () => [referenceRow]),
    },
    medicine: {
      findFirst: vi.fn(async () => (options.duplicate ? { id: 'existing' } : null)),
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args: { data: { productName: string } }) => ({
        id: 'medicine-new',
        productName: args.data.productName,
        saleable: false,
      })),
    },
  };
}

const draft = {
  productName: 'Synthamol',
  strength: '500 mg',
  dosageForm: 'Tablet',
  pack: '10 tablets',
  drapRegistrationNumber: 'SYN-0001',
  rx: true,
  controlled: true,
};

beforeEach(() => {
  mocks.can.mockReset();
  mocks.can.mockImplementation(async () => true);
});

describe('DEV-683 add-medicine DRAP auto-fill boundary', () => {
  it('refuses search and save to a member without catalogue-edit rights', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'pharmacy:catalogue-edit');
    const store = db();
    await expect(caller(store).drapReferenceSearch({ query: 'synth' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(store).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.pharmacyReferenceConnectorProposal.findMany).not.toHaveBeenCalled();
    expect(store.medicine.create).not.toHaveBeenCalled();
  });

  it('searches the caller’s own organisation only', async () => {
    const store = db();
    const result = await caller(store).drapReferenceSearch({ query: 'SYN-0001' });
    expect(result.hasReferenceData).toBe(true);
    expect(result.matches[0]?.values).toEqual({
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      drapRegistrationNumber: 'SYN-0001',
      rx: true,
      controlled: true,
    });
    expect(store.pharmacyReferenceConnectorProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a' }) })
    );
  });

  it('saves a confirmed DRAP draft as non-saleable with unreviewed regulator provenance', async () => {
    const store = db();
    await expect(
      caller(store).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' })
    ).resolves.toMatchObject({ id: 'medicine-new', saleable: false });
    const data = store.medicine.create.mock.calls[0]![0].data as unknown as {
      saleable: boolean;
      rx: boolean;
      controlled: boolean;
      provenance: { create: Array<{ field: string; sourceType: string; status: string }> };
    };
    expect(data).toMatchObject({ saleable: false, rx: true, controlled: true });
    expect(Object.keys(data).some((key) => /price|mrp/i.test(key))).toBe(false);
    const rx = data.provenance.create.find((item) => item.field === 'rx');
    expect(rx).toMatchObject({ sourceType: 'REGULATOR', status: 'UNREVIEWED' });
    expect(data.provenance.create.every((item) => item.status === 'UNREVIEWED')).toBe(true);
  });

  it('refuses prescription-only or controlled flags that differ from the reference row', async () => {
    for (const change of [{ rx: false }, { controlled: false }]) {
      const store = db();
      await expect(
        caller(store).addMedicineDraft({ ...draft, ...change, drapReferenceId: 'ref-1' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(store.medicine.create).not.toHaveBeenCalled();
    }
  });

  it('refuses a changed registration number, an unknown row and a duplicate medicine', async () => {
    const changed = db();
    await expect(
      caller(changed).addMedicineDraft({
        ...draft,
        drapRegistrationNumber: 'SYN-9999',
        drapReferenceId: 'ref-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const missing = db({ reference: null });
    await expect(
      caller(missing).addMedicineDraft({ ...draft, drapReferenceId: 'ref-other-tenant' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const duplicate = db({ duplicate: true });
    await expect(caller(duplicate).addMedicineDraft(draft)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    for (const store of [changed, missing, duplicate])
      expect(store.medicine.create).not.toHaveBeenCalled();
  });

  it('never accepts a price on the draft', async () => {
    const store = db();
    await expect(
      caller(store).addMedicineDraft({ ...draft, retailPriceMinor: 1200 } as typeof draft)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(store.medicine.create).not.toHaveBeenCalled();
  });

  it('keeps manual entry working with no reference row', async () => {
    const store = db();
    await caller(store).addMedicineDraft({ ...draft, rx: false, controlled: false });
    const data = store.medicine.create.mock.calls[0]![0].data as unknown as {
      provenance: { create: Array<{ sourceType: string }> };
    };
    expect(data.provenance.create.every((item) => item.sourceType === 'USER')).toBe(true);
  });
});
