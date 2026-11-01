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
const storage = vi.hoisted(() => ({
  getUpload: vi.fn(async () => Buffer.from('PK-archive')),
  putUpload: vi.fn(),
  deleteUpload: vi.fn(),
}));
vi.mock('@/lib/storage', () => storage);
// bcrypt is exercised by the credential module's own tests; here PIN 2468 is right.
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async (_type: string, pin: string) => pin === '2468'),
}));
const PIN = '2468';

import type { TRPCContext } from '../trpc';
import { pharmacyDataExportRouter } from './pharmacy-data-export';
import { exportRowsToCsv, PHARMACY_EXPORT_FILES } from '@/lib/pharmacy/data-export-format';

const NOW = new Date('2026-10-31T07:00:00.000Z');

type Row = Record<string, unknown>;
type Permission = {
  organizationId: string;
  capability: string;
  effect: 'ALLOW' | 'DENY';
  expiresAt?: Date | null;
};
type LiveUser = {
  id: string;
  organizationId: string;
  role: string;
  status: string;
  organizationRole: {
    organizationId: string;
    key: string;
    isSystem: boolean;
    permissions: Permission[];
  } | null;
  permissionOverrides: Permission[];
};

function fixture(
  options: {
    role?: 'ADMIN' | 'EMPLOYEE' | 'MANAGER';
    support?: boolean;
    vertical?: string;
    rows?: Row[];
    modules?: string[];
    credential?: Row | null;
  } = {}
) {
  const rows: Row[] = options.rows ?? [];
  const currentUser: LiveUser = {
    id: 'owner-1',
    organizationId: 'org-a',
    role: options.role ?? 'ADMIN',
    status: 'ACTIVE',
    organizationRole: {
      organizationId: 'org-a',
      key: 'admin',
      isSystem: true,
      permissions: [{ organizationId: 'org-a', capability: '*', effect: 'ALLOW' }],
    },
    permissionOverrides: [],
  };
  const credential =
    options.credential === undefined
      ? { id: 'cred-1', credentialHash: 'hash', failedAttempts: 0, lockedUntil: null }
      : options.credential;
  const database = {
    user: {
      findFirst: vi.fn(async (): Promise<LiveUser | null> => ({
        ...currentUser,
        permissionOverrides: currentUser.permissionOverrides.filter(
          (rule) => !rule.expiresAt || rule.expiresAt > new Date()
        ),
      })),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      update: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => []),
    medicine: { create: vi.fn(async () => ({ id: 'imported-medicine' })) },
    // The migration wizard's source evidence and profiled batch for a catalogue import.
    pharmacyMigrationSource: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Row }) => ({ id: 'mig-source-1', ...args.data })),
    },
    pharmacyMigrationBatch: {
      create: vi.fn(async () => ({ id: 'mig-batch-1' })),
      update: vi.fn(async () => ({})),
    },
    pharmacyMigrationRow: {
      createMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [{ id: 'mig-row-1', sourceKey: 'foreign-id' }]),
    },
    pharmacyMigrationException: { createMany: vi.fn(async () => ({ count: 0 })) },
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
    entitlements: {
      organizationId: 'org-a',
      enabledModules: options.modules ?? ['pharmacy-core'],
      modules: [],
    },
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
    currentUser,
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
  audit.recordTrpcAudit.mockClear();
  storage.getUpload.mockClear();
});

