import { describe, expect, it } from 'vitest';
import {
  fiscalExceptionDocument, fiscalExceptionInput, fiscalExceptionsCsv,
  type FiscalExceptionRegister,
} from './fiscal-exceptions';

const input = { branchId: 'branch-1', from: '2026-07-01', to: '2026-10-01' };
const document = {
  id: 'doc-1', localReference: 'LOCAL-1', kind: 'INVOICE', integratorMode: 'SANDBOX',
  status: 'QUEUED', attempts: 0, maxAttempts: 3, nextAttemptAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
};

function register(): FiscalExceptionRegister {
  return {
    organizationId: 'org-1', branch: { id: 'branch-1', name: 'Main' },
    filters: fiscalExceptionInput.parse(input), configuredMode: 'OFF',
    readAt: '2026-10-01T00:00:00.000Z', coverage: 'UNKNOWN',
    hasMoreAtRead: false, pageCapReached: false, nextPage: null,
    rows: [{ ...fiscalExceptionDocument.parse(document), nextAttemptAt: null,
      createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(),
    }],
  };
}

// Read back the fixed-width CSV, including doubled quotes, without a spreadsheet runtime.
function parseCsv(csv: string) {
  return csv.trimEnd().split('\r\n').map((line) => {
    const cells = line.match(/"(?:[^"]|"")*"(?=,|$)/g) ?? [];
    return cells.map((cell) => cell.slice(1, -1).replace(/""/g, '"'));
  });
}

describe('fiscal exception bounds and safe DTO', () => {
  it('accepts exactly 92 half-open days and defaults to a bounded first page', () => {
    expect(fiscalExceptionInput.parse(input)).toEqual({ ...input, page: 0, pageSize: 50 });
  });

  it.each([
    { to: '2026-10-02' }, // 93 days
    { from: '2026-10-01' }, // empty
    { from: '2026-10-02' }, // inverted
    { from: '2026-02-30' }, { to: '2026-13-01' },
    { from: '2026-07-01T00:00:00Z' }, { branchId: '' }, { branchId: 'x'.repeat(129) },
    { page: -1 }, { page: 20 }, { page: 0.5 }, { pageSize: 0 }, { pageSize: 101 },
    { organizationId: 'foreign-org' }, { status: 'ACCEPTED' },
  ])('refuses invalid or expanded input %j', (change) => {
    expect(fiscalExceptionInput.safeParse({ ...input, ...change }).success).toBe(false);
  });

  it('drops payloads, hashes, QR, provider references/errors and actor metadata', () => {
    const safe = fiscalExceptionDocument.parse({ ...document,
      payload: { patient: 'secret' }, payloadHash: 'secret', externalQr: 'secret',
      externalReference: 'secret', lastError: 'secret', createdByActorId: 'secret',
    });
    expect(safe).toEqual(document);
    expect(JSON.stringify(safe)).not.toContain('secret');
  });

  it.each([
    { attempts: -1 }, { attempts: 4 }, { maxAttempts: 11 }, { integratorMode: 'LIVE' },
    { status: 'ACCEPTED' }, { status: 'SUBMITTING' }, { nextAttemptAt: 'tomorrow' },
  ])('refuses unsafe lifecycle metadata %j', (change) => {
    expect(fiscalExceptionDocument.safeParse({ ...document, ...change }).success).toBe(false);
  });
});

describe('page CSV safety and honest coverage', () => {
  it.each(['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', ' \t\r\n=HYPERLINK("https://invalid")',
    '\ufeff=1', '\u200b@SUM(A1)', '\u0000+1'])('neutralizes formula cells %j', (reference) => {
    const report = register();
    report.rows[0].localReference = reference;
    const rows = parseCsv(fiscalExceptionsCsv(report));
    const refIndex = rows[0].indexOf('local_reference');
    expect(rows[2][refIndex]).toMatch(/^'/);
    expect(rows.every((row) => row.length === rows[0].length)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('quotes commas and quotes while flattening row/control injection', () => {
    const report = register();
    report.rows[0].localReference = 'LOCAL,"one"\r\nFAKE,ROW';
    const csv = fiscalExceptionsCsv(report);
    expect(parseCsv(csv)[2][15]).toBe('LOCAL,"one"  FAKE,ROW');
    expect(csv).not.toContain('\r\nFAKE');
    expect(csv).not.toMatch(/payload|externalQr|lastError|payloadHash|externalReference/);
  });

  it('retains coverage, explicit OFF mode, bounds and caps even with no document rows', () => {
    const report = { ...register(), rows: [], hasMoreAtRead: true, pageCapReached: true };
    const rows = parseCsv(fiscalExceptionsCsv(report));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('COVERAGE');
    expect(rows[1]).toContain('OFF');
    expect(rows[1]).toContain('UNKNOWN');
    expect(rows[1]).toContain('2026-10-01');
    expect(rows[1][10]).toBe('0');
    expect(rows[1][11]).toBe('true');
    expect(rows[1][12]).toBe('true');
    expect(rows[1][13]).toContain('no frozen snapshot');
    expect(rows[1][13]).toContain('No FBR dispatch');
    expect(rows[1]).toHaveLength(rows[0].length);
  });

  it('distinguishes current configuration from the recorded document mode', () => {
    const rows = parseCsv(fiscalExceptionsCsv(register()));
    expect(rows[2][6]).toBe('OFF');
    expect(rows[2][17]).toBe('SANDBOX');
  });
});
