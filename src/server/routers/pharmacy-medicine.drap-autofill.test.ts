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

function caller(db: object, userId = 'editor-a') {
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
      user: { id: userId, role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

// Synthetic DRAP-shaped fixtures; not real registrations.
type Values = Record<string, string>;
type Proposal = {
  id: string;
  connectorId: string;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  targetMedicineId: string | null;
  inputDigest: string;
  rowSourceKey: string;
  createdAt: Date;
  run: { triggeredBy: string };
  payload: { values: Values; source: Record<string, unknown> };
};

function drapProposal(id: string, values: Values, createdAt = '2030-01-02'): Proposal {
  return {
    id,
    connectorId: 'conn-drap',
    status: 'PENDING',
    targetMedicineId: null,
    inputDigest: `digest-${id}`,
    rowSourceKey: `drap-${values.drapRegistrationNumber ?? id}`,
    createdAt: new Date(createdAt),
    run: { triggeredBy: 'uploader-a' },
    payload: {
      values,
      source: {
        connectorId: 'drap-registry',
        label: 'DRAP registry file',
        fileName: 'synthetic-drap.csv',
        batchId: 'batch-synthetic',
        rowSourceKey: `drap-${values.drapRegistrationNumber ?? id}`,
        rights: DRAP_REGISTRY_RIGHTS,
      },
    },
  };
}

const statedRow = {
  productName: 'Synthamol',
  strength: '500 mg',
  dosageForm: 'Tablet',
  drapRegistrationNumber: 'SYN-0001',
  rx: 'true',
  controlled: 'true',
};

type Where = Record<string, unknown> & {
  id?: string;
  status?: string;
  targetMedicineId?: string | null;
  payload?: { path: string[]; equals: string };
};

const normalized = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : null;

function matches(proposal: Proposal, where: Where) {
  if (where.id !== undefined && proposal.id !== where.id) return false;
  if (where.connectorId !== undefined && proposal.connectorId !== where.connectorId) return false;
  if (where.status !== undefined && proposal.status !== where.status) return false;
  if ('targetMedicineId' in where && proposal.targetMedicineId !== where.targetMedicineId)
    return false;
  if (where.payload && proposal.payload.values.drapRegistrationNumber !== where.payload.equals)
    return false;
  return true;
}

/** A tiny in-memory tenant store: enough for the draft and confirmation paths. */
function store(proposals: Proposal[] = [], medicines: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  const db = {
    calls,
    proposals,
    medicines,
    $transaction: (run: (client: unknown) => unknown) => run(db),
    $queryRawUnsafe: vi.fn(async (_sql: string, space: string, key: string) => {
      calls.push(`lock:${space}:${key}`);
      return [];
    }),
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = (query as { sql?: unknown }).sql;
      // DEV-854 legacy-controlled lookup during confirmation (a tagged template).
      if (typeof sql !== 'string') return [{ found: false }];
      const values = (query as { values: unknown[] }).values;
      if (sql.includes('pharmacy_reference_connector_proposals')) {
        const [, connectorId, registration] = values as string[];
        return proposals
          .filter(
            (proposal) =>
              proposal.connectorId === connectorId &&
              ['PENDING', 'CONFIRMED'].includes(proposal.status) &&
              normalized(proposal.payload.values.drapRegistrationNumber) === registration
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 1)
          .map(({ id }) => ({ id }));
      }
      calls.push('duplicate-check');
      const [, registration] = values as string[];
      return medicines
        .filter((medicine) => normalized(medicine.drapRegistrationNumber) === registration)
        .map(({ id }) => ({ id }));
    }),
    pharmacyReferenceConnector: { findFirst: vi.fn(async () => ({ id: 'conn-drap' })) },
    pharmacyReferenceConnectorProposal: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const found = proposals
          .filter((proposal) => matches(proposal, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return found[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        proposals.filter((proposal) => matches(proposal, { ...where, payload: undefined }))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Proposal> }) => {
        const hit = proposals.filter((proposal) => matches(proposal, where));
        for (const proposal of hit) Object.assign(proposal, data);
        return { count: hit.length };
      }),
    },
    medicine: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        calls.push('duplicate-check');
        return (
          medicines.find((medicine) =>
            Object.entries(where).every(([key, value]) => medicine[key] === value)
          ) ?? null
        );
      }),
      // Snapshot reads for a confirmation: strength and form from the draft's assertions.
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        medicines
          .filter((medicine) => where.id?.in.includes(medicine.id as string))
          .map((medicine) => ({
            ...medicine,
            presentations: [],
            strengths: [],
            provenance: (
              ((medicine.provenance as { create?: unknown[] } | undefined)?.create ?? []) as Array<{
                field: string;
                assertedValue: unknown;
              }>
            ).filter((item) => ['strength', 'dosageForm'].includes(item.field)),
          }))
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const medicine = { id: `medicine-${medicines.length + 1}`, ...data };
        medicines.push(medicine);
        return { id: medicine.id, productName: data.productName, saleable: false };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const medicine = medicines.find((item) => item.id === where.id)!;
        Object.assign(medicine, data);
        return medicine;
      }),
    },
    medicineProvenance: { create: vi.fn(async () => ({ id: 'assertion' })) },
    medicineReviewDecision: { create: vi.fn() },
  };
  return db;
}

