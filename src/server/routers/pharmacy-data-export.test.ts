import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const audit = vi.hoisted(() => ({ annotateAudit: vi.fn(), recordTrpcAudit: vi.fn() }));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    recordTrpcAudit: audit.recordTrpcAudit,
    annotateAudit: (
      ctx: Parameters<typeof actual.annotateAudit>[0],
      detail: Parameters<typeof actual.annotateAudit>[1]
    ) => {
      audit.annotateAudit(ctx, detail);
      actual.annotateAudit(ctx, detail);
    },
  };
});
// The ABAC engine is exercised elsewhere; here `admin:access` is the owner role.
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async (subject: { role: string }, action: string) =>
    action === 'admin:access' ? subject.role === 'ADMIN' : false
  ),
}));
const storage = vi.hoisted(() => ({
  getUpload: vi.fn(async () => Buffer.from('PK-archive')),
  putUpload: vi.fn(),
  deleteUpload: vi.fn(),
}));
vi.mock('@/lib/storage', () => storage);

import type { TRPCContext } from '../trpc';
import { pharmacyDataExportRouter } from './pharmacy-data-export';
import { exportRowsToCsv, PHARMACY_EXPORT_FILES } from '@/lib/pharmacy/data-export-format';

const NOW = new Date('2026-10-31T07:00:00.000Z');

type Row = Record<string, unknown>;

function fixture(
  options: {
    role?: 'ADMIN' | 'EMPLOYEE' | 'MANAGER';
    support?: boolean;
    vertical?: string;
    rows?: Row[];
  } = {}
) {
  const rows: Row[] = options.rows ?? [];
  const database = {
    $queryRaw: vi.fn(async () => []),
    medicine: { create: vi.fn(async () => ({ id: 'imported-medicine' })) },
    pharmacyDataExport: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async (args: { where: { id?: string; status?: string } }) => {
        if (args.where.id) return rows.find((row) => row.id === args.where.id) ?? null;
        if (args.where.status) return rows.find((row) => row.status === args.where.status) ?? null;
        return null;
      }),
      count: vi.fn(async () => rows.length),
      create: vi.fn(async (args: { data: Row }) => ({
        id: 'exp-new',
        status: 'QUEUED',
        completedAt: null,
        expiresAt: null,
        sizeBytes: null,
        rowCounts: null,
        downloadCount: 0,
        error: null,
        ...args.data,
      })),
      update: vi.fn(async () => ({})),
    },
  };
  const db = Object.assign(database, {
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(database)),
  });
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'owner-1',
        role: options.role ?? 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org-a',
        ...(options.support ? { isSupportSession: true, supportSessionId: 'sup-1' } : {}),
      },
    },
    organization: { id: 'org-a', vertical: options.vertical ?? 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    caller: pharmacyDataExportRouter.createCaller(context as unknown as TRPCContext),
  };
}

function readyRow(extra: Row = {}): Row {
  return {
    id: 'exp-1',
    status: 'READY',
    salesFrom: new Date('2026-01-01T00:00:00.000Z'),
    salesTo: new Date('2026-10-30T00:00:00.000Z'),
    requestedAt: new Date('2026-10-31T06:00:00.000Z'),
    completedAt: new Date('2026-10-31T06:05:00.000Z'),
    expiresAt: new Date('2026-11-01T06:05:00.000Z'),
    sizeBytes: 10,
    rowCounts: { medicines: 3 },
    downloadCount: 0,
    error: null,
    storageKey: 'exp-1.zip',
    fileName: 'devfathom-pharmacy-export-2026-10-31-exp-1.zip',
    sha256: 'a'.repeat(64),
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  audit.annotateAudit.mockClear();
  storage.getUpload.mockClear();
});

