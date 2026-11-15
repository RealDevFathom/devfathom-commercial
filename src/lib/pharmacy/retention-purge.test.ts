// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  expiredRecordsSql,
  parseRetentionPurgeResume,
  previousRetentionPurgeResume,
  PURGE_AUDIT_SQL,
  purgeExpiredPharmacyRecords,
} from './retention-purge';

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
      `COALESCE(r."completedAt", r."createdAt") <= timezone('UTC', now()) - make_interval(days => LEAST(s.days, 36525))`
    );
    expect(sql).toContain('AND r."branchId" = s."branchId"');
    const prescriptions = text(expiredRecordsSql('PRESCRIPTION', null, 50) as unknown as Sql);
    expect(prescriptions).toContain(`o."vertical" = 'PHARMACY'`);
  });

  it('deletes each expired record in its own savepoint, naming it for the database guards', async () => {
    const { db, executed, configured } = fakeDb({
      pharmacy_prescriptions: [{ id: 'rx-1', organizationId: 'org-a' }],
    });
    const result = await purgeExpiredPharmacyRecords(db);
    expect(result.purged).toEqual({ CONTROLLED_REGISTER: 0, PRESCRIPTION: 1, FISCAL: 0 });
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
      pharmacy_controlled_register_entries: [
        { id: 'held', organizationId: 'org-a' },
        { id: 'expired', organizationId: 'org-a' },
      ],
    });
    const result = await purgeExpiredPharmacyRecords(db);
    expect(result.purged.CONTROLLED_REGISTER).toBe(1);
    expect(result.retained).toEqual([
      {
        recordClass: 'CONTROLLED_REGISTER',
        organizationId: 'org-a',
        id: 'held',
        reason: 'deletion refused: record is protected by legal hold case-1',
      },
    ]);
    const statements = executed.map(([statement]) => statement);
    expect(statements.slice(0, 4)).toEqual([
      'SAVEPOINT pharmacy_retention_purge',
      'DELETE FROM "pharmacy_controlled_register_entries" WHERE "organizationId" = $1 AND "id" = $2',
      'ROLLBACK TO SAVEPOINT pharmacy_retention_purge',
      'RELEASE SAVEPOINT pharmacy_retention_purge',
    ]);
  });

  it('writes an audit row for each purged record and none for a refused one', async () => {
    const { db, executed } = fakeDb({
      pharmacy_controlled_register_entries: [
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
    ).toEqual([['org-a', 'CONTROLLED_REGISTER', 'expired']]);
    expect(PURGE_AUDIT_SQL).toContain("'SYSTEM', 'Retention purge', 'SYSTEM', 'PHARMACY'");
    expect(PURGE_AUDIT_SQL).toContain("'DELETE', 'pharmacy.retention.purge'");
  });

  it('bounds each class separately so a backlog cannot starve later classes', async () => {
    const { db } = fakeDb({
      pharmacy_controlled_register_entries: [
        { id: 'a', organizationId: 'org-a' },
        { id: 'b', organizationId: 'org-a' },
      ],
      pharmacy_sales: [{ id: 's', organizationId: 'org-a' }],
    });
    const result = await purgeExpiredPharmacyRecords(db, { maxPurgesPerClass: 1 });
    expect(result.purged).toEqual({ CONTROLLED_REGISTER: 1, PRESCRIPTION: 0, FISCAL: 1 });
  });

  it('never scans or deletes audit_logs, so purge audit rows survive every run', async () => {
    // Even if every audit row looked expired (e.g. a 1-day AUDIT retention
    // class), the purge must not select or delete any of them.
    const { db, executed } = fakeDb({
      audit_logs: [{ id: 'purge-trace', organizationId: 'org-a' }],
      pharmacy_sales: [{ id: 's', organizationId: 'org-a' }],
    });
    const result = await purgeExpiredPharmacyRecords(db);
    expect(Object.keys(result.purged)).toEqual(['CONTROLLED_REGISTER', 'PRESCRIPTION', 'FISCAL']);
    const scans = db.$queryRaw.mock.calls.map(([query]) => text(query as Sql));
    expect(scans.some((sql) => sql.includes('"audit_logs"'))).toBe(false);
    expect(executed.some(([statement]) => /^\s*DELETE FROM "audit_logs"/.test(statement))).toBe(
      false
    );
    // The only audit_logs statement is the purge trace for the fiscal record.
    expect(executed.filter(([statement]) => statement.includes('"audit_logs"'))).toEqual([
      [PURGE_AUDIT_SQL, expect.any(String), 'org-a', 'FISCAL', 's', expect.any(String)],
    ]);
  });

  describe('QA-3 resume across runs', () => {
    // A FISCAL backlog ordered by (anchor, id): 1,200 records the database keeps
    // refusing (e.g. a legal hold), then one genuinely expired record behind them.
    const base = Date.UTC(2010, 0, 1);
    const rows = [
      ...Array.from({ length: 1_200 }, (_, index) => ({
        id: `held-${String(index).padStart(4, '0')}`,
        anchor: new Date(base + index * 60_000),
      })),
      { id: 'expired-last', anchor: new Date(base + 1_200 * 60_000) },
    ];

    function cursorDb() {
      const purgedIds: string[] = [];
      const db = {
        $queryRaw: vi.fn(async (query: Sql) => {
          const sql = text(query);
          if (sql.includes('set_config')) return [];
          if (!sql.includes('JOIN "pharmacy_sales" r')) return [];
          const values = query.values;
          const limit = Number(values[values.length - 1]);
          let candidates = rows;
          if (sql.includes('r."id") > (')) {
            const after = values[values.length - 3] as Date;
            const afterId = values[values.length - 2] as string;
            candidates = rows.filter(
              (row) =>
                row.anchor.getTime() > after.getTime() ||
                (row.anchor.getTime() === after.getTime() && row.id > afterId)
            );
          }
          return candidates
            .filter((row) => !purgedIds.includes(row.id))
            .slice(0, limit)
            .map((row) => ({ ...row, organizationId: 'org-a', retentionDays: 3653 }));
        }),
        $executeRawUnsafe: vi.fn(async (statement: string, ...values: unknown[]) => {
          if (statement.startsWith('DELETE')) {
            if (String(values[1]).startsWith('held')) throw new Error('deletion refused: hold');
            purgedIds.push(String(values[1]));
            return 1;
          }
          return 0;
        }),
      };
      return { db, purgedIds };
    }

    it('continues past 1,000 refused records on the next run instead of stalling', async () => {
      const { db, purgedIds } = cursorDb();
      const first = await purgeExpiredPharmacyRecords(db);
      expect(first.purged.FISCAL).toBe(0);
      expect(first.resumeAfter.FISCAL).toEqual({
        anchor: rows[999].anchor.toISOString(),
        id: 'held-0999',
      });

      // The job stores the result as JSON; the next run reads it back.
      const stored = JSON.parse(JSON.stringify(first));
      const second = await purgeExpiredPharmacyRecords(db, {
        resumeAfter: parseRetentionPurgeResume(stored),
      });
      expect(second.purged.FISCAL).toBe(1);
      expect(purgedIds).toEqual(['expired-last']);
      // The scan reached the end, so the run after starts from the oldest again.
      expect(second.resumeAfter.FISCAL).toBeNull();
    });

    it('wraps to the oldest record once a scan reaches the end of the backlog', async () => {
      const { db } = cursorDb();
      const result = await purgeExpiredPharmacyRecords(db, { maxScanned: 5_000 });
      expect(result.purged.FISCAL).toBe(1);
      expect(result.resumeAfter).toEqual({
        CONTROLLED_REGISTER: null,
        PRESCRIPTION: null,
        FISCAL: null,
      });
    });

    it('keeps the resume point when the purge budget, not the backlog, ended the run', async () => {
      const { db } = fakeDb({
        pharmacy_controlled_register_entries: [
          { id: 'a', organizationId: 'org-a' },
          { id: 'b', organizationId: 'org-a' },
        ],
      });
      const result = await purgeExpiredPharmacyRecords(db, { maxPurgesPerClass: 1 });
      expect(result.resumeAfter.CONTROLLED_REGISTER).toEqual({
        anchor: '2020-01-01T00:00:00.000Z',
        id: 'a',
      });
    });

    it('ignores a malformed stored resume point rather than trusting it', () => {
      expect(parseRetentionPurgeResume(null)).toEqual({});
      expect(
        parseRetentionPurgeResume({
          resumeAfter: {
            FISCAL: { anchor: 'not-a-date', id: 'x' },
            PRESCRIPTION: { anchor: '2020-01-01T00:00:00.000Z', id: 42 },
            AUDIT: { anchor: '2020-01-01T00:00:00.000Z', id: 'audit-1' },
            CONTROLLED_REGISTER: { anchor: '2020-01-01T00:00:00.000Z', id: 'r-1' },
          },
        })
      ).toEqual({
        CONTROLLED_REGISTER: { anchor: new Date('2020-01-01T00:00:00.000Z'), id: 'r-1' },
      });
    });

    it('reads the resume point from the latest successful retention purge job', async () => {
      const queryRaw = vi.fn(async () => [
        { result: { resumeAfter: { FISCAL: { anchor: '2020-01-01T00:00:00.000Z', id: 's-9' } } } },
      ]);
      const resume = await previousRetentionPurgeResume({
        $queryRaw: queryRaw,
        $executeRawUnsafe: vi.fn(),
      });
      expect(resume).toEqual({
        FISCAL: { anchor: new Date('2020-01-01T00:00:00.000Z'), id: 's-9' },
      });
      const sql = text((queryRaw.mock.calls[0] as unknown as [Sql])[0]);
      expect(sql).toContain(`"type" = 'pharmacy.record.retention.v1'`);
      expect(sql).toContain(`"status" = 'SUCCEEDED'`);
    });
  });
});
