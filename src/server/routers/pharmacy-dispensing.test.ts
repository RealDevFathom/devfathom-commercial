import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  create: vi.fn(),
  findMany: vi.fn(async () => [] as unknown[]),
  findPatients: vi.fn(async () => [] as unknown[]),
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
      pharmacyPatient: { findMany: mocks.findPatients },
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

describe('QA-7 substitution workspace patient records', () => {
  const grant = (...held: string[]) =>
    mocks.can.mockImplementation((async (_subject: unknown, action: string) =>
      held.includes(action)) as unknown as () => Promise<boolean>);
  const reviewItem = {
    id: 'review-1',
    prescriptionLineId: 'rx-line',
    saleLineId: 'sale-line',
    line: {
      id: 'rx-line',
      presentationId: 'tab-10',
      medicine: { productName: 'Medicine A', presentations: [] },
      presentation: { id: 'tab-10', presentation: 'Tablet 10mg' },
      prescription: { id: 'rx-1', patientId: 'patient-1' },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
    mocks.findMany.mockResolvedValue([reviewItem]);
    mocks.findPatients.mockResolvedValue([{ id: 'patient-1', displayName: 'Patient One' }]);
  });

  it('never reads or returns patient records to a safety-only holder', async () => {
    grant('pharmacy:safety');

    const result = await caller().substitutionWorkspace();

    expect(result.canViewPatients).toBe(false);
    expect(result.lines[0]!.line.prescription.patient).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Patient One');
    expect(mocks.findPatients).not.toHaveBeenCalled();
    const query = (mocks.findMany.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(JSON.stringify(query)).not.toContain('patient');
  });

  it('checks the patient-record permission separately from dispensing', async () => {
    grant('pharmacy:dispense');

    const result = await caller().substitutionWorkspace();

    expect(result).toMatchObject({ canRecord: true, canViewPatients: false });
    expect(result.lines[0]!.line.prescription.patient).toBeNull();
    expect(mocks.findPatients).not.toHaveBeenCalled();
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
    expect(result.lines[0]!.line.prescription.patient).toEqual({
      id: 'patient-1',
      displayName: 'Patient One',
    });
    expect(mocks.findPatients).toHaveBeenCalledWith({
      where: { id: { in: ['patient-1'] } },
      select: { id: true, displayName: true },
    });
  });
});
