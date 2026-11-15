import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  create: vi.fn(),
  findMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';

function caller() {
  return pharmacyDispensingRouter.createCaller({
    db: {
      pharmacySubstitutionRecord: { create: mocks.create },
      pharmacyPharmacistReviewItem: { findMany: mocks.findMany },
    },
    entitlements: { enabledModules: ['pharmacy-core'] },
    session: {
      expires: 'later',
      user: { id: 'counter-user', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('AI-05 pharmacist gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });

  it('refuses accepting a proposal on an Rx line without pharmacist capability', async () => {
    await expect(
      caller().recordSubstitution({
        prescriptionLineId: 'rx-line',
        saleLineId: 'sale-line',
        prescribedPresentationId: 'prescribed',
        suppliedPresentationId: 'supplied',
        equivalenceBasis: 'Exact ingredient, strength, form and route',
        patientCommunication: 'Patient accepted after pharmacist explanation.',
        jurisdictionRuleRef: 'RX-04',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('DEV-35 substitution workspace access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });
  const grant = (...held: string[]) =>
    mocks.can.mockImplementation((async (_subject: unknown, action: string) =>
      held.includes(action)) as unknown as () => Promise<boolean>);

  it('refuses a member with neither dispense nor safety', async () => {
    grant('reports:operational');
    await expect(caller().substitutionWorkspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('opens review-only for a Pharmacy Safety holder', async () => {
    grant('pharmacy:safety');
    await expect(caller().substitutionWorkspace()).resolves.toEqual({
      canRecord: false,
      canViewPatients: false,
      lines: [],
    });
  });

  it('lets a dispensing pharmacist record', async () => {
    grant('pharmacy:dispense');
    await expect(caller().substitutionWorkspace()).resolves.toEqual({
      canRecord: true,
      canViewPatients: false,
      lines: [],
    });
  });

  it('still refuses recording to a safety-only holder', async () => {
    grant('pharmacy:safety');
    await expect(
      caller().recordSubstitution({
        prescriptionLineId: 'rx-line',
        saleLineId: 'sale-line',
        prescribedPresentationId: 'prescribed',
        suppliedPresentationId: 'supplied',
        equivalenceBasis: 'Exact ingredient, strength, form and route',
        patientCommunication: 'Patient accepted after pharmacist explanation.',
        jurisdictionRuleRef: 'RX-04',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

// DEV-832 (F08): the queue rows carry a seeded full patient profile; the
// projection helper applies the query's include/select the way Prisma does.
describe('DEV-832 dispensing queue patient projection', () => {
  type Row = Record<string, unknown>;
  type Shape = { include?: Record<string, unknown>; select?: Record<string, unknown> };
  const isRelation = (value: unknown) =>
    Array.isArray(value) ||
    (value !== null && typeof value === 'object' && !(value instanceof Date));
  function project(value: unknown, shape: Shape | true): unknown {
    if (Array.isArray(value)) return value.map((entry) => project(entry, shape));
    const row = value as Row;
    const out: Row = {};
    if (shape !== true && shape.select) {
      for (const [key, spec] of Object.entries(shape.select))
        out[key] = spec === true ? row[key] : project(row[key], spec as Shape);
      return out;
    }
    for (const [key, entry] of Object.entries(row)) if (!isRelation(entry)) out[key] = entry;
    if (shape !== true)
      for (const [key, spec] of Object.entries(shape.include ?? {}))
        out[key] = project(row[key], spec as Shape | true);
    return out;
  }

  const patient = {
    id: 'patient-a',
    organizationId: 'org-a',
    displayName: 'Synthetic Patient',
    cnic: '35202-1234567-1',
    phone: '+923001234567',
    address: '12 Synthetic Road, Lahore',
    dateOfBirth: new Date('1980-02-03'),
  };
  const seeded = [
    {
      id: 'review-1',
      requestedAt: new Date('2026-11-01'),
      line: {
        id: 'rx-line',
        medicine: { id: 'med-1', productName: 'Synthetic Tablet', presentations: [] },
        presentation: { id: 'pres-1', presentation: 'Tablet' },
        prescription: {
          id: 'rx-1',
          patient,
          prescriber: { id: 'doc-1', name: 'Dr Synthetic', phone: '+923009999999' },
        },
      },
      decisions: [],
    },
  ];

  function assertMinimalPatient(lines: unknown) {
    const body = JSON.stringify(lines);
    for (const raw of [patient.cnic, patient.phone, patient.address, '1980-02-03'])
      expect(body).not.toContain(raw);
    const [first] = lines as Array<{ line: { prescription: { patient: unknown } } }>;
    expect(first.line.prescription.patient).toEqual({
      id: 'patient-a',
      displayName: 'Synthetic Patient',
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockImplementation((async (args: Shape) =>
      project(seeded, args)) as unknown as () => Promise<unknown[]>);
  });

  it('refuses the review queue without the dispense grant and reads nothing', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().reviewQueue()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('returns only the patient name in the review queue', async () => {
    mocks.can.mockResolvedValue(true);
    const result = await caller().reviewQueue();
    assertMinimalPatient(result.items);
    expect(JSON.stringify(result.items)).not.toContain('+923009999999');
    expect(
      (result.items[0] as unknown as { line: { prescription: { prescriber: unknown } } }).line
        .prescription.prescriber
    ).toEqual({ id: 'doc-1', name: 'Dr Synthetic' });
  });

  it('returns only the patient name in the substitution workspace', async () => {
    mocks.can.mockResolvedValue(true);
    const result = await caller().substitutionWorkspace();
    expect(result.canRecord).toBe(true);
    assertMinimalPatient(result.lines);
  });
});

describe('QA-7 substitution workspace patient records', () => {
  const grant = (...held: string[]) =>
    mocks.can.mockImplementation((async (_subject: unknown, action: string) =>
      held.includes(action)) as unknown as () => Promise<boolean>);
  const patient = { id: 'patient-1', displayName: 'Patient One' };
  // Returns the patient only when the query asks for it, as Prisma would.
  const reviewItem = (withPatient: boolean) => ({
    id: 'review-1',
    prescriptionLineId: 'rx-line',
    saleLineId: 'sale-line',
    line: {
      id: 'rx-line',
      presentationId: 'tab-10',
      medicine: { productName: 'Medicine A', presentations: [] },
      presentation: { id: 'tab-10', presentation: 'Tablet 10mg' },
      prescription: { id: 'rx-1', patientId: 'patient-1', ...(withPatient ? { patient } : {}) },
    },
  });
  const query = () => JSON.stringify((mocks.findMany.mock.calls as unknown as [unknown][])[0]![0]);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
    mocks.findMany.mockImplementation((async (args: unknown) => [
      reviewItem(JSON.stringify(args).includes('"patient"')),
    ]) as unknown as () => Promise<unknown[]>);
  });

  it('never reads or returns patient records to a safety-only holder', async () => {
    grant('pharmacy:safety');

    const result = await caller().substitutionWorkspace();

    expect(result.canViewPatients).toBe(false);
    expect(result.lines[0]!.line.prescription.patient).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Patient One');
    expect(query()).not.toContain('patient');
  });

  it('checks the patient-record permission separately from dispensing', async () => {
    grant('pharmacy:dispense');

    const result = await caller().substitutionWorkspace();

    expect(result).toMatchObject({ canRecord: true, canViewPatients: false });
    expect(result.lines[0]!.line.prescription.patient).toBeNull();
    expect(query()).not.toContain('patient');
  });

  it('shows only the patient name to a holder of the patient-record permission', async () => {
    grant('pharmacy:safety', 'pharmacy:prescriptions');

    const result = await caller().substitutionWorkspace();

    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:prescriptions',
      undefined,
      expect.anything()
    );
    expect(result.canViewPatients).toBe(true);
    expect(result.lines[0]!.line.prescription.patient).toEqual(patient);
    expect(query()).toContain('"patient":{"select":{"id":true,"displayName":true}}');
  });
});
