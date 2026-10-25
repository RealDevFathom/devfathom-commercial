import { describe, expect, it } from 'vitest';
import { fiscalExceptionCsv, projectFiscalExceptionRegister } from './fiscal-exceptions';

const instant = new Date('2026-10-25T10:00:00.000Z');
const report = (localReference = 'LOCAL-1') =>
  projectFiscalExceptionRegister({
    branch: { id: 'branch-1', name: 'Main' },
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: new Date('2026-11-01T00:00:00.000Z'),
    observedAt: instant,
    page: 1,
    pageSize: 50,
    hasMore: false,
    rows: [
      {
        id: 'doc-1',
        localReference,
        kind: 'INVOICE',
        integratorMode: 'SANDBOX',
        status: 'REJECTED',
        attempts: 2,
        maxAttempts: 5,
        nextAttemptAt: null,
        submittedAt: instant,
        rejectedAt: instant,
        createdAt: instant,
        updatedAt: instant,
      },
    ],
  });

describe('fiscal exception projection and CSV', () => {
  it('keeps mode separate from status and exposes only bounded lifecycle evidence', () => {
    const projected = report();
    expect(projected.rows[0]).toEqual({
      id: 'doc-1',
      localReference: 'LOCAL-1',
      kind: 'INVOICE',
      mode: 'SANDBOX',
      status: 'REJECTED',
      attempts: 2,
      maxAttempts: 5,
      nextAttemptAt: null,
      submittedAt: instant.toISOString(),
      rejectedAt: instant.toISOString(),
      createdAt: instant.toISOString(),
      updatedAt: instant.toISOString(),
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.rows)).toBe(true);
    expect(JSON.stringify(projected)).not.toMatch(/payload|externalQr|lastError|externalReference/);
  });

  it('does not describe sandbox acceptance as compliance', () => {
    const projected = projectFiscalExceptionRegister({
      branch: { id: 'branch-1', name: 'Main' },
      from: instant,
      to: new Date('2026-10-26T10:00:00.000Z'),
      observedAt: instant,
      page: 2,
      pageSize: 1,
      hasMore: false,
      rows: [],
    });
    expect(projected.coverage).toBe('PARTIAL');
    expect(JSON.stringify(projected)).not.toMatch(/compliant|registered|certified/i);
  });

  it.each(['=SUM(1,1)', '+cmd', '-2+3', '@import', '  =hidden'])(
    'neutralizes spreadsheet formula reference %s',
    (reference) => expect(fiscalExceptionCsv(report(reference))).toContain(`"'${reference}`)
  );

  it('quotes delimiters and removes control characters from CSV cells', () => {
    const csv = fiscalExceptionCsv(report('A,"B"\r\n=cmd'));
    expect(csv).toContain('"A,""B""  =cmd"');
    expect(csv.split('\r\n')).toHaveLength(3);
  });
});
