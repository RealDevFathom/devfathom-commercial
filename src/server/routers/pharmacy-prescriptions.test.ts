// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  hasModule: vi.fn(),
  patient: vi.fn(),
  prescriber: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  putUpload: vi.fn(),
  getUpload: vi.fn(),
  audit: vi.fn(),
  actor: vi.fn(),
  context: vi.fn(),
  medicines: vi.fn(),
  prescriptionLine: vi.fn(),
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
}));
vi.mock('@/server/trpc', async () => ({
  ...(await vi.importActual<typeof import('@/server/trpc')>('@/server/trpc')),
  createTRPCContext: mocks.context,
}));

import type { TRPCContext } from '../trpc';
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';
import { GET } from '@/app/api/pharmacy/prescription-files/route';
import { GET as sharedFileGET } from '@/app/api/files/[name]/route';

function context(userId = 'user-a', organizationId = 'org-a', status = 'ACTIVE') {
  return {
    db: {
      pharmacyPatient: { findFirst: mocks.patient },
      pharmacyPrescriber: { findFirst: mocks.prescriber },
      prescription: { findFirst: mocks.find, create: mocks.create },
      prescriptionLine: { findFirst: mocks.prescriptionLine },
      medicine: { findMany: mocks.medicines },
    },
    entitlements: { organizationId, modules: [], enabledModules: ['pharmacy-dispensing'] },
    session: { expires: 'later', user: { id: userId, organizationId, role: 'EMPLOYEE', status } },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
function caller(ctx = context()) {
  return pharmacyPrescriptionsRouter.createCaller(ctx);
}
async function upload() {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  return caller().uploadSource({
    patientId: 'patient-a',
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
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('allows pharmacists with dispensing capability', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:dispense');
    await expect(upload()).resolves.toHaveProperty('url');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('allows tenant administrators only when central ABAC finds an explicit dispense grant', async () => {
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
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('refuses a tenant administrator when central ABAC finds no exact dispense grant', async () => {
    mocks.can.mockResolvedValue(false);
    const admin = context();
    admin.session!.user.role = 'ADMIN';

    await expect(caller(admin).workspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

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

  it('captures a customer-request photo only through its patient and assigned branch, even after capture', async () => {
    const receipt = await upload();
    for (const [key, bytes] of mocks.objects) {
      const stored = JSON.parse(bytes.toString('utf8'));
      stored.uploadedByUserId = 'customer:customer-a';
      mocks.objects.set(key, Buffer.from(JSON.stringify(stored)));
    }
    const ctx = context();
    const query = vi.fn().mockResolvedValue([{ branchId: 'branch-a' }]);
    const assignment = vi.fn().mockResolvedValue({ id: 'assignment-a' });
    Object.assign(ctx.db, {
      $queryRaw: query,
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }) },
      pharmacyBranchAssignment: { findFirst: assignment },
    });
    await expect(caller(ctx).capture(captureInput(receipt.url))).resolves.toHaveProperty(
      'sourceFileRef',
      receipt.url
    );
    expect(query.mock.calls[0][0].values).toEqual(
      expect.arrayContaining(['org-a', receipt.url, 'patient-a', 'customer:customer-a'])
    );
    expect(assignment).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', branchId: 'branch-a', userId: 'user-a', active: true },
      })
    );
    mocks.find.mockResolvedValue({ id: 'already-captured' });
    assignment.mockResolvedValue(null);
    await expect(caller(ctx).readSource({ sourceFileRef: receipt.url })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    mocks.create.mockClear();
    await expect(caller(ctx).capture(captureInput(receipt.url))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.create).not.toHaveBeenCalled();
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
});
