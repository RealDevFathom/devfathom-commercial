import { describe, expect, it } from 'vitest';

import {
  coverageLabel,
  formatReportAge,
  formatReportDate,
  formatReportDateTime,
  formatReportPeriod,
  formatReportWindow,
  metricDescription,
  reportScopeLabel,
} from './report-format';

const plain = (value: string) => value.replace(/\s/g, ' ');

describe('report date formatting', () => {
  it('shows instants as a readable date and time in the workspace zone', () => {
    expect(plain(formatReportDateTime('2026-11-01T14:59:01.182Z', 'Asia/Karachi'))).toBe(
      '01-Nov-2026, 7:59 pm'
    );
    expect(plain(formatReportDateTime(new Date('2026-11-01T14:59:01.182Z'), 'UTC'))).toBe(
      '01-Nov-2026, 2:59 pm'
    );
  });

  it('falls back to UTC for a missing or unknown zone and never prints an ISO string', () => {
    const text = formatReportDateTime('2026-11-01T14:59:01.182Z', 'Not/AZone');
    expect(plain(text)).toBe('01-Nov-2026, 2:59 pm');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('labels missing or invalid instants instead of throwing', () => {
    expect(formatReportDateTime(null)).toBe('Not available');
    expect(formatReportDateTime('not a date')).toBe('Not available');
    expect(formatReportDate(undefined)).toBe('Not available');
  });

  it('shows business dates without shifting the day', () => {
    expect(formatReportDate('2026-10-26')).toBe('26-Oct-2026');
    expect(formatReportPeriod('2026-10-26', '2026-11-01')).toBe('26-Oct-2026 to 01-Nov-2026');
    expect(formatReportPeriod('2026-11-01', '2026-11-01')).toBe('01-Nov-2026');
  });

  it('reads whole-day exclusive windows as inclusive calendar dates', () => {
    expect(formatReportWindow('2026-10-26T00:00:00.000Z', '2026-11-02T00:00:00.000Z')).toBe(
      '26-Oct-2026 to 01-Nov-2026'
    );
    expect(formatReportWindow('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')).toBe(
      '01-Nov-2026'
    );
  });

  it('reads part-day windows as date-and-time instants', () => {
    expect(
      plain(formatReportWindow('2026-10-02T14:59:01.160Z', '2026-11-01T14:59:01.160Z', 'UTC'))
    ).toBe('02-Oct-2026, 2:59 pm to 01-Nov-2026, 2:59 pm');
  });
});

describe('report display labels', () => {
  it('shows data age in readable units', () => {
    expect(formatReportAge(3600)).toBe('60 min');
    expect(formatReportAge(3 * 3600)).toBe('3 h');
    expect(formatReportAge(3 * 86_400)).toBe('3 days');
    expect(formatReportAge(-1)).toBe('unknown');
  });

  it('uses plain coverage wording', () => {
    expect(coverageLabel('partial')).toBe('Some data missing');
    expect(coverageLabel('unknown')).toBe('May be incomplete');
  });

  it('maps metric scopes to plain words', () => {
    expect(reportScopeLabel('selected branches at read time')).toBe(
      'Selected branches, as of now'
    );
    expect(reportScopeLabel('organization')).toBe('Whole business');
    expect(reportScopeLabel('something new')).toBe('Something new');
  });

  it('describes metrics without stock states or table names', () => {
    const text = metricDescription('expiryValueMinor30', 'fallback');
    expect(text).toBe('Cost value of sellable stock that expires in the next 30 days.');
    expect(text).not.toMatch(/AVAILABLE|ACTIVE|frozen/);
    expect(metricDescription('unknownMetric', 'Stored definition.')).toBe('Stored definition.');
  });
});
