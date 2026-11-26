// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  hasModule: vi.fn(),
  patient: vi.fn(),
  patientRecord: vi.fn(),
  patients: vi.fn(),
  prescriber: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  putUpload: vi.fn(),
  getUpload: vi.fn(),
  audit: vi.fn(),
  patientAudit: vi.fn(),
  actor: vi.fn(),
  context: vi.fn(),
  medicines: vi.fn(),
  prescriptionLine: vi.fn(),
  portalRequest: vi.fn(),
  objects: new Map<string, Buffer>(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/storage', () => ({ putUpload: mocks.putUpload, getUpload: mocks.getUpload }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.audit,
  recordAudit: mocks.patientAudit,
}));
vi.mock('@/server/trpc', async () => ({
  ...(await vi.importActual<typeof import('@/server/trpc')>('@/server/trpc')),
  createTRPCContext: mocks.context,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';
import { GET } from '@/app/api/pharmacy/prescription-files/route';
import { GET as sharedFileGET } from '@/app/api/files/[name]/route';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

// Preserve the production procedure paths so the module-license guard runs.
const testRouter = router({ pharmacyPrescriptions: pharmacyPrescriptionsRouter });

function context(
  userId = 'user-a',
  organizationId = 'org-a',
  status = 'ACTIVE',
  enabledModules = ['pharmacy-dispensing']
) {
  return {
    db: {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
      pharmacyPatient: {
        findFirst: mocks.patient,
        findFirstOrThrow: mocks.patientRecord,
        findMany: mocks.patients,
      },
      pharmacyPrescriber: { findFirst: mocks.prescriber },
      prescription: { findFirst: mocks.find, create: mocks.create },
      prescriptionLine: { findFirst: mocks.prescriptionLine },
      medicine: { findMany: mocks.medicines },
      pharmacyCustomerPortalRequest: { findFirst: mocks.portalRequest },
    },
    entitlements: { organizationId, modules: [], enabledModules },
    session: { expires: 'later', user: { id: userId, organizationId, role: 'EMPLOYEE', status } },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
function caller(ctx = context()) {
  return testRouter.createCaller(ctx).pharmacyPrescriptions;
}
async function upload(patientId = 'patient-a') {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  return caller().uploadSource({
    patientId,
    contentType: 'image/png',
    dataBase64: bytes.toString('base64'),
  });
}
function captureInput(sourceFileRef: string) {
  return {
    sourceFileRef,
    patientId: 'patient-a',
    prescriberId: 'prescriber-a',
    sourceKind: 'PAPER_IMAGE' as const,
    validFrom: new Date('2026-09-01'),
    validUntil: new Date('2026-10-01'),
    authorizedRepeats: 0,
    lines: [
      {
        lineNumber: 1,
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        authorizedCanonicalUnits: 2,
        directions: 'Synthetic test directions',
      },
    ],
  };
}

describe('prescription capture and private delivery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.objects.clear();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    mocks.patient.mockResolvedValue({ id: 'patient-a' });
    mocks.prescriber.mockResolvedValue({ id: 'prescriber-a' });
    mocks.find.mockResolvedValue(null);
    mocks.prescriptionLine.mockResolvedValue({ medicine: { controlled: false } });
    mocks.create.mockImplementation(async ({ data }) => ({
      ...data,
      lines: undefined,
      custodyState: data.custodyState ?? 'NOT_HELD',
    }));
    mocks.putUpload.mockImplementation(async (org, name, bytes) => {
      mocks.objects.set(`${org}/${name}`, bytes);
    });
    mocks.getUpload.mockImplementation(async (org, name) => {
      const bytes = mocks.objects.get(`${org}/${name}`);
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return bytes;
    });
    mocks.actor.mockResolvedValue({
      session: context().session,
      organization: context().organization,
      support: null,
    });
    mocks.context.mockResolvedValue(context());
  });

  it('records consent under the shared patient lock with server-owned version', async () => {
    const ctx = context();
    const lock = vi.fn().mockResolvedValue([{ id: 'patient-a' }]);
    const create = vi.fn(async ({ data }) => data);
    const tx = {
      $queryRaw: lock,
      patientConsent: {
        findFirst: vi.fn().mockResolvedValue({ id: 'previous', version: 3 }),
        create,
      },
    };
    ctx.db = {
      $transaction: async (run: (db: unknown) => unknown) => run(tx),
    } as unknown as typeof ctx.db;
    const result = await caller(ctx).recordConsent({
      patientId: 'patient-a',
      purpose: 'MARKETING',
      channel: 'WHATSAPP',
      granted: false,
      version: 99,
      supersedesId: 'foreign',
    });
    expect(result).toMatchObject({
      organizationId: 'org-a',
      recordedByUserId: 'user-a',
      version: 4,
      supersedesId: 'previous',
      granted: false,
    });
    expect(lock.mock.calls[0][0].values).toEqual(['org-a', 'patient-a']);
  });

  it('keeps staff attribution when an authenticated session labels consent as QR', async () => {
    const ctx = context();
    const create = vi.fn(async ({ data }) => data);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'patient-a' }]),
      patientConsent: { findFirst: vi.fn().mockResolvedValue(null), create },
    };
    ctx.db = {
      $transaction: async (run: (db: unknown) => unknown) => run(tx),
    } as unknown as typeof ctx.db;
    await expect(
      caller(ctx).recordConsent({
        patientId: 'patient-a',
        purpose: 'MARKETING',
        channel: 'WHATSAPP',
        granted: true,
        source: 'QR',
      })
    ).resolves.toMatchObject({ source: 'QR', staffId: 'user-a', recordedByUserId: 'user-a' });
  });

  it('persists validated image capture and lines in one nested create', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    const captured = await caller().capture(input);
    expect(captured.id).toMatch(/^rx-/);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        ...input,
        id: captured.id,
        capturedByUserId: 'user-a',
        lines: { create: input.lines },
      },
    });
    expect(mocks.patient).toHaveBeenCalledWith({
      where: { id: 'patient-a', organizationId: 'org-a' },
      select: { id: true },
    });
    expect(mocks.prescriber).toHaveBeenCalledWith({
      where: { id: 'prescriber-a', organizationId: 'org-a' },
      select: { id: true },
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:prescriptions',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('accepts calendar-date carriers but rejects validity instants and reversed dates', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    await expect(
      caller().capture({ ...input, validUntil: new Date('2026-10-01T12:00:00.000Z') })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().capture({
        ...input,
        validFrom: new Date('2026-10-02T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects oversized prescription lines and directions before storage work', async () => {
    const input = captureInput(
      '/api/pharmacy/prescription-files?id=00000000-0000-4000-8000-000000000001'
    );

    await expect(
      caller().capture({ ...input, lines: Array.from({ length: 31 }, () => input.lines[0]) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().capture({
        ...input,
        lines: [{ ...input.lines[0], directions: 'x'.repeat(2_001) }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('accepts prescription lines, directions, and IDs at their limits', async () => {
    const input = captureInput(
      '/api/pharmacy/prescription-files?id=00000000-0000-4000-8000-000000000001'
    );

    await expect(
      caller().capture({
        ...input,
        patientId: 'p'.repeat(200),
        prescriberId: 'r'.repeat(200),
        lines: Array.from({ length: 30 }, (_, index) => ({
          ...input.lines[0],
          lineNumber: index + 1,
          medicineId: 'm'.repeat(200),
          presentationId: 'x'.repeat(200),
          directions: 'd'.repeat(2_000),
        })),
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mocks.getUpload).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('persists the maximum prescription lines and directions after a valid upload', async () => {
    const patientId = 'p'.repeat(128);
    const receipt = await upload(patientId);
    const input = {
      ...captureInput(receipt.url),
      patientId,
      prescriberId: 'r'.repeat(200),
      lines: Array.from({ length: 30 }, (_, index) => ({
        lineNumber: index + 1,
        medicineId: 'm'.repeat(200),
        presentationId: 'x'.repeat(200),
        authorizedCanonicalUnits: 2,
        directions: 'd'.repeat(2_000),
      })),
    };

    await expect(caller().capture(input)).resolves.toMatchObject({
      id: expect.stringMatching(/^rx-/),
    });
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        ...input,
        id: expect.stringMatching(/^rx-/),
        capturedByUserId: 'user-a',
        lines: { create: input.lines },
      },
    });
  });

  it('rejects oversized capture IDs before storage work', async () => {
    const input = captureInput(
      '/api/pharmacy/prescription-files?id=00000000-0000-4000-8000-000000000001'
    );
    const oversizedId = 'x'.repeat(201);

    await expect(caller().capture({ ...input, patientId: oversizedId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().capture({ ...input, prescriberId: oversizedId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().capture({
        ...input,
        lines: [{ ...input.lines[0], medicineId: oversizedId }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().capture({
        ...input,
        lines: [{ ...input.lines[0], presentationId: oversizedId }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.prescriber).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('allows pharmacists with dispensing capability', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:prescriptions');
    await expect(upload()).resolves.toHaveProperty('url');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('allows tenant administrators through the narrow central prescription policy', async () => {
    mocks.can.mockResolvedValue(true);
    const admin = context();
    admin.session!.user.role = 'ADMIN';
    await expect(
      caller(admin).uploadSource({
        patientId: 'patient-a',
        contentType: 'image/png',
        dataBase64: (
          await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
            .png()
            .toBuffer()
        ).toString('base64'),
      })
    ).resolves.toHaveProperty('url');
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      'pharmacy:prescriptions',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('refuses a tenant administrator when central ABAC finds an explicit veto', async () => {
    mocks.can.mockResolvedValue(false);
    const admin = context();
    admin.session!.user.role = 'ADMIN';

    await expect(caller(admin).workspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      'pharmacy:prescriptions',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('tells the console when an admin may capture prescriptions but not dispense', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:prescriptions');
    mocks.medicines.mockResolvedValue([]);
    const admin = context();
    admin.session!.user.role = 'ADMIN';
    const db = admin.db as unknown as Record<string, Record<string, unknown>>;
    const findMany = vi.fn().mockResolvedValue([]);
    for (const model of ['pharmacyPatient', 'pharmacyPrescriber', 'prescription']) {
      db[model] = { ...db[model], findMany };
    }
    db.pharmacyBranch = { findMany };
    db.pharmacyRefillReminderCapture = { findMany };

    await expect(caller(admin).workspace()).resolves.toMatchObject({ canDispense: false });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );

    mocks.can.mockResolvedValue(true);
    await expect(caller(admin).workspace()).resolves.toMatchObject({ canDispense: true });
  });

  it.each([
    ['Asia/Karachi', 'Asia/Karachi'],
    ['UTC', 'UTC'],
    // A zone Intl refuses, or none, reads as UTC, as every workspace day does.
    ['PKT', 'UTC'],
    [undefined, 'UTC'],
  ])(
    'DEV-943: the workspace carries the caller organisation zone %s as %s',
    async (stored, zone) => {
      mocks.can.mockResolvedValue(true);
      mocks.medicines.mockResolvedValue([]);
      const admin = context();
      admin.session!.user.role = 'ADMIN';
      (admin as { organization: unknown }).organization = { id: 'org-a', timezone: stored };
      const db = admin.db as unknown as Record<string, Record<string, unknown>>;
      const findMany = vi.fn().mockResolvedValue([]);
      for (const model of ['pharmacyPatient', 'pharmacyPrescriber', 'prescription']) {
        db[model] = { ...db[model], findMany };
      }
      db.pharmacyBranch = { findMany };
      db.pharmacyRefillReminderCapture = { findMany };

      await expect(caller(admin).workspace()).resolves.toMatchObject({ timezone: zone });
    }
  );

  it('refuses to record a prescription fill without an exact dispense grant', async () => {
    mocks.can.mockResolvedValue(false);
    const ctx = context();
    const create = vi.fn();
    (ctx.db as unknown as Record<string, unknown>).prescriptionFill = { create };
    await expect(
      caller(ctx).fill({
        id: 'fill-a',
        prescriptionLineId: 'line-a',
        fillSequence: 1,
        quantityCanonicalUnits: 1,
        idempotencyKey: 'fill-key-a',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it.each([
    ['counterPatients', () => caller().counterPatients({ query: 'patient' })],
    ['counterPatientPanel', () => caller().counterPatientPanel({ patientId: 'patient-a' })],
  ])('refuses %s without counter or dispense capability', async (_procedure, invoke) => {
    mocks.can.mockResolvedValue(false);

    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.can).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'pharmacy:counter',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.can).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.patients).not.toHaveBeenCalled();
  });

  it.each([
    ['counterPatients', () => caller().counterPatients({ query: 'patient' })],
    ['counterPatientPanel', () => caller().counterPatientPanel({ patientId: 'patient-a' })],
  ])('refuses %s when neither eligible module is licensed', async (_procedure, invoke) => {
    mocks.hasModule.mockReturnValue(false);

    await expect(invoke()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The pharmacy-counter module is not enabled for this organization.',
    });

    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.patients).not.toHaveBeenCalled();
  });

  it.each([
    ['counter-only', 'pharmacy:counter'],
    ['dispense-only', 'pharmacy:dispense'],
  ] as const)('allows a %s caller to search and read counter patients', async (_grant, action) => {
    const enabledModules =
      action === 'pharmacy:counter' ? ['pharmacy-counter'] : ['pharmacy-dispensing'];
    mocks.hasModule.mockImplementation((entitlements, moduleKey) =>
      entitlements.enabledModules.includes(moduleKey)
    );
    mocks.can.mockImplementation(async (_subject, requestedAction) => requestedAction === action);
    const savedAddress = '42 Synthetic Test Street';
    mocks.patients.mockResolvedValue([]);
    mocks.patient.mockResolvedValue({
      id: 'patient-a',
      displayName: 'Patient A',
      cnic: null,
      phone: null,
      address: savedAddress,
      dateOfBirth: null,
      consents: [],
      prescriptions: [],
    });

    const counterCaller = caller(context('user-a', 'org-a', 'ACTIVE', enabledModules));
    await expect(counterCaller.counterPatients({ query: 'patient' })).resolves.toEqual({
      patients: [],
    });
    const panel = await counterCaller.counterPatientPanel({ patientId: 'patient-a' });
    expect(panel).toMatchObject({ patientId: 'patient-a', prescriptions: [] });
    expect(panel).not.toHaveProperty('address');
    expect(JSON.stringify(panel)).not.toContain(savedAddress);
    expect(mocks.patient.mock.calls[0]![0].select).not.toHaveProperty('address');

    expect(mocks.patients).toHaveBeenCalledOnce();
    expect(mocks.patient).toHaveBeenCalledOnce();
    expect(mocks.patientAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: 'org-a',
        actorId: 'user-a',
        action: 'pharmacy.patient.read',
        targetId: 'patient-a',
      })
    );
    expect(mocks.can.mock.calls.map(([, requestedAction]) => requestedAction)).toEqual(
      action === 'pharmacy:counter'
        ? ['pharmacy:counter', 'pharmacy:counter']
        : ['pharmacy:counter', 'pharmacy:dispense', 'pharmacy:counter', 'pharmacy:dispense']
    );
  });

  it('refuses controlled fills so they cannot bypass witnessed counter dispensing', async () => {
    const ctx = context();
    const create = vi.fn();
    (ctx.db as unknown as Record<string, unknown>).prescriptionFill = { create };
    mocks.prescriptionLine.mockResolvedValue({ medicine: { controlled: true } });

    await expect(
      caller(ctx).fill({
        id: 'fill-controlled',
        prescriptionLineId: 'line-controlled',
        fillSequence: 1,
        quantityCanonicalUnits: 1,
        idempotencyKey: 'fill-key-controlled',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Controlled medicines must be dispensed through the witnessed counter flow.',
    });
    expect(mocks.prescriptionLine).toHaveBeenCalledWith({
      where: { id: 'line-controlled', organizationId: 'org-a' },
      select: { medicine: { select: { controlled: true } } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not disclose or fill a missing or cross-tenant prescription line', async () => {
    const ctx = context();
    const create = vi.fn();
    (ctx.db as unknown as Record<string, unknown>).prescriptionFill = { create };
    mocks.prescriptionLine.mockResolvedValue(null);

    await expect(
      caller(ctx).fill({
        id: 'fill-foreign',
        prescriptionLineId: 'line-foreign',
        fillSequence: 1,
        quantityCanonicalUnits: 1,
        idempotencyKey: 'fill-key-foreign',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Prescription line not found.' });
    expect(mocks.prescriptionLine).toHaveBeenCalledWith({
      where: { id: 'line-foreign', organizationId: 'org-a' },
      select: { medicine: { select: { controlled: true } } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('continues to record non-controlled prescription fills', async () => {
    const ctx = context();
    const create = vi.fn(async ({ data }) => data);
    (ctx.db as unknown as Record<string, unknown>).prescriptionFill = { create };

    await expect(
      caller(ctx).fill({
        id: 'fill-ordinary',
        prescriptionLineId: 'line-ordinary',
        fillSequence: 1,
        quantityCanonicalUnits: 2,
        idempotencyKey: 'fill-key-ordinary',
      })
    ).resolves.toMatchObject({ id: 'fill-ordinary', dispensedByUserId: 'user-a' });
    expect(create).toHaveBeenCalledWith({
      data: {
        id: 'fill-ordinary',
        prescriptionLineId: 'line-ordinary',
        fillSequence: 1,
        quantityCanonicalUnits: 2,
        idempotencyKey: 'fill-key-ordinary',
        dispensedByUserId: 'user-a',
      },
    });
  });

  it('denies the cashier orders capability before showing the capture workspace or uploading', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:orders');
    await expect(caller().workspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(upload()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });

  it.each(['capture://rx.png', '/api/files/foreign.png', 'https://foreign.test/image.png'])(
    'rejects fake or shared references: %s',
    async (ref) => {
      await expect(caller().capture(captureInput(ref))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('rejects foreign patient, tenant and uploader binding', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    await expect(caller().capture({ ...input, patientId: 'patient-b' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller(context('user-a', 'org-b')).capture(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller(context('user-b')).capture(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects missing patient before upload and missing prescriber before capture', async () => {
    mocks.patient.mockResolvedValueOnce(null);
    await expect(upload()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.putUpload).not.toHaveBeenCalled();
    const receipt = await upload();
    mocks.prescriber.mockResolvedValue(null);
    await expect(caller().capture(captureInput(receipt.url))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('denies missing role/module without storage and suppresses raw input audit', async () => {
    const ctx = context();
    mocks.can.mockResolvedValue(false);
    await expect(
      caller(ctx).uploadSource({
        patientId: 'patient-a',
        contentType: 'image/png',
        dataBase64: 'sensitive-invalid-image',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ctx.audit.detail.skipInput).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ ctx, outcome: 'FAILURE' }));
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(false);
    await expect(upload()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });

  it('denies anonymous/inactive callers before storage with input audit suppression', async () => {
    const receipt = await upload();
    mocks.getUpload.mockClear();
    const ctx = context();
    ctx.session = null;
    await expect(caller(ctx).readSource({ sourceFileRef: receipt.url })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(ctx.audit.detail.skipInput).toBe(true);
    await expect(
      caller(context('user-a', 'org-a', 'TERMINATED')).readSource({ sourceFileRef: receipt.url })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('keeps upload recoverable when record persistence fails', async () => {
    const receipt = await upload();
    const failure = new Error('synthetic database failure');
    mocks.create.mockRejectedValueOnce(failure);
    await expect(caller().capture(captureInput(receipt.url))).rejects.toMatchObject({
      cause: failure,
    });
    await expect(caller().capture(captureInput(receipt.url))).resolves.toHaveProperty('id');
    expect(mocks.putUpload).toHaveBeenCalledOnce();
    expect(mocks.objects.size).toBe(1);
  });

  it('returns the existing capture on exact retry and rejects changed payload', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    const saved = await caller().capture(input);
    mocks.find.mockResolvedValue({ ...saved, lines: input.lines });
    await expect(caller().capture(input)).resolves.toEqual(saved);
    await expect(caller().capture({ ...input, authorizedRepeats: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('competing captures use the same primary key; uniqueness failure escapes, retry recovers', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    let saved: Record<string, unknown> | undefined;
    mocks.create.mockImplementation(async ({ data }) => {
      if (saved) throw Object.assign(new Error('unique'), { code: 'P2002' });
      saved = { ...data, custodyState: 'NOT_HELD', lines: input.lines };
      return { ...saved, lines: undefined };
    });
    const outcomes = await Promise.allSettled([caller().capture(input), caller().capture(input)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(new Set(mocks.create.mock.calls.map(([arg]) => arg.data.id)).size).toBe(1);
    mocks.find.mockResolvedValue(saved);
    await expect(caller().capture(input)).resolves.toHaveProperty('id', saved!.id);
  });

  it('rejects replay that duplicates one line instead of matching every stored line', async () => {
    const receipt = await upload();
    const input = captureInput(receipt.url);
    input.lines.push({ ...input.lines[0], lineNumber: 2 });
    const saved = await caller().capture(input);
    mocks.find.mockResolvedValue({ ...saved, lines: input.lines });
    await expect(
      caller().capture({ ...input, lines: [input.lines[0], input.lines[0]] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller().capture({ ...input, lines: [...input.lines].reverse() })
    ).resolves.toHaveProperty('id', saved.id);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('preview is uploader-only until patient-bound capture exists', async () => {
    const receipt = await upload();
    await expect(caller().readSource({ sourceFileRef: receipt.url })).resolves.toHaveProperty(
      'contentType',
      'image/png'
    );
    await expect(
      caller(context('user-b')).readSource({ sourceFileRef: receipt.url })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mocks.find.mockResolvedValue({ id: 'saved-rx' });
    await expect(
      caller(context('user-b')).readSource({ sourceFileRef: receipt.url })
    ).resolves.toHaveProperty('dataBase64');
    expect(mocks.find).toHaveBeenLastCalledWith({
      where: { organizationId: 'org-a', patientId: 'patient-a', sourceFileRef: receipt.url },
      select: { id: true },
    });
    mocks.patient.mockResolvedValue(null);
    await expect(caller().readSource({ sourceFileRef: receipt.url })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('DEV-15: shows staff a photo only when it is on that patient’s customer-app order', async () => {
    const receipt = await upload();
    await expect(
      caller(context('user-b')).readSource({ sourceFileRef: receipt.url })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mocks.portalRequest.mockResolvedValue({ id: 'portal-request-1' });
    await expect(
      caller(context('user-b')).readSource({ sourceFileRef: receipt.url })
    ).resolves.toHaveProperty('dataBase64');
    expect(mocks.portalRequest).toHaveBeenLastCalledWith({
      where: {
        organizationId: 'org-a',
        kind: 'RX_ORDER',
        prescriptionFileRef: receipt.url,
        customer: { patientId: 'patient-a' },
      },
      select: { id: true },
    });
  });

  it('delivers private image bytes with no-store/nosniff headers', async () => {
    const receipt = await upload();
    const response = await GET(new Request(`http://localhost${receipt.url}`));
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(receipt.size);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('route rejects anonymous, role-denied and malformed reads without fetching storage', async () => {
    const receipt = await upload();
    mocks.actor.mockResolvedValueOnce(null);
    expect((await GET(new Request(`http://localhost${receipt.url}`))).status).toBe(401);
    mocks.can.mockResolvedValueOnce(false);
    expect((await GET(new Request(`http://localhost${receipt.url}`))).status).toBe(403);
    expect(
      (await GET(new Request('http://localhost/api/pharmacy/prescription-files?id=../secret')))
        .status
    ).toBe(400);
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('shared delivery cannot bypass pharmacy authorization through the nested storage path', async () => {
    const receipt = await upload();
    const id = new URL(`http://localhost${receipt.url}`).searchParams.get('id');
    const response = await sharedFileGET(new Request('http://localhost/api/files/blocked'), {
      params: Promise.resolve({ name: `pharmacy-prescriptions/${id}.json` }),
    });
    expect(response.status).toBe(400);
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });
});

describe('protected patient operations', () => {
  const patient = {
    id: 'patient-a',
    organizationId: 'org-a',
    displayName: 'Synthetic Patient',
    cnic: '35202-1234567-1',
    phone: '+923001234567',
    dateOfBirth: new Date('1990-01-01'),
    consents: [{ id: 'consent-a', purpose: 'DISPENSING', granted: true }],
    prescriptions: [{ id: 'rx-a', lines: [{ id: 'line-a', fills: [{ id: 'fill-a' }] }] }],
  };

  function patientContext(role: string, denied = false) {
    const ctx = context(role);
    ctx.session!.user.role = role === 'owner' ? 'ADMIN' : 'EMPLOYEE';
    ctx.db = {
      ...ctx.db,
      user: {
        findUnique: vi.fn().mockResolvedValue({
          organizationRole: {
            permissions: PHARMACY_ROLE_TEMPLATES.find(
              (template) => template.key === role
            )!.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
          permissionOverrides: denied
            ? [{ capability: 'pharmacy:prescriptions', effect: 'DENY' }]
            : [],
        }),
      } as unknown as typeof ctx.db.user,
    };
    return ctx;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    // Exercise the real role/override policy through the router middleware.
    mocks.can.mockImplementation(
      (await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')).can
    );
    mocks.hasModule.mockReturnValue(true);
    const { consents, prescriptions, ...identity } = patient;
    mocks.patientRecord.mockImplementation(async ({ include }) =>
      include ? { ...identity, consents, prescriptions } : identity
    );
  });

  describe.each([
    [
      'createPatient',
      (api: ReturnType<typeof caller>) => api.createPatient({ displayName: 'Synthetic Patient' }),
    ],
    [
      'recordConsent',
      (api: ReturnType<typeof caller>) =>
        api.recordConsent({
          patientId: patient.id,
          purpose: 'MARKETING',
          channel: 'WHATSAPP',
          granted: false,
          source: 'QR',
        }),
    ],
  ] as const)('%s authorization', (endpoint, invoke) => {
    const createPatient = vi.fn();
    const createConsent = vi.fn();
    const lock = vi.fn();
    const transaction = vi.fn();

    function writeContext(role: string, denied = false) {
      const ctx = patientContext(role, denied);
      ctx.db = {
        ...ctx.db,
        pharmacyPatient: { ...ctx.db.pharmacyPatient, create: createPatient },
        $transaction: transaction,
      } as typeof ctx.db;
      return ctx;
    }

    beforeEach(() => {
      createPatient.mockResolvedValue(patient);
      createConsent.mockImplementation(async ({ data }) => data);
      lock.mockResolvedValue([{ id: patient.id }]);
      transaction.mockImplementation(async (run) =>
        run({
          $queryRaw: lock,
          patientConsent: { findFirst: vi.fn().mockResolvedValue(null), create: createConsent },
        })
      );
    });

    it.each(['manager', 'cashier', 'procurement', 'inventory', 'finance', 'auditor'])(
      'returns FORBIDDEN for %s before any patient or consent write',
      async (role) => {
        const ctx = writeContext(role);
        await expect(invoke(caller(ctx))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.can).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: role }),
          'pharmacy:prescriptions',
          undefined,
          { db: ctx.db, source: 'TRPC', ip: null }
        );
        expect(createPatient).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(lock).not.toHaveBeenCalled();
        expect(createConsent).not.toHaveBeenCalled();
        expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path: `pharmacyPrescriptions.${endpoint}`, outcome: 'FAILURE' })
        );
      }
    );

    it.each(['owner', 'owner-operator', 'pharmacist'])(
      'honors an explicit prescription DENY for %s',
      async (role) => {
        await expect(invoke(caller(writeContext(role, true)))).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(createPatient).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(createConsent).not.toHaveBeenCalled();
      }
    );

    it.each(['owner', 'owner-operator', 'pharmacist'])(
      'preserves authorized %s writes and their audit',
      async (role) => {
        const result = await invoke(caller(writeContext(role)));
        if (endpoint === 'createPatient') {
          expect(result).toEqual(patient);
          expect(createPatient).toHaveBeenCalledExactlyOnceWith({
            data: { displayName: 'Synthetic Patient' },
          });
        } else {
          expect(result).toMatchObject({
            organizationId: 'org-a',
            patientId: patient.id,
            purpose: 'MARKETING',
            channel: 'WHATSAPP',
            granted: false,
            source: 'QR',
            staffId: role,
            recordedByUserId: role,
            version: 1,
            supersedesId: null,
          });
          expect(lock.mock.calls[0][0].values).toEqual(['org-a', patient.id]);
          expect(createConsent).toHaveBeenCalledOnce();
        }
        expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path: `pharmacyPrescriptions.${endpoint}`, outcome: 'SUCCESS' })
        );
      }
    );

    it('retains the module gate for an authorized pharmacist', async () => {
      mocks.hasModule.mockReturnValue(false);
      await expect(invoke(caller(writeContext('pharmacist')))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(createPatient).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(createConsent).not.toHaveBeenCalled();
    });
  });

  // DEV-832 (F09): a new grant is refused to staff outside consent capture,
  // exactly like the withdrawal above, and still recorded for a pharmacist.
  describe('recordConsent grant authorization', () => {
    const createConsent = vi.fn();
    const transaction = vi.fn();
    const grant = (api: ReturnType<typeof caller>) =>
      api.recordConsent({
        patientId: patient.id,
        purpose: 'REMINDERS',
        channel: 'SMS',
        granted: true,
      });
    function grantContext(role: string) {
      const ctx = patientContext(role);
      ctx.db = { ...ctx.db, $transaction: transaction } as typeof ctx.db;
      return ctx;
    }

    beforeEach(() => {
      createConsent.mockImplementation(async ({ data }) => data);
      transaction.mockImplementation(async (run) =>
        run({
          $queryRaw: vi.fn().mockResolvedValue([{ id: patient.id }]),
          patientConsent: { findFirst: vi.fn().mockResolvedValue(null), create: createConsent },
        })
      );
    });

    it.each(['manager', 'cashier', 'procurement', 'inventory', 'finance', 'auditor'])(
      'refuses a %s grant before any consent write',
      async (role) => {
        await expect(grant(caller(grantContext(role)))).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(createConsent).not.toHaveBeenCalled();
      }
    );

    it('records a pharmacist grant bound to the exact purpose, channel and decision', async () => {
      await expect(grant(caller(grantContext('pharmacist')))).resolves.toMatchObject({
        patientId: patient.id,
        purpose: 'REMINDERS',
        channel: 'SMS',
        granted: true,
        revokedAt: null,
        staffId: 'pharmacist',
        recordedByUserId: 'pharmacist',
      });
      expect(createConsent).toHaveBeenCalledOnce();
    });
  });

  describe.each(['readPatient', 'exportPatient'] as const)('%s', (endpoint) => {
    it.each(['cashier', 'procurement'])(
      'denies %s before patient lookup or patient audit',
      async (role) => {
        const ctx = patientContext(role);
        await expect(caller(ctx)[endpoint]({ patientId: patient.id })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(mocks.can).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: role }),
          'pharmacy:prescriptions',
          undefined,
          { db: ctx.db, source: 'TRPC', ip: null }
        );
        expect(mocks.patientRecord).not.toHaveBeenCalled();
        expect(mocks.patientAudit).not.toHaveBeenCalled();
        expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path: `pharmacyPrescriptions.${endpoint}`, outcome: 'FAILURE' })
        );
      }
    );

    it('honors an explicit prescription DENY even for the owner', async () => {
      await expect(
        caller(patientContext('owner', true))[endpoint]({ patientId: patient.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.patientRecord).not.toHaveBeenCalled();
      expect(mocks.patientAudit).not.toHaveBeenCalled();
    });

    it('retains the module gate for an otherwise permitted pharmacist', async () => {
      mocks.hasModule.mockReturnValue(false);
      await expect(
        caller(patientContext('pharmacist'))[endpoint]({ patientId: patient.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.patientRecord).not.toHaveBeenCalled();
      expect(mocks.patientAudit).not.toHaveBeenCalled();
    });
  });

  it.each(['pharmacist', 'owner'])(
    'allows %s with the same masked identifiers and complete audited export',
    async (role) => {
      const patientCaller = caller(patientContext(role));
      const read = await patientCaller.readPatient({ patientId: patient.id });
      const exported = await patientCaller.exportPatient({ patientId: patient.id });
      const masked = { ...patient, cnic: '*********5671', phone: '*********4567' };
      const { consents, prescriptions, ...identity } = masked;
      expect(read).toEqual(identity);
      expect(exported).toEqual(masked);
      expect(exported.consents).toEqual(consents);
      expect(exported.prescriptions[0].lines[0].fills).toEqual(prescriptions[0].lines[0].fills);
      expect(patient.phone).toBe('+923001234567');
      expect(patient.cnic).toBe('35202-1234567-1');
      // Patient scope comes from the tenant DB, never a branch assignment.
      expect(mocks.patientRecord).toHaveBeenNthCalledWith(1, { where: { id: patient.id } });
      expect(mocks.patientRecord).toHaveBeenNthCalledWith(2, {
        where: { id: patient.id },
        include: {
          consents: true,
          prescriptions: { include: { lines: { include: { fills: true } } } },
        },
      });
      expect(mocks.patientAudit.mock.calls).toEqual(
        ['read', 'export'].map((action) => [
          {
            organizationId: 'org-a',
            actorId: role,
            source: 'TRPC',
            category: 'PHARMACY_PATIENT',
            operation: 'READ',
            action: `pharmacy.patient.${action}`,
            targetType: 'PharmacyPatient',
            targetId: patient.id,
            metadata: { protected: true, purpose: action === 'export' ? 'EXPORT' : 'DISPENSING' },
          },
        ])
      );
      expect(mocks.audit.mock.calls.map(([entry]) => entry.outcome)).toEqual([
        'SUCCESS',
        'SUCCESS',
      ]);
    }
  );
});

describe('PH-A3 prescription OCR prefill', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mocks.objects.clear();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    mocks.patient.mockResolvedValue({ id: 'patient-a' });
    mocks.find.mockResolvedValue(null);
    mocks.medicines.mockResolvedValue([
      { id: 'medicine-rx', productName: 'Fathomcillin E2E', brandName: null },
    ]);
    mocks.putUpload.mockImplementation(async (org, name, bytes) => {
      mocks.objects.set(`${org}/${name}`, bytes);
    });
    mocks.getUpload.mockImplementation(async (org, name) => {
      const bytes = mocks.objects.get(`${org}/${name}`);
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return bytes;
    });
  });

  it('is refused unless PHARMACY_RX_OCR_ADAPTER opts in, before reading storage', async () => {
    const receipt = await upload();
    mocks.getUpload.mockClear();
    await expect(caller().extractSource({ sourceFileRef: receipt.url })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('FIXTURE returns a proposal requiring confirmation and writes nothing', async () => {
    vi.stubEnv('PHARMACY_RX_OCR_ADAPTER', 'FIXTURE');
    const receipt = await upload();
    const ctx = context();
    const prefill = await caller(ctx).extractSource({ sourceFileRef: receipt.url });
    expect(prefill).toMatchObject({
      status: 'PROPOSED',
      requiresPharmacistConfirmation: true,
      adapter: 'FIXTURE',
      lines: [
        {
          drugName: { value: 'Fathomcillin' },
          dose: { value: '1 capsule every 8 hours for 5 days' },
          medicineCandidates: [{ medicineId: 'medicine-rx', label: 'Fathomcillin E2E' }],
        },
      ],
    });
    expect(mocks.medicines).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', saleable: true } })
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.putUpload).toHaveBeenCalledOnce();
    expect(ctx.audit.detail.skipInput).toBe(true);
  });

  it('applies the same uploader/tenant/role binding as preview', async () => {
    vi.stubEnv('PHARMACY_RX_OCR_ADAPTER', 'FIXTURE');
    const receipt = await upload();
    await expect(
      caller(context('user-b')).extractSource({ sourceFileRef: receipt.url })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller(context('user-a', 'org-b')).extractSource({ sourceFileRef: receipt.url })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mocks.can.mockResolvedValue(false);
    await expect(caller().extractSource({ sourceFileRef: receipt.url })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.can.mockResolvedValue(true);
    await expect(
      caller().extractSource({ sourceFileRef: 'https://foreign.test/rx.png' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.medicines).not.toHaveBeenCalled();
  });

  it('VISION without a configured provider fails with an operator sentence, not provider detail', async () => {
    vi.stubEnv('PHARMACY_RX_OCR_ADAPTER', 'VISION');
    vi.stubEnv('AI_PROVIDER', 'not-a-provider');
    const receipt = await upload();
    const failure = caller().extractSource({ sourceFileRef: receipt.url });
    await expect(failure).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'The prescription could not be read. Enter the details by hand.',
    });
    expect(mocks.medicines).not.toHaveBeenCalled();
  });

  it('DEV-63: drafts an unconfirmed cart with salt/strength matches from the OCR fixture', async () => {
    vi.stubEnv('PHARMACY_RX_OCR_ADAPTER', 'FIXTURE');
    const amox = { ingredientId: 'ing-amox', ingredient: { name: 'Amoxicillin' } };
    mocks.medicines.mockResolvedValue([
      {
        id: 'medicine-rx',
        productName: 'Fathomcillin E2E',
        brandName: null,
        strengths: [{ ...amox, value: { toString: () => '250' }, unit: 'mg' }],
        presentations: [{ id: 'pres-rx', presentation: 'Capsule' }],
      },
      {
        id: 'medicine-generic',
        productName: 'Generic Amox',
        brandName: null,
        strengths: [{ ...amox, value: { toString: () => '500' }, unit: 'mg' }],
        presentations: [],
      },
    ]);
    const receipt = await upload();
    const cart = await caller().draftCartFromSource({
      sourceFileRef: receipt.url,
      minConfidence: 0.7,
    });
    expect(cart).toMatchObject({
      status: 'DRAFT',
      requiresPharmacistConfirmation: true,
      lines: [
        {
          confirmed: false,
          lowConfidence: false,
          suggestedMedicineId: 'medicine-rx',
          suggestedPresentationId: 'pres-rx',
          candidates: [
            { medicineId: 'medicine-rx', matchKind: 'SALT_AND_STRENGTH' },
            { medicineId: 'medicine-generic', matchKind: 'SALT_ONLY' },
          ],
        },
      ],
    });
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().draftCartFromSource({ sourceFileRef: receipt.url, minConfidence: 0.7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('DEV-626 patient and prescriber registration', () => {
  function directoryContext() {
    const ctx = context();
    const patientCreate = vi.fn(async ({ data }) => ({ id: 'patient-new', ...data }));
    const prescriberFind = vi.fn().mockResolvedValue(null);
    const prescriberCreate = vi.fn(async ({ data }) => ({ id: 'prescriber-new', ...data }));
    ctx.db = {
      ...ctx.db,
      pharmacyPatient: { create: patientCreate },
      pharmacyPrescriber: { findFirst: prescriberFind, create: prescriberCreate },
    } as unknown as typeof ctx.db;
    return { ctx, patientCreate, prescriberFind, prescriberCreate };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
  });

  it('registers a prescriber with trimmed fields and blank optionals left absent', async () => {
    const { ctx, prescriberFind, prescriberCreate } = directoryContext();
    await expect(
      caller(ctx).createPrescriber({
        name: '  Dr Ayesha Khan ',
        registrationNumber: ' PMDC-12345 ',
        phone: '',
        facility: ' City Clinic ',
      })
    ).resolves.toMatchObject({ id: 'prescriber-new', registrationNumber: 'PMDC-12345' });
    expect(prescriberFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', registrationNumber: 'PMDC-12345' },
      })
    );
    expect(prescriberCreate).toHaveBeenCalledWith({
      data: {
        name: 'Dr Ayesha Khan',
        registrationNumber: 'PMDC-12345',
        phone: undefined,
        facility: 'City Clinic',
      },
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:prescriptions',
      undefined,
      expect.anything()
    );
  });

  it('refuses a duplicate registration number, including a concurrent insert', async () => {
    const { ctx, prescriberFind, prescriberCreate } = directoryContext();
    prescriberFind.mockResolvedValueOnce({ id: 'existing' });
    const input = { name: 'Dr A', registrationNumber: 'PMDC-1' };
    await expect(caller(ctx).createPrescriber(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(prescriberCreate).not.toHaveBeenCalled();

    prescriberCreate.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(caller(ctx).createPrescriber(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('registers a patient with trimmed fields and keeps identifiers out of the audit input', async () => {
    const { ctx, patientCreate } = directoryContext();
    const created = await caller(ctx).createPatient({
      displayName: ' Synthetic Patient ',
      cnic: '35202-1234567-1',
      phone: '',
    });
    expect(patientCreate).toHaveBeenCalledWith({
      data: { displayName: 'Synthetic Patient', cnic: '35202-1234567-1', phone: undefined },
    });
    expect(created).toMatchObject({ id: 'patient-new', displayName: 'Synthetic Patient' });
    expect(ctx.audit.detail.skipInput).toBe(true);
  });

  it.each([
    ['without the prescription permission', () => mocks.can.mockResolvedValue(false)],
    ['without the dispensing module', () => mocks.hasModule.mockReturnValue(false)],
  ])('refuses both registrations %s before writing', async (_label, deny) => {
    deny();
    const { ctx, patientCreate, prescriberCreate } = directoryContext();
    await expect(caller(ctx).createPatient({ displayName: 'Patient' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(ctx).createPrescriber({ name: 'Dr A', registrationNumber: 'PMDC-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(patientCreate).not.toHaveBeenCalled();
    expect(prescriberCreate).not.toHaveBeenCalled();
  });
});

// DEV-938: a refill reminder is recorded only at a branch the caller works at.
describe('DEV-938 refill reminder branch assignment', () => {
  const branchFind = vi.fn();
  const assignmentFind = vi.fn();
  const fillFind = vi.fn();
  const consentFind = vi.fn();
  const reminderCreate = vi.fn();

  const reminderInput = {
    branchId: 'branch-a',
    fillId: 'fill-a',
    channel: 'SMS' as const,
    directionsUrdu: 'Synthetic Urdu directions',
    idempotencyKey: 'reminder-key-a',
  };

  function reminderContext(role: 'ADMIN' | 'EMPLOYEE', userId = 'pharmacist-a') {
    const ctx = context(userId);
    ctx.session!.user.role = role;
    if (userId === 'owner-a')
      vi.mocked(ctx.db.user.findUnique).mockResolvedValue({
        role,
        status: 'ACTIVE',
        organizationRole: { key: 'owner', isSystem: true, permissions: [] },
        permissionOverrides: [],
      } as never);
    ctx.db = {
      ...ctx.db,
      pharmacyBranch: { findFirst: branchFind },
      pharmacyBranchAssignment: { findFirst: assignmentFind },
      prescriptionFill: { findFirst: fillFind },
      patientConsent: { findFirst: consentFind },
      pharmacyRefillReminderCapture: { create: reminderCreate },
    } as unknown as typeof ctx.db;
    return ctx;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    // Scoped to the session organization: another tenant's branch is not found.
    branchFind.mockImplementation(async ({ where }) =>
      where.id === 'branch-a' && where.organizationId === 'org-a' && where.active !== false
        ? { id: 'branch-a' }
        : null
    );
    assignmentFind.mockResolvedValue(null);
    fillFind.mockResolvedValue({
      id: 'fill-a',
      prescriptionLineId: 'line-a',
      // DEV-962: dispensed at branch-a, the branch these reminders are recorded at.
      branchId: 'branch-a',
      dispensedAt: new Date('2026-11-01T00:00:00.000Z'),
      quantityCanonicalUnits: 20,
      line: {
        directions: 'Take one tablet twice a day',
        medicine: { rx: false, productName: 'Synthetic medicine', strengths: [] },
        presentation: { dosageForm: 'Tablet', presentation: 'Tablet' },
        prescription: { patientId: 'patient-a' },
      },
    });
    consentFind.mockResolvedValue({ id: 'consent-a', granted: true });
    reminderCreate.mockImplementation(async ({ data }) => ({ id: 'reminder-a', ...data }));
  });

  it('refuses a pharmacist not assigned to the branch and writes nothing', async () => {
    const ctx = reminderContext('EMPLOYEE');
    await expect(caller(ctx).captureRefillReminder(reminderInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(assignmentFind).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org-a',
        userId: 'pharmacist-a',
        branchId: 'branch-a',
        active: true,
        branch: { organizationId: 'org-a', active: true },
        user: { organizationId: 'org-a', status: 'ACTIVE' },
      },
      select: { branchId: true },
    });
    expect(fillFind).not.toHaveBeenCalled();
    expect(consentFind).not.toHaveBeenCalled();
    expect(reminderCreate).not.toHaveBeenCalled();
    // The refused attempt is still recorded, against the branch it targeted.
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: 'pharmacyPrescriptions.captureRefillReminder',
        outcome: 'FAILURE',
      })
    );
    expect(ctx.audit.detail.metadata).toMatchObject({ branchId: 'branch-a' });
  });

  it('gives another organization’s branch the same refusal as a missing branch', async () => {
    const outcomes = [];
    for (const branchId of ['branch-of-org-b', 'branch-missing']) {
      const ctx = reminderContext('EMPLOYEE');
      outcomes.push(
        await caller(ctx)
          .captureRefillReminder({ ...reminderInput, branchId })
          .then(
            () => null,
            (error: { code: string; message: string }) => ({
              code: error.code,
              message: error.message,
            })
          )
      );
      expect(ctx.audit.detail.metadata?.branchId).toBeUndefined();
    }
    expect(outcomes).toEqual([
      { code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' },
      { code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' },
    ]);
    expect(branchFind).toHaveBeenCalledWith({
      where: { id: 'branch-of-org-b', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    expect(assignmentFind).not.toHaveBeenCalled();
    expect(fillFind).not.toHaveBeenCalled();
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it('records the reminder for a pharmacist assigned to the branch', async () => {
    assignmentFind.mockResolvedValue({ branchId: 'branch-a' });
    const ctx = reminderContext('EMPLOYEE');
    await expect(caller(ctx).captureRefillReminder(reminderInput)).resolves.toMatchObject({
      branchId: 'branch-a',
      capturedByUserId: 'pharmacist-a',
    });
    expect(reminderCreate).toHaveBeenCalledOnce();
    expect(ctx.audit.detail.metadata).toMatchObject({ branchId: 'branch-a' });
  });

  it('requires the original dispensing branch for an assigned non-owner administrator', async () => {
    const ctx = reminderContext('ADMIN', 'admin-a');
    assignmentFind.mockResolvedValue({ branchId: 'branch-a' });
    fillFind.mockResolvedValue({ id: 'fill-a', branchId: 'branch-b' });
    await expect(caller(ctx).captureRefillReminder(reminderInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'FILL_DISPENSED_AT_ANOTHER_BRANCH',
    });
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it('leaves the owner able to record at any branch of the organization', async () => {
    const ctx = reminderContext('ADMIN', 'owner-a');
    await expect(caller(ctx).captureRefillReminder(reminderInput)).resolves.toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      capturedByUserId: 'owner-a',
    });
    expect(assignmentFind).not.toHaveBeenCalled();
    expect(reminderCreate).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: 'pharmacyPrescriptions.captureRefillReminder',
        outcome: 'SUCCESS',
      })
    );
    expect(ctx.audit.detail.metadata).toMatchObject({ branchId: 'branch-a' });
  });

  // DEV-962: only the branch that dispensed the fill takes its one reminder slot.
  it.each([
    ['dispensed at another branch', 'branch-b', 'FILL_DISPENSED_AT_ANOTHER_BRANCH'],
    ['with no recorded dispensing branch', null, 'FILL_BRANCH_UNKNOWN'],
  ])(
    'refuses a pharmacist of this branch a fill %s and writes nothing',
    async (_case, dispensedAt, message) => {
      assignmentFind.mockResolvedValue({ branchId: 'branch-a' });
      fillFind.mockResolvedValue({ id: 'fill-a', branchId: dispensedAt });
      const ctx = reminderContext('EMPLOYEE');
      await expect(caller(ctx).captureRefillReminder(reminderInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message,
      });
      expect(fillFind).toHaveBeenCalledExactlyOnceWith({
        where: { id: 'fill-a', organizationId: 'org-a' },
        select: { branchId: true },
      });
      expect(consentFind).not.toHaveBeenCalled();
      expect(reminderCreate).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          path: 'pharmacyPrescriptions.captureRefillReminder',
          outcome: 'FAILURE',
        })
      );
      expect(ctx.audit.detail.metadata).toMatchObject({ branchId: 'branch-a' });
    }
  );

  it.each([
    ['dispensed at another branch', 'branch-b'],
    ['with no recorded dispensing branch', null],
  ])('leaves the owner able to record the reminder of a fill %s', async (_case, dispensedAt) => {
    const ctx = reminderContext('ADMIN', 'owner-a');
    const fill = await fillFind();
    fillFind.mockReset();
    fillFind.mockResolvedValue({ ...fill, branchId: dispensedAt });
    await expect(caller(ctx).captureRefillReminder(reminderInput)).resolves.toMatchObject({
      branchId: 'branch-a',
      capturedByUserId: 'owner-a',
    });
    expect(reminderCreate).toHaveBeenCalledOnce();
  });
});

describe('DEV-962 a fill records the branch that dispensed it', () => {
  const branchFind = vi.fn();
  const assignmentFind = vi.fn();
  const fillCreate = vi.fn();
  const fillInput = {
    id: 'fill-branch',
    prescriptionLineId: 'line-ordinary',
    fillSequence: 1,
    quantityCanonicalUnits: 2,
    idempotencyKey: 'fill-key-branch',
  };

  function fillContext(role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE') {
    const ctx = context('pharmacist-a');
    ctx.session!.user.role = role;
    ctx.db = {
      ...ctx.db,
      pharmacyBranch: { findFirst: branchFind },
      pharmacyBranchAssignment: { findFirst: assignmentFind },
      prescriptionFill: { create: fillCreate },
    } as unknown as typeof ctx.db;
    return ctx;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    mocks.prescriptionLine.mockResolvedValue({ medicine: { controlled: false } });
    branchFind.mockImplementation(async ({ where }) =>
      where.id === 'branch-a' && where.organizationId === 'org-a' && where.active !== false
        ? { id: 'branch-a' }
        : null
    );
    assignmentFind.mockResolvedValue(null);
    fillCreate.mockImplementation(async ({ data }) => data);
  });

  it('stores the dispensing branch of a pharmacist assigned to it', async () => {
    assignmentFind.mockResolvedValue({ branchId: 'branch-a' });
    await expect(
      caller(fillContext()).fill({ ...fillInput, branchId: 'branch-a' })
    ).resolves.toMatchObject({ branchId: 'branch-a', dispensedByUserId: 'pharmacist-a' });
    expect(fillCreate).toHaveBeenCalledExactlyOnceWith({
      data: { ...fillInput, branchId: 'branch-a', dispensedByUserId: 'pharmacist-a' },
    });
  });

  it('refuses a branch the pharmacist is not assigned to, and a branch not found', async () => {
    await expect(
      caller(fillContext()).fill({ ...fillInput, branchId: 'branch-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    await expect(
      caller(fillContext()).fill({ ...fillInput, branchId: 'branch-of-org-b' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' });
    expect(fillCreate).not.toHaveBeenCalled();
  });

  it('records fills only at an administrator’s admitted branch and permits the System Owner at any tenant branch', async () => {
    const ctx = fillContext('ADMIN');
    const api = caller(ctx);
    await expect(api.fill({ ...fillInput, branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(fillCreate).not.toHaveBeenCalled();
    assignmentFind.mockResolvedValue({ branchId: 'branch-a' });
    await expect(api.fill({ ...fillInput, branchId: 'branch-a' })).resolves.toMatchObject({
      branchId: 'branch-a',
    });
    assignmentFind.mockResolvedValue(null);
    vi.mocked(ctx.db.user.findUnique).mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: { key: 'owner', isSystem: true, permissions: [] },
      permissionOverrides: [],
    } as never);
    branchFind.mockResolvedValue({ id: 'branch-b' });
    await expect(
      api.fill({
        ...fillInput,
        id: 'owner-fill',
        idempotencyKey: 'owner-key',
        branchId: 'branch-b',
      })
    ).resolves.toMatchObject({ branchId: 'branch-b' });
  });
});
