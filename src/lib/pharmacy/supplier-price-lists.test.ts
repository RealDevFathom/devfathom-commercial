import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const approval = vi.hoisted(() => ({
  verifyPurchaseApprover: vi.fn(
    async (): Promise<{ blocked: string } | { verified: true }> => ({ verified: true })
  ),
}));
// Only an ADMIN holds `admin:access` in these fixtures; the router test runs the real engine.
const abac = vi.hoisted(() => ({
  can: vi.fn(async (subject: { role: string }, action: string) => action === 'admin:access' && subject.role === 'ADMIN'),
}));
vi.mock('@/lib/abac', () => ({
  can: abac.can,
  subjectFromSession: (user: { id: string; role?: string }) => ({ id: user.id, role: user.role ?? 'EMPLOYEE' }),
}));
vi.mock('./purchase-approval', () => ({
  APPROVAL_BLOCKED: 'An authorized approver must enter a valid PIN.',
  SOLO_OWNER_POLICY: 'PHARMACY_SOLO_OWNER_PIN',
  ...approval,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  decideSupplierPriceDrafts,
  importSupplierPriceList,
  matchPriceListRow,
  priceListColumns,
  readPriceListRows,
} from './supplier-price-lists';

const scope = { organizationId: 'org-a', actorId: 'owner' };

describe('DEV-681 price-list reading', () => {
  it('finds product, pack, barcode, TP and MRP columns by exact header synonyms', () => {
    expect(priceListColumns(['Sr', 'Item Name', 'Packing', 'T.P.', 'M.R.P', 'EAN'])).toEqual({
      product: 1,
      pack: 2,
      tradePrice: 3,
      mrp: 4,
      barcode: 5,
    });
  });

  it('refuses a list without a product or any price column', () => {
    expect(() => priceListColumns(['TP', 'MRP'])).toThrow(/Product/);
    expect(() => priceListColumns(['Product', 'Pack'])).toThrow(/TP/);
  });

  it('reads PKR amounts exactly into paisa and refuses an unreadable price', () => {
    const rows = readPriceListRows({
      headers: ['Product', 'Pack', 'TP', 'MRP'],
      rows: [
        ['Panadol 500mg', 'box', 'Rs 1,234.50', '1500'],
        ['Brufen 400mg', '', '', '320.5'],
      ],
    });
    expect(rows).toEqual([
      {
        rowNumber: 2,
        productText: 'Panadol 500mg',
        packText: 'box',
        barcode: null,
        listTradePriceMinor: 123450,
        listMrpMinor: 150000,
      },
      {
        rowNumber: 3,
        productText: 'Brufen 400mg',
        packText: null,
        barcode: null,
        listTradePriceMinor: null,
        listMrpMinor: 32050,
      },
    ]);
    expect(() =>
      readPriceListRows({ headers: ['Product', 'MRP'], rows: [['X', '12.345']] })
    ).toThrow(/Row 2: MRP/);
    expect(() => readPriceListRows({ headers: ['Product', 'TP'], rows: [['X', '']] })).toThrow(
      /Row 2: give a trade price or an MRP/
    );
  });
});

describe('DEV-681 catalogue matching', () => {
  function matchDb(over: Record<string, unknown> = {}) {
    return {
      medicineBarcode: { findFirst: vi.fn(async () => null) },
      medicine: { findMany: vi.fn(async () => [{ id: 'med-1' }]) },
      medicineAlias: { findMany: vi.fn(async () => []) },
      packLevel: {
        findFirst: vi.fn(async () => ({ id: 'box' })),
        findMany: vi.fn(async () => [{ id: 'box' }]),
      },
      ...over,
    } as unknown as ScopedDb;
  }

  it('matches a pack barcode outright', async () => {
    const db = matchDb({
      medicineBarcode: {
        findFirst: vi.fn(async () => ({ packLevelId: 'strip', presentation: { medicineId: 'med-9' } })),
      },
      packLevel: { findFirst: vi.fn(async () => ({ id: 'strip' })), findMany: vi.fn() },
    });
    await expect(
      matchPriceListRow(db, 'org-a', { productText: 'Anything', packText: null, barcode: '0123' })
    ).resolves.toEqual({ matchStatus: 'MATCHED', medicineId: 'med-9', packLevelId: 'strip' });
  });

  it('matches an exact name to the one outer pack, and leaves two candidates for a person', async () => {
    const db = matchDb();
    await expect(
      matchPriceListRow(db, 'org-a', { productText: 'Panadol', packText: null, barcode: null })
    ).resolves.toEqual({ matchStatus: 'MATCHED', medicineId: 'med-1', packLevelId: 'box' });
    const ambiguous = matchDb({
      medicineAlias: { findMany: vi.fn(async () => [{ medicineId: 'med-2' }]) },
    });
    await expect(
      matchPriceListRow(ambiguous, 'org-a', { productText: 'Panadol', packText: null, barcode: null })
    ).resolves.toMatchObject({ matchStatus: 'AMBIGUOUS', packLevelId: null });
    const packLevel = { findFirst: vi.fn(), findMany: vi.fn(async () => [{ id: 'box' }]) };
    await expect(
      matchPriceListRow(matchDb({ packLevel }), 'org-a', {
        productText: 'Panadol',
        packText: '10 tablets',
        barcode: null,
      })
    ).resolves.toMatchObject({ matchStatus: 'AMBIGUOUS', packLevelId: null });
    expect(packLevel.findMany).not.toHaveBeenCalled();
    const none = matchDb({ medicine: { findMany: vi.fn(async () => []) } });
    await expect(
      matchPriceListRow(none, 'org-a', { productText: 'Unknown', packText: null, barcode: null })
    ).resolves.toMatchObject({ matchStatus: 'NO_MATCH' });
  });
});

describe('DEV-681 import never changes a price', () => {
  function importDb() {
    const db = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
      $queryRaw: vi.fn(async (): Promise<unknown[]> => [{ stale: 0 }]),
      $executeRaw: vi.fn(async () => 1),
      pharmacySupplier: { findFirst: vi.fn(async () => ({ id: 'sup', name: 'Distributor' })) },
      pharmacySupplierPriceList: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'list-1' })),
      },
      pharmacySupplierPriceListLine: { createMany: vi.fn(async () => ({ count: 1 })) },
      pharmacyPackPrice: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      medicineBarcode: { findFirst: vi.fn(async () => null) },
      medicine: { findMany: vi.fn(async () => [{ id: 'med-1' }]) },
      medicineAlias: { findMany: vi.fn(async () => []) },
      packLevel: { findMany: vi.fn(async () => [{ id: 'box' }]) },
    };
    return db;
  }
  const bytes = Buffer.from('Product,TP,MRP\nPanadol,850,1000\n');
  const run = (db: ReturnType<typeof importDb>) =>
    importSupplierPriceList(db as unknown as ScopedDb, scope, { supplierId: 'sup', fileName: 'list.csv', bytes });

  it('replays the same file while its comparison is current, and compares afresh once a price moved', async () => {
    const db = importDb();
    db.pharmacySupplierPriceList.findFirst.mockResolvedValue({ id: 'list-0' } as never);
    await expect(run(db)).resolves.toEqual({ priceListId: 'list-0', replayed: true });
    expect(db.pharmacySupplierPriceList.create).not.toHaveBeenCalled();
    db.$queryRaw.mockImplementation(async () => [{ stale: 1 }]);
    await expect(run(db)).resolves.toEqual({ priceListId: 'list-1', replayed: false });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('stores the rows, lets SQL snapshot and draft, and writes no price policy', async () => {
    const db = importDb();
    await expect(
      importSupplierPriceList(db as unknown as ScopedDb, scope, {
        supplierId: 'sup',
        fileName: 'list.csv',
        bytes,
      })
    ).resolves.toEqual({ priceListId: 'list-1', replayed: false });
    expect(db.pharmacySupplierPriceListLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          priceListId: 'list-1',
          matchStatus: 'MATCHED',
          packLevelId: 'box',
          listTradePriceMinor: 85000,
          listMrpMinor: 100000,
        }),
      ],
    });
    const sql = (db.$executeRaw.mock.calls[0] as unknown as [{ strings: string[] }])[0].strings.join('?');
    expect(sql).toContain('"invoicedPricePerPackMinor"');
    expect(sql).toContain("g.status = 'POSTED'");
    expect(sql).toContain('LEAST(d.cp_sell, l."listMrpMinor")');
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'pharmacySupplierPriceLists.import' }),
    });
  });
});

