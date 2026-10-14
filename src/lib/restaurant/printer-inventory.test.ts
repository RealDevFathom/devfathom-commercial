import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { printerRegistrationSchema, printerRegistrationsSchema, registerPrinterInventoryInTransaction, registerPrintersForExistingBridge } from './printer-inventory';
import { enrollPrintBridgeWithinCommercialLimits } from './commercial-limits';

const printer = { name: 'Receipt', address: 'tcp://localhost:9100', paperWidthMm: 80 as const };
type Device = { id: string; branchId: string; kind: string; status: string; revokedAt: Date | null; deviceSecretHash: string };
let device: Device | undefined;
let active: boolean;
let missingBranch: boolean;
let rows: Record<string, unknown>[];
let codes: Record<string, unknown>[];
const order: string[] = [];
const raw = vi.fn(async (parts: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
  const sql = 'strings' in parts ? parts.strings.join('?') : parts.join('?');
  const bound = 'strings' in parts ? parts.values : values;
  if (sql.includes('FROM restaurant_branches')) {
    expect(sql).toContain('FOR SHARE'); expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(bound).toEqual(['branch']); order.push('branch-lock'); return missingBranch ? [] : [{ id: 'branch', active }];
  }
  if (sql.includes('FROM restaurant_registered_devices')) {
    expect(sql).toContain('FOR UPDATE'); expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(bound).toEqual([device?.id ?? 'bridge']); order.push('bridge-lock'); return device ? [device] : [];
  }
  order.push('org-lock'); return [{ id: 'org' }];
});
const createMany = vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => { order.push('printers'); rows.push(...data); return { count: data.length }; });
const count = vi.fn(async () => { order.push('count'); return 0; });
const deviceCreate = vi.fn(async ({ data }: { data: Device }) => { order.push('device'); device = { ...data, id: 'new', status: 'ACTIVE', revokedAt: null }; return device; });
const codeCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => { order.push('code'); codes.push(data); return { id: 'code', ...data }; });
const tx = { $queryRaw: raw, restaurantPrinter: { createMany }, restaurantRegisteredDevice: { count, create: deviceCreate },
  restaurantPrintBridgeEnrollmentCode: { create: codeCreate }, restaurantBranch: { findUnique: vi.fn(async () => ({ id: 'branch' })) } };
const transaction = vi.fn(async <T,>(run: (inner: typeof tx) => Promise<T>) => {
  const previous = { device: device && { ...device }, rows: [...rows], codes: [...codes] };
  try { return await run(tx); } catch (error) { device = previous.device; rows = previous.rows; codes = previous.codes; throw error; }
});
// Outer delegates deliberately fail: every write must use the actual transaction.
const outside = vi.fn(() => { throw new Error('outer delegate used'); });
const db = { $transaction: transaction, restaurantPrinter: { createMany: outside }, restaurantRegisteredDevice: { create: outside } } as unknown as ScopedDb;
const input = () => ({ branchId: 'branch', bridgeId: 'bridge', printers: [printer] });
const enroll = (printers?: typeof printer[]) => enrollPrintBridgeWithinCommercialLimits(db, { 'pos.registeredDevices.max': 2, 'pos.terminals.max': 0 }, { branchId: 'branch', name: 'Bridge', ...(printers ? { printers } : {}) });
beforeEach(() => {
  vi.clearAllMocks(); order.length = 0; rows = []; codes = []; active = true; missingBranch = false;
  device = { id: 'bridge', branchId: 'branch', kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null, deviceSecretHash: 'synthetic-test-hash' };
  count.mockImplementation(async () => { order.push('count'); return 0; });
});

describe('printer registration boundaries', () => {
  it.each(['QUEUE:///FrontDesk', 'QuEuE:///Front%20Desk', 'queue:///Front%20Desk', 'file:///dev/usb/lp0', '/dev/ttyUSB0', 'tcp://[::1]:9100'])('retains supported CLI address %s', (address) => {
    expect(printerRegistrationSchema.parse({ ...printer, address }).address).toBe(address);
  });
  it.each(['http://localhost', '/tmp/receipt', 'file:///etc/passwd', 'tcp://user:secret@localhost', 'tcp://localhost/path', 'tcp://localhost?secret=yes', 'queue:///bad%2Fname', 'queue:///bad%00name', 'tcp://localhost:65536', 'x'.repeat(129)])('rejects unusable target %s', (address) => {
    expect(printerRegistrationSchema.safeParse({ ...printer, address }).success).toBe(false);
  });
  it('requires strict fields, bounded names, paper sizes and one through twenty printers', () => {
    for (const entry of [{ ...printer, name: ' ' }, { ...printer, name: 'x'.repeat(121) }, { ...printer, paperWidthMm: 57 }, { ...printer, organizationId: 'other' }])
      expect(printerRegistrationSchema.safeParse(entry).success).toBe(false);
    expect(printerRegistrationsSchema.safeParse([]).success).toBe(false);
    expect(printerRegistrationsSchema.safeParse(Array(21).fill(printer)).success).toBe(false);
    expect(printerRegistrationsSchema.parse(Array(20).fill({ ...printer, name: 'x'.repeat(120), paperWidthMm: 58 }))).toHaveLength(20);
  });
  it('parses invalid existing-bridge input before opening a transaction', async () => {
    expect(() => registerPrintersForExistingBridge(db, { ...input(), printers: [] })).toThrow();
    expect(transaction).not.toHaveBeenCalled(); expect(createMany).not.toHaveBeenCalled();
  });
});

