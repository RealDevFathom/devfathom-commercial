// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { expiredRecordsSql, PURGE_AUDIT_SQL, purgeExpiredPharmacyRecords } from './retention-purge';

type Sql = { text?: string; sql?: string; strings?: string[]; values: unknown[] };
const text = (query: Sql) => query.text ?? query.sql ?? query.strings?.join('?') ?? '';

function fakeDb(
  candidates: Partial<Record<string, Array<{ id: string; organizationId: string }>>>
) {
  const executed: Array<[string, ...unknown[]]> = [];
  const configured: unknown[] = [];
  const db = {
    $queryRaw: vi.fn(async (query: Sql) => {
      const sql = text(query);
      if (sql.includes('set_config')) {
        configured.push(query.values[0] ?? '');
        return [];
      }
      for (const [table, rows] of Object.entries(candidates)) {
        if (sql.includes(`JOIN "${table}" r`) && !sql.includes('r."id") > (')) {
          return (rows ?? []).map((row) => ({
            ...row,
            anchor: new Date('2020-01-01T00:00:00.000Z'),
            retentionDays: 3653,
          }));
        }
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (statement: string, ...values: unknown[]) => {
      executed.push([statement, ...values]);
      if (statement.startsWith('DELETE') && values[1] === 'held') {
        throw new Error('deletion refused: record is protected by legal hold case-1');
      }
      return statement.startsWith('DELETE') ? 1 : 0;
    }),
  };
  return { db, executed, configured };
}

describe('DEV-96 retention purge', () => {
  it('selects only records past the rule-set window resolved in SQL', () => {
    const sql = text(expiredRecordsSql('FISCAL', null, 50) as unknown as Sql);
    expect(sql).toContain('pharmacy_retention_days(b."organizationId"');
    expect(sql).toContain('s.days IS NOT NULL');
    expect(sql).toContain(
      `COALESCE(r."completedAt", r."createdAt") <= timezone('UTC', now()) - make_interval(days => s.days)`
    );
    expect(sql).toContain('AND r."branchId" = s."branchId"');
    const audit = text(expiredRecordsSql('AUDIT', null, 50) as unknown as Sql);
    expect(audit).toContain(`o."vertical" = 'PHARMACY'`);
  });

  it('deletes each expired record in its own savepoint, naming it for the database guards', async () => {
    const { db, executed, configured } = fakeDb({
      pharmacy_prescriptions: [{ id: 'rx-1', organizationId: 'org-a' }],
    });
    const result = await purgeExpiredPharmacyRecords(db);
    expect(result.purged).toEqual({ AUDIT: 0, CONTROLLED_REGISTER: 0, PRESCRIPTION: 1, FISCAL: 0 });
    expect(result.retained).toEqual([]);
    expect(configured).toEqual(['org-a:PRESCRIPTION:rx-1', '']);
    const statements = executed.map(([statement]) => statement.replace(/\s+/g, ' ').trim());
    expect(statements[0]).toBe('SAVEPOINT pharmacy_retention_purge');
    expect(statements[1]).toMatch(/^DELETE FROM "pharmacy_prescription_fills"/);
    expect(statements[2]).toMatch(/^DELETE FROM "pharmacy_prescription_lines"/);
    expect(statements[3]).toMatch(/^DELETE FROM "pharmacy_prescriptions"/);
    expect(statements[4]).toBe(PURGE_AUDIT_SQL.replace(/\s+/g, ' ').trim());
    expect(statements[5]).toBe('RELEASE SAVEPOINT pharmacy_retention_purge');
    const [, , organizationId, recordClass, recordId, metadata] = executed[4];
    expect([organizationId, recordClass, recordId]).toEqual(['org-a', 'PRESCRIPTION', 'rx-1']);
    expect(JSON.parse(String(metadata))).toEqual({
      recordClass: 'PRESCRIPTION',
      recordId: 'rx-1',
      recordDate: '2020-01-01T00:00:00.000Z',
      retentionDays: 3653,
    });
    for (const [, ...values] of executed.slice(1, 4)) expect(values).toEqual(['org-a', 'rx-1']);
  });

  it('rolls a refused record back to its savepoint, reports it and keeps purging', async () => {
    const { db, executed } = fakeDb({
      audit_logs: [
        { id: 'held', organizationId: 'org-a' },
        { id: 'expired', organizationId: 'org-a' },
      ],
    });
    const result = await purgeExpiredPharmacyRecords(db);
    expect(result.purged.AUDIT).toBe(1);
    expect(result.retained).toEqual([
      {
        recordClass: 'AUDIT',
        organizationId: 'org-a',
        id: 'held',
        reason: 'deletion refused: record is protected by legal hold case-1',
      },
    ]);
    const statements = executed.map(([statement]) => statement);
    expect(statements.slice(0, 4)).toEqual([
      'SAVEPOINT pharmacy_retention_purge',
      'DELETE FROM "audit_logs" WHERE "organizationId" = $1 AND "id" = $2',
      'ROLLBACK TO SAVEPOINT pharmacy_retention_purge',
      'RELEASE SAVEPOINT pharmacy_retention_purge',
    ]);
  });

  it('writes an audit row for each purged record and none for a refused one', async () => {
    const { db, executed } = fakeDb({
      audit_logs: [
        { id: 'held', organizationId: 'org-a' },
        { id: 'expired', organizationId: 'org-a' },
      ],
    });
    await purgeExpiredPharmacyRecords(db);
    const audits = executed.filter(([statement]) => statement === PURGE_AUDIT_SQL);
    expect(
      audits.map(([, , organizationId, recordClass, recordId]) => [
        organizationId,
        recordClass,
        recordId,
      ])
    ).toEqual([['org-a', 'AUDIT', 'expired']]);
    expect(PURGE_AUDIT_SQL).toContain("'SYSTEM', 'Retention purge', 'SYSTEM', 'PHARMACY'");
    expect(PURGE_AUDIT_SQL).toContain("'DELETE', 'pharmacy.retention.purge'");
  });

  it('bounds each class separately so an audit backlog cannot starve later classes', async () => {
    const { db } = fakeDb({
      audit_logs: [
        { id: 'a', organizationId: 'org-a' },
        { id: 'b', organizationId: 'org-a' },
      ],
      pharmacy_sales: [{ id: 's', organizationId: 'org-a' }],
    });
    const result = await purgeExpiredPharmacyRecords(db, { maxPurgesPerClass: 1 });
    expect(result.purged).toEqual({ AUDIT: 1, CONTROLLED_REGISTER: 0, PRESCRIPTION: 0, FISCAL: 1 });
  });
});
