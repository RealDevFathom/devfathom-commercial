import { beforeEach, describe, expect, it, vi } from 'vitest';

const { can, independentDb, withTenantDb } = vi.hoisted(() => ({ can: vi.fn(), independentDb: { auditLog: { create: vi.fn() } }, withTenantDb: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can, subjectFromSession: () => ({}) }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb }));

import { authorizePharmacyGeneralJournal, authorizePharmacyGeneralJournalCollection, canOpenPharmacyGeneralJournal } from './pharmacy-general-journal-security';

describe('pharmacy general journal admission', () => {
  const auditCreate = independentDb.auditLog.create;
  const businessAuditCreate = vi.fn();
  const branchFindFirst = vi.fn();
  const context = () => ({
    session: { user: { id: 'user-1' } }, organization: { id: 'org-1' }, entitlements: { organizationId: 'org-1' },
    requestMeta: { ip: '127.0.0.1' }, db: { pharmacyBranch: { findFirst: branchFindFirst }, auditLog: { create: businessAuditCreate } },
  });

  beforeEach(() => { vi.clearAllMocks(); withTenantDb.mockImplementation(async (_organizationId, run) => run(independentDb)); can.mockResolvedValue(true); branchFindFirst.mockResolvedValue({ id: 'branch-1' }); auditCreate.mockResolvedValue({ id: 'audit-1' }); });

  it('awaits an independent, safe ADMITTED audit after canonical authorization', async () => {
    await expect(authorizePharmacyGeneralJournal(context() as never, 'branch-1')).resolves.toEqual({ organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ operation: 'OTHER', action: 'pharmacyGeneralJournal.admission', result: { decision: 'ADMITTED' }, outcome: 'SUCCESS' }) });
    expect(withTenantDb).toHaveBeenCalledWith('org-1', expect.any(Function), { userId: 'user-1', skipDrain: true });
    expect(businessAuditCreate).not.toHaveBeenCalled();
  });

  it('does not record admission when canonical authorization denies access', async () => {
    can.mockResolvedValue(false);
    await expect(authorizePharmacyGeneralJournal(context() as never, 'branch-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(branchFindFirst).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('awaits a collection admission audit before allowing the branch list', async () => {
    await expect(authorizePharmacyGeneralJournalCollection(context() as never)).resolves.toEqual({ organizationId: 'org-1', actorId: 'user-1' });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: 'pharmacyGeneralJournal.collectionAdmission', targetType: 'Organization', targetId: 'org-1',
      operation: 'OTHER', result: { decision: 'ADMITTED' }, outcome: 'SUCCESS',
    }) });
  });

  it('does not record collection admission when branch-list authorization is denied', async () => {
    can.mockResolvedValue(false);
    await expect(authorizePharmacyGeneralJournalCollection(context() as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('fails closed if durable admission cannot be recorded', async () => {
    auditCreate.mockRejectedValue(new Error('audit unavailable'));
    await expect(authorizePharmacyGeneralJournal(context() as never, 'branch-1')).rejects.toThrow('audit unavailable');
    await expect(authorizePharmacyGeneralJournalCollection(context() as never)).rejects.toThrow('audit unavailable');
  });

  it('probes the journal capability for navigation without writing admission audits', async () => {
    await expect(canOpenPharmacyGeneralJournal(context() as never)).resolves.toBe(true);
    can.mockResolvedValue(false);
    await expect(canOpenPharmacyGeneralJournal(context() as never)).resolves.toBe(false);
    can.mockRejectedValue(new Error('policy unavailable'));
    await expect(canOpenPharmacyGeneralJournal(context() as never)).resolves.toBe(false);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(businessAuditCreate).not.toHaveBeenCalled();
  });
});
