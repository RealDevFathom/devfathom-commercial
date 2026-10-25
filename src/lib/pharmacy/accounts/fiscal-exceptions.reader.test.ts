import { describe, expect, it, vi } from 'vitest';
import { readFiscalExceptions, validateFiscalExceptionRead } from './fiscal-exceptions.reader';

const input = {
  branchId: 'branch-1',
  from: new Date('2026-10-01T00:00:00.000Z'),
  to: new Date('2026-11-01T00:00:00.000Z'),
};

function database(branch: { id: string; name: string } | null = { id: 'branch-1', name: 'Main' }) {
  return {
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue(branch) },
    pharmacyFiscalDocument: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('fiscal exception reader', () => {
  it('rejects invalid windows and page limits before any read', () => {
    expect(() =>
      validateFiscalExceptionRead({ ...input, to: new Date('2027-02-01T00:00:00.000Z') })
    ).toThrow(/92 days/);
    expect(() => validateFiscalExceptionRead({ ...input, page: 101 })).toThrow(/page/);
    expect(() => validateFiscalExceptionRead({ ...input, pageSize: 101 })).toThrow(/page size/);
  });

  it('denies an inactive, foreign or unknown explicit branch before fiscal data read', async () => {
    const db = database(null);
    await expect(
      readFiscalExceptions(db as never, { organizationId: 'org-1' }, input)
    ).rejects.toThrow(/not an active branch/);
    expect(db.pharmacyFiscalDocument.findMany).not.toHaveBeenCalled();
  });

  it('uses tenant, active branch, half-open dates and a strict non-sensitive select', async () => {
    const db = database();
    await readFiscalExceptions(db as never, { organizationId: 'org-1' }, input, new Date(0));
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1', active: true },
      select: { id: true, name: true },
    });
    const args = db.pharmacyFiscalDocument.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      organizationId: 'org-1',
      branchId: 'branch-1',
      status: { in: ['QUEUED', 'REJECTED', 'DEAD'] },
      createdAt: { gte: input.from, lt: input.to },
    });
    expect(args.take).toBe(51);
    expect(args.select).not.toHaveProperty('payload');
    expect(args.select).not.toHaveProperty('externalQr');
    expect(args.select).not.toHaveProperty('lastError');
    expect(args.select).not.toHaveProperty('externalReference');
  });

  it('labels capped and later pages partial rather than complete coverage', async () => {
    const db = database();
    db.pharmacyFiscalDocument.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({
        id: `doc-${index}`,
        localReference: `LOCAL-${index}`,
        kind: 'INVOICE',
        integratorMode: 'OFF',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: null,
        submittedAt: null,
        rejectedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }))
    );
    const first = await readFiscalExceptions(
      db as never,
      { organizationId: 'org-1' },
      { ...input, pageSize: 2 }
    );
    expect(first.rows).toHaveLength(2);
    expect(first.coverage).toBe('PARTIAL');
    expect(first.hasMore).toBe(true);

    db.pharmacyFiscalDocument.findMany.mockResolvedValue([]);
    const later = await readFiscalExceptions(
      db as never,
      { organizationId: 'org-1' },
      { ...input, page: 2 }
    );
    expect(later.coverage).toBe('PARTIAL');
  });
});
