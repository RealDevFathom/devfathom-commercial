import { beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
vi.mock('@/lib/abac', () => ({ can, subjectFromSession: () => ({}) }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));

import { authorizePharmacyGeneralJournal, authorizePharmacyGeneralJournalCollection } from './pharmacy-general-journal-security';

describe('pharmacy general journal admission', () => {
  const auditCreate = vi.fn();
  const branchFindFirst = vi.fn();
  const context = () => ({
    session: { user: { id: 'user-1' } }, organization: { id: 'org-1' }, entitlements: { organizationId: 'org-1' },
    requestMeta: { ip: '127.0.0.1' }, db: { pharmacyBranch: { findFirst: branchFindFirst }, auditLog: { create: auditCreate } },
  });

  beforeEach(() => { vi.clearAllMocks(); can.mockResolvedValue(true); branchFindFirst.mockResolvedValue({ id: 'branch-1' }); auditCreate.mockResolvedValue({ id: 'audit-1' }); });

  it('awaits an independent, safe ADMITTED audit after canonical authorization', async () => {
    await expect(authorizePharmacyGeneralJournal(context() as never, 'branch-1')).resolves.toEqual({ organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ operation: 'OTHER', action: 'pharmacyGeneralJournal.admission', result: { decision: 'ADMITTED' }, outcome: 'SUCCESS' }) });
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
});