describe('transactional inventory registration', () => {
  it('locks active tenant branch and bridge before inserting derived target kinds', async () => {
    const printers = [printer, { ...printer, address: 'QUEUE:///FrontDesk' }, { ...printer, address: '/dev/usb/lp0' }];
    await expect(registerPrintersForExistingBridge(db, { ...input(), printers })).resolves.toBe(3);
    expect(order).toEqual(['branch-lock', 'bridge-lock', 'printers']);
    expect(rows.map((row) => row.connectionKind)).toEqual(['TCP', 'QUEUE', 'DEVICE_PATH']);
    expect(rows.every((row) => row.branchId === 'branch' && row.bridgeId === 'bridge' && !('organizationId' in row))).toBe(true);
    expect(codeCreate).not.toHaveBeenCalled(); expect(deviceCreate).not.toHaveBeenCalled(); expect(outside).not.toHaveBeenCalled();
  });
  it.each(['missing-branch', 'inactive-branch', 'missing-bridge', 'wrong-branch', 'POS', 'KDS', 'inactive-bridge', 'revoked'] as const)('denies %s after fresh locked reads without insert', async (condition) => {
    if (condition === 'missing-branch') missingBranch = true;
    if (condition === 'inactive-branch') active = false;
    if (condition === 'missing-bridge') device = undefined;
    if (condition === 'wrong-branch') device!.branchId = 'other';
    if (condition === 'POS' || condition === 'KDS') device!.kind = condition;
    if (condition === 'inactive-bridge') device!.status = 'INACTIVE';
    if (condition === 'revoked') device!.revokedAt = new Date();
    await expect(registerPrinterInventoryInTransaction(tx as unknown as Prisma.TransactionClient, input())).rejects.toThrow('not found');
    expect(createMany).not.toHaveBeenCalled();
  });
  it('propagates database failure to the owning transaction', async () => {
    createMany.mockRejectedValueOnce(new Error('inventory write failed'));
    await expect(registerPrintersForExistingBridge(db, input())).rejects.toThrow('inventory write failed');
    expect(rows).toEqual([]);
  });
});

describe('atomic optional inventory during new enrollment', () => {
  it('retains the zero-printer enrollment path', async () => {
    await expect(enroll()).resolves.toMatchObject({ printerCount: 0, device: { id: 'new' } });
    expect(createMany).not.toHaveBeenCalled(); expect(codeCreate).toHaveBeenCalledOnce();
  });
  it('uses one transaction for organization capacity, new device, printers and code', async () => {
    await expect(enroll([printer])).resolves.toMatchObject({ printerCount: 1, device: { id: 'new' } });
    expect(transaction).toHaveBeenCalledOnce(); expect(count).toHaveBeenCalledWith({ where: { status: 'ACTIVE' } });
    expect(order).toEqual(['org-lock', 'count', 'device', 'branch-lock', 'bridge-lock', 'printers', 'bridge-lock', 'code']);
    expect(rows[0].bridgeId).toBe('new'); expect(codes).toHaveLength(1); expect(outside).not.toHaveBeenCalled();
  });
  it('denies capacity before device, printer or code creation', async () => {
    count.mockResolvedValueOnce(2); await expect(enroll([printer])).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    expect(deviceCreate).not.toHaveBeenCalled(); expect(createMany).not.toHaveBeenCalled(); expect(codeCreate).not.toHaveBeenCalled();
  });
  it.each(['inventory', 'code'])('lets %s failure roll back the whole mocked transaction', async (failure) => {
    if (failure === 'inventory') createMany.mockRejectedValueOnce(new Error('failure'));
    else codeCreate.mockRejectedValueOnce(new Error('failure'));
    await expect(enroll([printer])).rejects.toThrow('failure');
    expect(device!.id).toBe('bridge'); expect(rows).toEqual([]); expect(codes).toEqual([]);
  });
});