describe('pharmacy owner data export router', () => {
  it('imports catalogue-only rows as audited drafts in the owner session tenant', async () => {
    const f = fixture();
    const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, [{
      code: 'foreign-id', medicine_code: 'foreign-id', product: 'Catalogue medicine',
      product_family: 'PHARMACEUTICAL', rx: true, otc: false, restricted: false,
      controlled: false, high_alert: false, lasa: false, cold_chain: false, saleable: true,
    }]);
    await expect(f.caller.importCatalogue({ csv })).resolves.toEqual({
      rows: 1, medicines: 1, presentations: 0, packs: 0,
    });
    expect(f.db.medicine.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: 'org-a', productName: 'Catalogue medicine', saleable: false,
      provenance: { create: expect.objectContaining({ sourceType: 'IMPORT', status: 'UNREVIEWED' }) },
    }) });
    expect(audit.annotateAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pharmacy.dataExport.catalogueImported', metadata: expect.objectContaining({ medicines: 1 }),
    }));
  });

  it('rejects a stock sheet on the catalogue path before writing anything', async () => {
    const f = fixture();
    await expect(f.caller.importCatalogue({ csv: 'product,batch\nPanadol,B1' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.medicine.create).not.toHaveBeenCalled();
  });

  it.each(['EMPLOYEE', 'MANAGER'] as const)('refuses a %s with FORBIDDEN (403)', async (role) => {
    const f = fixture({ role, rows: [readyRow()] });
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.importCatalogue({ csv: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(f.caller.download({ id: 'exp-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('refuses a platform support session acting as the owner', async () => {
    const f = fixture({ support: true, rows: [readyRow()] });
    await expect(f.caller.importCatalogue({ csv: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(f.caller.download({ id: 'exp-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('refuses a workspace that is not a pharmacy', async () => {
    const f = fixture({ vertical: 'RESTAURANT' });
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('queues an owner request in the session organization and annotates the audit', async () => {
    const f = fixture();
    const result = await f.caller.request({ from: '2026-01-01', to: '2026-10-30' });
    expect(result.created).toBe(true);
    expect(result.export).toMatchObject({ id: 'exp-new', status: 'QUEUED', downloadable: false });
    expect(f.db.pharmacyDataExport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-a',
          requestedByUserId: 'owner-1',
          salesFrom: new Date('2026-01-01T00:00:00.000Z'),
          salesTo: new Date('2026-10-30T00:00:00.000Z'),
        }),
      })
    );
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacy.dataExport.requested',
        targetType: 'PharmacyDataExport',
        targetId: 'exp-new',
      })
    );
  });

  it('rejects a range longer than 366 days or ending in the future', async () => {
    const f = fixture();
    await expect(f.caller.request({ from: '2025-01-01', to: '2026-10-30' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.request({ from: '2026-10-01', to: '2026-11-02' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.request({ from: '2026-10-10', to: '2026-10-01' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
  });

  it('downloads a ready archive, counts the download and audits it without the bytes', async () => {
    const f = fixture({ rows: [readyRow()] });
    const archive = await f.caller.download({ id: 'exp-1' });
    expect(archive.data.toString()).toBe('PK-archive');
    expect(archive.fileName).toBe('devfathom-pharmacy-export-2026-10-31-exp-1.zip');
    expect(storage.getUpload).toHaveBeenCalledWith('org-a/pharmacy-data-exports', 'exp-1.zip');
    expect(f.db.pharmacyDataExport.update).toHaveBeenCalledWith({
      where: { id: 'exp-1' },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: NOW },
    });
    const detail = audit.annotateAudit.mock.calls.at(-1)![1];
    expect(detail).toMatchObject({ action: 'pharmacy.dataExport.downloaded', targetId: 'exp-1' });
    expect(JSON.stringify(detail)).not.toContain('PK-archive');
  });

  it('refuses a link older than 24 hours', async () => {
    const f = fixture({
      rows: [readyRow({ expiresAt: new Date('2026-10-31T06:59:59.000Z') })],
    });
    await expect(f.caller.download({ id: 'exp-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'This download link has expired. Request a new export.',
    });
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('cannot reach another organization’s export', async () => {
    const f = fixture({ rows: [] });
    await expect(f.caller.download({ id: 'exp-other' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(f.db.pharmacyDataExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'exp-other', organizationId: 'org-a' } })
    );
  });
});