describe('DEV-681 a person decides each draft', () => {
  let line: Record<string, unknown>;
  let db: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeEach(() => {
    line = {
      id: 'line-1',
      priceListId: 'list-1',
      rowNumber: 2,
      packLevelId: 'box',
      draftStatus: 'DRAFT',
      draftMrpMinor: 110000,
      draftSellingPriceMinor: 95000,
      currentPackPriceId: 'price-old',
      currentMrpMinor: 100000,
      currentSellingPriceMinor: 95000,
      priceList: { importedById: 'buyer' },
    };
    approval.verifyPurchaseApprover.mockResolvedValue({ verified: true });
    db = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
      $queryRaw: vi.fn(async () => []),
      pharmacySupplierPriceListLine: {
        findMany: vi.fn(async () => [line]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      packLevel: { findFirst: vi.fn(async () => ({ id: 'box', presentationId: 'pres' })) },
      pharmacyPackPrice: {
        findFirst: vi.fn(async () => ({ id: 'price-old' })),
        create: vi.fn(async ({ data }) => ({ id: 'price-new', ...data })),
      },
      auditLog: { create: vi.fn() },
      // Another active administrator exists unless a test says otherwise.
      user: {
        findMany: vi.fn(async () => [
          { id: 'admin-2', role: 'ADMIN', department: null, status: 'ACTIVE' },
          { id: 'cashier', role: 'EMPLOYEE', department: null, status: 'ACTIVE' },
        ]),
      },
    };
  });
  const onlyCashiersBesidesMe = () =>
    db.user.findMany.mockResolvedValue([
      { id: 'cashier', role: 'EMPLOYEE', department: null, status: 'ACTIVE' },
    ]);
  const decide = (decision: 'APPROVE' | 'REJECT', lineIds = ['line-1'], pin?: string) =>
    decideSupplierPriceDrafts(db as unknown as ScopedDb, scope, { lineIds, decision, pin });

  it('keeps separation: the importer cannot approve while another active admin could', async () => {
    line.priceList = { importedById: 'owner' };
    await expect(decide('APPROVE', ['line-1'], '1234')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('another owner or administrator'),
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', status: 'ACTIVE', id: { not: 'owner' } } })
    );
    expect(abac.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-2' }),
      'admin:access',
      undefined,
      expect.anything()
    );
    expect(approval.verifyPurchaseApprover).not.toHaveBeenCalled();
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
  });

  it('lets the sole admin (other staff are cashiers) self-approve with a fresh PIN, audited as self-approval', async () => {
    line.priceList = { importedById: 'owner' };
    onlyCashiersBesidesMe();
    await decide('APPROVE', ['line-1'], '1234');
    expect(approval.verifyPurchaseApprover).toHaveBeenLastCalledWith(db, {
      organizationId: 'org-a',
      approverId: 'owner',
      actorId: 'owner',
      pin: '1234',
    });
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'pharmacySupplierPriceLists.approveDraft',
        actorId: 'owner',
        metadata: {
          policy: 'PHARMACY_SOLO_OWNER_PIN',
          selfApproval: true,
          pinVerified: true,
          importedById: 'owner',
        },
      }),
    });
  });

  it('refuses a sole-admin self-approval with a wrong or missing PIN and writes no price', async () => {
    line.priceList = { importedById: 'owner' };
    onlyCashiersBesidesMe();
    approval.verifyPurchaseApprover.mockResolvedValue({
      blocked: 'An authorized approver must enter a valid PIN.',
    });
    await expect(decide('APPROVE', ['line-1'], '9999')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'An authorized approver must enter a valid PIN.',
    });
    await expect(decide('APPROVE')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplierPriceListLine.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('needs no PIN when a different owner approves', async () => {
    await decide('APPROVE');
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(approval.verifyPurchaseApprover).not.toHaveBeenCalled();
  });

  it('approval writes a supplier-sourced price policy under the price lock and audits it', async () => {
    await expect(decide('APPROVE')).resolves.toEqual([
      { id: 'line-1', decision: 'APPROVE', packPriceId: 'price-new' },
    ]);
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        packLevelId: 'box',
        mrpMinor: 110000,
        sellingPriceMinor: 95000,
        source: 'supplier',
        createdById: 'owner',
      }),
    });
    expect(db.pharmacySupplierPriceListLine.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'line-1', draftStatus: 'DRAFT' },
      data: expect.objectContaining({ draftStatus: 'APPROVED', decidedById: 'owner', packPriceId: 'price-new' }),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'pharmacySupplierPriceLists.approveDraft',
        changes: expect.objectContaining({ previousMrpMinor: 100000, mrpMinor: 110000 }),
      }),
    });
  });

  it('rejection records the person and writes no price', async () => {
    await decide('REJECT');
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplierPriceListLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ draftStatus: 'REJECTED', decidedById: 'owner', packPriceId: null }),
      })
    );
  });

  it('refuses a draft whose compared price changed since import', async () => {
    db.pharmacyPackPrice.findFirst.mockResolvedValue({ id: 'price-newer' });
    await expect(decide('APPROVE')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
  });

  it('never saves a selling price above the new MRP', async () => {
    line.draftSellingPriceMinor = 120000;
    await expect(decide('APPROVE')).rejects.toThrow('Selling price cannot exceed MRP');
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
  });

  it('refuses a draft that does not exist in this organization', async () => {
    db.pharmacySupplierPriceListLine.findMany.mockResolvedValue([]);
    await expect(decide('REJECT')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a row with no open draft, and a draft decided concurrently', async () => {
    line.draftStatus = 'APPROVED';
    await expect(decide('REJECT')).rejects.toThrow(/no open price draft/);
    line.draftStatus = 'DRAFT';
    db.pharmacySupplierPriceListLine.updateMany.mockResolvedValue({ count: 0 });
    await expect(decide('REJECT')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('bounds the selection', async () => {
    await expect(decide('APPROVE', [])).rejects.toThrow(/1–100/);
    await expect(decide('APPROVE', ['a', 'a'])).rejects.toThrow(/1–100/);
  });
});