function created(db: ReturnType<typeof store>) {
  return db.medicine.create.mock.calls[0]![0].data as unknown as {
    saleable: boolean;
    rx: boolean;
    controlled: boolean;
    provenance: { create: Array<{ field: string; sourceType: string; status: string }> };
  };
}

const draft = {
  productName: 'Synthamol',
  strength: '500 mg',
  dosageForm: 'Tablet',
  pack: '10 tablets',
  drapRegistrationNumber: 'SYN-0001',
  rx: true as boolean | null,
  controlled: true as boolean | null,
};

beforeEach(() => {
  mocks.can.mockReset();
  mocks.can.mockImplementation(async () => true);
});

describe('DEV-683 add-medicine DRAP auto-fill boundary', () => {
  it('refuses search and save to a member without catalogue-edit rights', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'pharmacy:catalogue-edit');
    const db = store([drapProposal('ref-1', statedRow)]);
    await expect(caller(db).drapReferenceSearch({ query: 'synth' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(db).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyReferenceConnectorProposal.findMany).not.toHaveBeenCalled();
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('searches the caller’s own organisation only', async () => {
    const db = store([drapProposal('ref-1', statedRow)]);
    const result = await caller(db).drapReferenceSearch({ query: 'SYN-0001' });
    expect(result.hasReferenceData).toBe(true);
    expect(result.matches[0]?.values).toEqual({
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      drapRegistrationNumber: 'SYN-0001',
      rx: true,
      controlled: true,
    });
    expect(db.pharmacyReferenceConnectorProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a' }) })
    );
  });

  it('saves a confirmed DRAP draft as non-saleable with unreviewed regulator provenance', async () => {
    const db = store([drapProposal('ref-1', statedRow)]);
    await expect(
      caller(db).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' })
    ).resolves.toMatchObject({ id: 'medicine-1', saleable: false });
    const data = created(db);
    expect(data).toMatchObject({ saleable: false, rx: true, controlled: true });
    expect(Object.keys(data).some((key) => /price|mrp/i.test(key))).toBe(false);
    expect(data.provenance.create.find((item) => item.field === 'rx')).toMatchObject({
      sourceType: 'REGULATOR',
      status: 'UNREVIEWED',
    });
    expect(data.provenance.create.every((item) => item.status === 'UNREVIEWED')).toBe(true);
    // The DRAP row is not written at save time: its guard allows only a decision.
    expect(db.pharmacyReferenceConnectorProposal.updateMany).not.toHaveBeenCalled();
    expect(db.proposals[0]).toMatchObject({ status: 'PENDING', targetMedicineId: null });
  });

  it('refuses prescription-only or controlled flags that differ from the reference row', async () => {
    for (const change of [{ rx: false }, { controlled: false }]) {
      const db = store([drapProposal('ref-1', statedRow)]);
      await expect(
        caller(db).addMedicineDraft({ ...draft, ...change, drapReferenceId: 'ref-1' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.medicine.create).not.toHaveBeenCalled();
    }
  });

  it('needs an explicit choice for a flag the DRAP row does not state', async () => {
    const { controlled: _unstated, ...withoutControlled } = statedRow;
    void _unstated;
    const db = store([drapProposal('ref-1', withoutControlled)]);
    await expect(
      caller(db).addMedicineDraft({ ...draft, controlled: null, drapReferenceId: 'ref-1' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('does not state'),
    });
    expect(db.medicine.create).not.toHaveBeenCalled();
    // An explicit answer is the person's own entry, not regulator data.
    await caller(db).addMedicineDraft({ ...draft, controlled: false, drapReferenceId: 'ref-1' });
    const data = created(db);
    expect(data.controlled).toBe(false);
    expect(data.provenance.create.find((item) => item.field === 'controlled')).toMatchObject({
      sourceType: 'USER',
    });
  });

  it('enforces the stated flags by registration number even without a reference id', async () => {
    // As after "Clear auto-fill" and retyping the registration number.
    const db = store([drapProposal('ref-1', statedRow)]);
    await expect(
      caller(db).addMedicineDraft({ ...draft, controlled: false })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
    await caller(db).addMedicineDraft(draft);
    expect(created(db).provenance.create.find((item) => item.field === 'rx')).toMatchObject({
      sourceType: 'REGULATOR',
    });
    expect(db.pharmacyReferenceConnectorProposal.updateMany).not.toHaveBeenCalled();
  });

  it('takes a registration lock before the duplicate check', async () => {
    const db = store();
    await caller(db).addMedicineDraft(draft);
    expect(db.calls.slice(0, 2)).toEqual([
      'lock:pharmacy-medicine-registration:org-a:syn-0001',
      'duplicate-check',
    ]);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'pharmacy-medicine-registration',
      'org-a:syn-0001'
    );
  });

  it('refuses a changed registration number, a rejected or unknown row and a duplicate', async () => {
    const changed = store([drapProposal('ref-1', statedRow)]);
    await expect(
      caller(changed).addMedicineDraft({
        ...draft,
        drapRegistrationNumber: 'SYN-9999',
        drapReferenceId: 'ref-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const rejected = store([{ ...drapProposal('ref-1', statedRow), status: 'REJECTED' }]);
    await expect(
      caller(rejected).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const missing = store();
    await expect(
      caller(missing).addMedicineDraft({ ...draft, drapReferenceId: 'ref-other-tenant' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const duplicate = store([], [{ id: 'existing', drapRegistrationNumber: 'SYN-0001' }]);
    await expect(caller(duplicate).addMedicineDraft(draft)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    for (const db of [changed, rejected, missing, duplicate])
      expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('never accepts a price on the draft', async () => {
    const db = store();
    await expect(
      caller(db).addMedicineDraft({ ...draft, retailPriceMinor: 1200 } as typeof draft)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('keeps manual entry working with no reference row, but never defaults a flag', async () => {
    const db = store();
    await expect(caller(db).addMedicineDraft({ ...draft, rx: null })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await caller(db).addMedicineDraft({ ...draft, rx: false, controlled: false });
    expect(created(db).provenance.create.every((item) => item.sourceType === 'USER')).toBe(true);
  });

  it('leaves exactly one medicine when a draft is saved and its DRAP row confirmed later', async () => {
    const db = store([drapProposal('ref-1', statedRow)]);
    await caller(db).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' });
    expect(db.medicines).toHaveLength(1);
    // A pharmacist other than the uploader confirms the same proposal afterwards.
    await caller(db, 'pharmacist-b').decideReferenceConnectorProposal({
      proposalId: 'ref-1',
      decision: 'CONFIRM',
    });
    expect(db.medicine.create).toHaveBeenCalledTimes(1);
    expect(db.medicines).toHaveLength(1);
    expect(db.medicine.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'medicine-1' } })
    );
    expect(db.proposals[0]).toMatchObject({
      status: 'CONFIRMED',
      targetMedicineId: 'medicine-1',
    });
  });

  it('applies the stated flags and the duplicate check to a case variant of the number', async () => {
    const db = store([drapProposal('ref-1', statedRow)]);
    await expect(
      caller(db).addMedicineDraft({
        ...draft,
        drapRegistrationNumber: ' syn-0001 ',
        controlled: false,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller(db).addMedicineDraft(draft);
    await expect(
      caller(db).addMedicineDraft({ ...draft, drapRegistrationNumber: 'syn-0001' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.medicines).toHaveLength(1);
  });

  it('does not let a stale rejected row lock a draft', async () => {
    const db = store([{ ...drapProposal('ref-1', statedRow), status: 'REJECTED' }]);
    await caller(db).addMedicineDraft({ ...draft, controlled: false });
    expect(created(db).controlled).toBe(false);
  });

  it('refuses to merge a different product sharing the registration number', async () => {
    const db = store([
      drapProposal('ref-1', statedRow),
      drapProposal(
        'ref-2',
        { ...statedRow, productName: 'Othermed', strength: '250 mg', dosageForm: 'Syrup' },
        '2030-01-03'
      ),
    ]);
    await caller(db).addMedicineDraft({ ...draft, drapReferenceId: 'ref-1' });
    await expect(
      caller(db, 'pharmacist-b').decideReferenceConnectorProposal({
        proposalId: 'ref-2',
        decision: 'CONFIRM',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('name') });
    expect(db.medicine.update).not.toHaveBeenCalled();
    expect(db.medicines[0]).toMatchObject({ productName: 'Synthamol', controlled: true });
  });
});