describe('pharmacy owner data export router', () => {
  async function expectAllProceduresForbidden(f: ReturnType<typeof fixture>) {
    for (const invoke of [
      () => f.caller.list(),
      () => f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN }),
      () => f.caller.download({ id: 'exp-1', pin: PIN }),
      () => f.caller.importCatalogue({ csv: '' }),
      () => f.caller.importStockLots({ csv: '' }),
    ]) {
      await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.findMany).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
    expect(storage.getUpload).not.toHaveBeenCalled();
  }

  it('allows the live system owner even when the session and database base roles are EMPLOYEE', async () => {
    const f = fixture({ role: 'EMPLOYEE', rows: [readyRow()] });
    f.currentUser.organizationRole = {
      organizationId: 'org-a', key: 'owner', isSystem: true, permissions: [],
    };
    await expect(f.caller.list()).resolves.toHaveLength(1);
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN }))
      .resolves.toMatchObject({ created: true });
    await expect(f.caller.download({ id: 'exp-1', pin: PIN }))
      .resolves.toMatchObject({ data: Buffer.from('PK-archive') });
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(3);
    expect(f.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'owner-1', organizationId: 'org-a', status: 'ACTIVE' },
      select: expect.objectContaining({
        organizationRole: { select: expect.objectContaining({
          organizationId: true, key: true, isSystem: true,
          permissions: {
            where: { organizationId: 'org-a' },
            select: { organizationId: true, capability: true, effect: true },
          },
        }) },
        permissionOverrides: {
          where: { organizationId: 'org-a', OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] },
          select: { organizationId: true, capability: true, effect: true },
        },
      }),
    });
  });

  it('uses the live ADMIN and wildcard override even when the session role is stale', async () => {
    const f = fixture({ role: 'EMPLOYEE' });
    f.currentUser.role = 'ADMIN';
    f.currentUser.organizationRole = null;
    f.currentUser.permissionOverrides = [{
      organizationId: 'org-a', capability: '*', effect: 'ALLOW',
      expiresAt: new Date(NOW.getTime() + 60_000),
    }];
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN }))
      .resolves.toMatchObject({ created: true });
  });

  it.each([
    'ordinary admin', 'missing user', 'inactive owner', 'different actor', 'other tenant user',
    'fake owner role', 'other tenant owner role', 'other tenant role grant',
    'other tenant override', 'owner-operator employee', 'expired wildcard override',
  ])('refuses %s before any export, import, or PIN access', async (scenario) => {
    const f = fixture({ rows: [readyRow()] });
    const role = f.currentUser.organizationRole!;
    switch (scenario) {
      case 'ordinary admin':
        role.permissions = [{ organizationId: 'org-a', capability: 'admin:access', effect: 'ALLOW' }];
        break;
      case 'missing user': f.db.user.findFirst.mockResolvedValue(null); break;
      case 'inactive owner': f.currentUser.status = 'INACTIVE'; break;
      case 'different actor': f.currentUser.id = 'other-user'; break;
      case 'other tenant user': f.currentUser.organizationId = 'org-b'; break;
      case 'fake owner role':
        Object.assign(role, { key: 'owner', isSystem: false, permissions: [] });
        break;
      case 'other tenant owner role':
        Object.assign(role, { key: 'owner', organizationId: 'org-b', permissions: [] });
        break;
      case 'other tenant role grant': role.permissions[0]!.organizationId = 'org-b'; break;
      case 'other tenant override':
        role.permissions = [];
        f.currentUser.permissionOverrides = [{ organizationId: 'org-b', capability: '*', effect: 'ALLOW' }];
        break;
      case 'owner-operator employee':
        f.currentUser.role = 'EMPLOYEE';
        role.key = 'owner-operator';
        break;
      case 'expired wildcard override':
        role.permissions = [];
        f.currentUser.permissionOverrides = [{ organizationId: 'org-a', capability: '*', effect: 'ALLOW', expiresAt: NOW }];
        break;
    }
    await expectAllProceduresForbidden(f);
    expect(audit.recordTrpcAudit).toHaveBeenCalledTimes(5);
    expect(audit.recordTrpcAudit.mock.calls.every(([entry]) => entry.outcome === 'FAILURE')).toBe(true);
  });

  it.each(['*', 'admin:*', 'admin:access', 'pharmacy:*', 'pharmacy:manage'])(
    'applies %s DENY before both ownership allowances', async (capability) => {
      for (const key of ['owner', 'admin']) {
        for (const source of ['role', 'override']) {
          const f = fixture({ rows: [readyRow()] });
          f.currentUser.organizationRole!.key = key;
          const rules = source === 'role'
            ? f.currentUser.organizationRole!.permissions
            : f.currentUser.permissionOverrides;
          rules.push({ organizationId: 'org-a', capability, effect: 'DENY' });
          await expectAllProceduresForbidden(f);
        }
      }
    }
  );

  it('does not apply expired, foreign-tenant, or unrelated DENYs', async () => {
    const f = fixture();
    f.currentUser.permissionOverrides = [
      { organizationId: 'org-a', capability: '*', effect: 'DENY', expiresAt: NOW },
      { organizationId: 'org-b', capability: '*', effect: 'DENY' },
      { organizationId: 'org-a', capability: 'hotel:*', effect: 'DENY' },
    ];
    await expect(f.caller.list()).resolves.toEqual([]);
  });

  it.each(['system role', 'wildcard grant', 'ADMIN status'])(
    'rechecks %s revocation on the same caller without a session refresh', async (authority) => {
      const f = fixture();
      const role = f.currentUser.organizationRole!;
      if (authority === 'system role') {
        role.key = 'owner';
        role.permissions = [];
      }
      await expect(f.caller.list()).resolves.toEqual([]);
      if (authority === 'system role') role.key = 'manager';
      if (authority === 'wildcard grant') role.permissions = [];
      if (authority === 'ADMIN status') f.currentUser.role = 'EMPLOYEE';
      f.db.pharmacyDataExport.findMany.mockClear();
      await expectAllProceduresForbidden(f);
      expect(f.db.user.findFirst).toHaveBeenCalledTimes(6);
      expect(f.context.session.user.role).toBe('ADMIN');
    }
  );

  it('rejects a cross-tenant session before looking up ownership', async () => {
    const f = fixture();
    f.context.session.user.organizationId = 'org-b';
    await expectAllProceduresForbidden(f);
    expect(f.db.user.findFirst).not.toHaveBeenCalled();
  });

  it('fails closed if the live ownership lookup fails', async () => {
    const f = fixture();
    f.db.user.findFirst.mockRejectedValue(new Error('database unavailable'));
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('imports catalogue-only rows as audited drafts in the owner session tenant', async () => {
    const f = fixture({ role: 'EMPLOYEE' });
    Object.assign(f.currentUser.organizationRole!, { key: 'owner', permissions: [] });
    const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, [{
      code: 'foreign-id', medicine_code: 'foreign-id', product: 'Catalogue medicine',
      product_family: 'PHARMACEUTICAL', rx: true, otc: false, restricted: false,
      controlled: false, high_alert: false, lasa: false, cold_chain: false, saleable: true,
    }]);
    await expect(f.caller.importCatalogue({ csv })).resolves.toEqual({
      sourceId: 'mig-source-1', batchId: 'mig-batch-1', exceptionCount: 0,
      rows: 1, medicines: 1, presentations: 0, packs: 0,
    });
    // Imported through the wizard: source evidence plus one profiled row per CSV row.
    expect(f.db.pharmacyMigrationSource.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      kind: 'EXCEL_CSV', fileName: 'medicines.csv',
    }) });
    expect(f.db.pharmacyMigrationBatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sourceId: 'mig-source-1', profilerVersion: 'devfathom-catalogue/1',
    }) });
    expect(f.db.pharmacyMigrationRow.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      batchId: 'mig-batch-1', sourceKey: 'foreign-id', productName: 'Catalogue medicine',
      batchNumber: null, expiryDate: null, mrpMinor: null,
    })] });
    expect(f.db.pharmacyMigrationException.createMany).not.toHaveBeenCalled();
    expect(f.db.medicine.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: 'org-a', productName: 'Catalogue medicine', saleable: false,
      provenance: { create: expect.objectContaining({ sourceType: 'IMPORT', status: 'UNREVIEWED' }) },
    }) });
    expect(audit.annotateAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pharmacy.dataExport.catalogueImported', metadata: expect.objectContaining({ medicines: 1 }),
    }));
  });

  it('profiles multi-lot stock-lots.csv into one reviewable batch without duplicate exceptions', async () => {
    const f = fixture({ role: 'EMPLOYEE' });
    Object.assign(f.currentUser.organizationRole!, { key: 'owner', permissions: [] });
    const shared = {
      product: 'Panadol 500mg', pack: 10, expiry: '2027-06-30', cost: '1.50', mrp: '25.00',
      branch_code: 'MAIN', batch_state: 'ACTIVE', medicine_code: 'med-1',
    };
    const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES.stockLots, [
      { ...shared, code: 'lot-1:A:AVAILABLE', batch: 'B1', quantity: 40, lot_code: 'lot-1', location_code: 'A', disposition: 'AVAILABLE' },
      { ...shared, code: 'lot-1:B:AVAILABLE', batch: 'B1', quantity: 20, lot_code: 'lot-1', location_code: 'B', disposition: 'AVAILABLE' },
      { ...shared, code: 'lot-2:A:AVAILABLE', batch: 'B2', quantity: 30, lot_code: 'lot-2', location_code: 'A', disposition: 'AVAILABLE' },
    ]);
    await expect(f.caller.importStockLots({ csv })).resolves.toMatchObject({
      sourceId: 'mig-source-1', batchId: 'mig-batch-1', rowCount: 3, exceptionCount: 0,
    });
    expect(f.db.pharmacyMigrationBatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      profilerVersion: 'devfathom-stock-lots/1',
    }) });
    const persisted = (f.db.pharmacyMigrationRow.createMany.mock.calls[0] as unknown as [
      { data: Array<{ sourceKey: string; rawPayload: Record<string, string> }> },
    ])[0].data;
    expect(persisted.map((row) => [row.sourceKey, row.rawPayload.lot_code, row.rawPayload.location_code]))
      .toEqual([
        ['lot-1:A:AVAILABLE', 'lot-1', 'A'],
        ['lot-1:B:AVAILABLE', 'lot-1', 'B'],
        ['lot-2:A:AVAILABLE', 'lot-2', 'A'],
      ]);
    expect(f.db.pharmacyMigrationException.createMany).not.toHaveBeenCalled();
    // Profiling only: no medicine or stock is written.
    expect(f.db.medicine.create).not.toHaveBeenCalled();
    expect(audit.annotateAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pharmacy.dataExport.stockLotsProfiled', targetId: 'mig-batch-1',
    }));
  });

  it('refuses a sheet that is not stock-lots.csv on the stock path before writing anything', async () => {
    const f = fixture();
    await expect(f.caller.importStockLots({ csv: 'product,batch\nPanadol,B1' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
    const employee = fixture({ role: 'EMPLOYEE' });
    await expect(employee.caller.importStockLots({ csv: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a stock sheet on the catalogue path before writing anything', async () => {
    const f = fixture();
    await expect(f.caller.importCatalogue({ csv: 'product,batch\nPanadol,B1' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.medicine.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
  });

  it.each(['EMPLOYEE', 'MANAGER'] as const)('refuses a %s with FORBIDDEN (403)', async (role) => {
    const f = fixture({ role, rows: [readyRow()] });
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.importCatalogue({ csv: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(f.caller.download({ id: 'exp-1', pin: PIN })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it.each(['session', 'context'])('refuses support impersonation identified by the %s', async (source) => {
    const f = fixture({ support: source === 'session', rows: [readyRow()] });
    if (source === 'context') Object.assign(f.context, { support: { supportSessionId: 'sup-1' } });
    await expectAllProceduresForbidden(f);
    expect(f.db.user.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a workspace that is not a pharmacy', async () => {
    const f = fixture({ vertical: 'AGENCY' });
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('queues an owner request in the session organization and annotates the audit', async () => {
    const f = fixture();
    const result = await f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN });
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
    await expect(f.caller.request({ from: '2025-01-01', to: '2026-10-30', pin: PIN })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.request({ from: '2026-10-01', to: '2026-11-02', pin: PIN })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.request({ from: '2026-10-10', to: '2026-10-01', pin: PIN })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
  });

  it('downloads a ready archive, counts the download and audits it without the bytes', async () => {
    const f = fixture({ rows: [readyRow()] });
    const archive = await f.caller.download({ id: 'exp-1', pin: PIN });
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
    await expect(f.caller.download({ id: 'exp-1', pin: PIN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'This download link has expired. Request a new export.',
    });
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('cannot reach another organization’s export', async () => {
    const f = fixture({ rows: [] });
    await expect(f.caller.download({ id: 'exp-other', pin: PIN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(f.db.pharmacyDataExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'exp-other', organizationId: 'org-a' } })
    );
  });
  it('refuses every procedure once the Pharmacy Core entitlement is gone, even on a standalone caller', async () => {
    // The download route and settings page call this router directly, so the
    // procedure path is `download` / `list`, not `pharmacyDataExport.*`.
    const f = fixture({ modules: [], rows: [readyRow()] });
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.download({ id: 'exp-1', pin: PIN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.importCatalogue({ csv: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storage.getUpload).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.findMany).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
  });

  it('requires the owner PIN to request an export and records a wrong one durably', async () => {
    const f = fixture();
    await expect(
      f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: '0000' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'That PIN is not correct.' });
    expect(f.db.pharmacyDataExport.create).not.toHaveBeenCalled();
    // The PIN check runs in its own transaction, so the strike survives the refusal.
    expect(f.db.$transaction).toHaveBeenCalled();
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
    // Only the owner's own active, device-independent PIN in this tenant counts.
    expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: { organizationId: 'org-a', userId: 'owner-1', status: 'ACTIVE' },
        }),
      })
    );
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacy.dataExport.pinRefused',
        metadata: { reason: 'REJECTED', step: 'requested' },
      })
    );
    expect(JSON.stringify(audit.annotateAudit.mock.calls)).not.toContain('0000');
  });

  it('requires the owner PIN to download and reads no bytes without it', async () => {
    const f = fixture({ rows: [readyRow()] });
    await expect(f.caller.download({ id: 'exp-1', pin: '1111' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(storage.getUpload).not.toHaveBeenCalled();
    expect(f.db.pharmacyDataExport.update).not.toHaveBeenCalled();
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacy.dataExport.pinRefused',
        targetId: 'exp-1',
        metadata: { reason: 'REJECTED', step: 'downloaded' },
      })
    );
  });

  it('refuses an owner with no PIN and a locked PIN without verifying it', async () => {
    const none = fixture({ credential: null });
    await expect(
      none.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Set up your staff PIN') });
    const locked = fixture({
      rows: [readyRow()],
      credential: {
        id: 'cred-1',
        credentialHash: 'hash',
        failedAttempts: 0,
        lockedUntil: new Date(NOW.getTime() + 60_000),
      },
    });
    await expect(locked.caller.download({ id: 'exp-1', pin: PIN })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(locked.db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('clears the PIN strikes after a correct owner PIN', async () => {
    const f = fixture();
    await f.caller.request({ from: '2026-01-01', to: '2026-10-30', pin: PIN });
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });
});
