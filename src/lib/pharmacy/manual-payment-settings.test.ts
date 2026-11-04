import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readManualPaymentSettings, saveManualPaymentSettings } from './manual-payment-settings';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
const settings = { RAAST: { destination: 'Merchant till', allowReferenceSkip: false } };
describe('#710 branch merchant settings', () => {
  it('returns an empty policy for existing branches and scopes every read', async () => {
    const findFirst = vi.fn().mockResolvedValue({ manualPaymentSettings: null, manualPaymentRevision: 0 });
    const db = { pharmacyBranch: { findFirst } } as unknown as ScopedDb;
    expect(await readManualPaymentSettings(db, scope)).toEqual({ settings: {}, revision: 0 });
    expect(findFirst).toHaveBeenCalledWith({ where: { organizationId: 'org', id: 'branch', active: true }, select: { manualPaymentSettings: true, manualPaymentRevision: true } });
    findFirst.mockResolvedValue(null);
    await expect(readManualPaymentSettings(db, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('saves by tenant, active branch and expected revision, refusing concurrent changes', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { pharmacyBranch: { updateMany } } as unknown as ScopedDb;
    expect(await saveManualPaymentSettings(db, scope, { settings, revision: 4 })).toEqual({ settings, revision: 5 });
    expect(updateMany).toHaveBeenCalledWith({ where: { organizationId: 'org', id: 'branch', active: true, manualPaymentRevision: 4 }, data: { manualPaymentSettings: settings, manualPaymentRevision: { increment: 1 } } });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(saveManualPaymentSettings(db, scope, { settings, revision: 4 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
