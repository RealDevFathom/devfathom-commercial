import { describe, expect, it } from 'vitest';

import {
  defaultRepeatWindow,
  expiryBoardHref,
  formatReportDate,
  formatReportPeriod,
  formatReportTimestamp,
  metricDrillThroughHref,
  pickerOptions,
  pickerValueFromInstant,
  replenishmentBlockedReason,
  reportsBackHref,
  utcInstantFromPicker,
  withBranch,
} from './report-helpers';

describe('expiry drill-through', () => {
  it.each([30, 60, 90, 180] as const)('opens the expiry board for the %i-day window', (days) => {
    expect(metricDrillThroughHref(`expiryValueMinor${days}`, '/pharmacy/inventory')).toBe(
      `/pharmacy/inventory/expiry?within=${days}`
    );
    expect(metricDrillThroughHref(`expiryValueMinor${days}`, '/pharmacy/inventory', 'b 1')).toBe(
      `/pharmacy/inventory/expiry?within=${days}&branch=b+1`
    );
  });

  it('keeps the contract target for other metrics and unsupported windows', () => {
    expect(metricDrillThroughHref('salesMinor', '/pharmacy/reports?section=sales', 'b1')).toBe(
      '/pharmacy/reports?section=sales'
    );
    expect(metricDrillThroughHref('expiryValueMinor45', '/pharmacy/inventory', 'b1')).toBe(
      '/pharmacy/inventory'
    );
    expect(metricDrillThroughHref('deviceFiscalOfflineExceptions', null)).toBeNull();
  });

  it('builds the board link with optional window and branch', () => {
    expect(expiryBoardHref()).toBe('/pharmacy/inventory/expiry');
    expect(expiryBoardHref(null, 'b1')).toBe('/pharmacy/inventory/expiry?branch=b1');
  });
});

describe('report links', () => {
  it('adds a branch only when one is in focus', () => {
    expect(withBranch('/pharmacy/reports/replenishment', 'b1')).toBe(
      '/pharmacy/reports/replenishment?branch=b1'
    );
    expect(withBranch('/pharmacy/reports/replenishment', undefined)).toBe(
      '/pharmacy/reports/replenishment'
    );
  });

  it('returns to reports in one click with the same branch and valid period', () => {
    expect(reportsBackHref({})).toBe('/pharmacy/reports');
    expect(reportsBackHref({ branch: 'b1', from: '2026-10-01', to: '2026-10-07' })).toBe(
      '/pharmacy/reports?branch=b1&from=2026-10-01&to=2026-10-07'
    );
    expect(reportsBackHref({ from: 'bad', to: '2026-10-07' })).toBe(
      '/pharmacy/reports?to=2026-10-07'
    );
  });
});

describe('people-readable dates', () => {
  it('formats instants in UTC and labels unknown values', () => {
    expect(formatReportTimestamp('2026-11-01T14:59:01.182Z')).toBe('1 Nov 2026, 14:59 UTC');
    expect(formatReportTimestamp(new Date('2026-01-05T03:04:00Z'))).toBe('5 Jan 2026, 03:04 UTC');
    expect(formatReportTimestamp(null)).toBe('Unavailable');
    expect(formatReportTimestamp('not a date', 'unknown')).toBe('unknown');
  });

  it('formats business dates and periods', () => {
    expect(formatReportDate('2026-10-26')).toBe('26 Oct 2026');
    expect(formatReportDate('later')).toBe('later');
    expect(formatReportPeriod('2026-10-26', '2026-11-01')).toBe('26 Oct 2026 – 1 Nov 2026');
    expect(formatReportPeriod('2026-11-01', '2026-11-01')).toBe('1 Nov 2026');
  });
});

describe('repeat purchasing defaults', () => {
  it('covers the last 90 days ending today with a minute-precision cutoff', () => {
    expect(defaultRepeatWindow(new Date('2026-11-01T14:59:42.123Z'))).toEqual({
      from: '2026-08-04',
      to: '2026-11-01',
      asOf: '2026-11-01T14:59:00.000Z',
    });
  });

  it('round-trips the cutoff through the datetime picker as UTC', () => {
    expect(pickerValueFromInstant('2026-11-01T14:59:00.000Z')).toBe('2026-11-01T14:59');
    expect(pickerValueFromInstant('nope')).toBe('');
    expect(utcInstantFromPicker('2026-11-01T14:59')).toBe('2026-11-01T14:59:00Z');
    expect(utcInstantFromPicker('2026-11-01T14:59:30')).toBe('2026-11-01T14:59:30Z');
    expect(utcInstantFromPicker('2026-11-01T14:59:00+05:00')).toBe('2026-11-01T14:59:00+05:00');
    expect(utcInstantFromPicker(' garbage ')).toBe('garbage');
  });
});

describe('filter pickers', () => {
  const options = [{ id: 's1', label: 'Acme' }];

  it('keeps the loaded options when the selection is among them', () => {
    expect(pickerOptions(options, 's1', 'supplier')).toEqual(options);
    expect(pickerOptions(options, undefined, 'supplier')).toEqual(options);
  });

  it('keeps an unknown selected ID selectable instead of dropping the filter', () => {
    expect(pickerOptions(options, 'old', 'supplier')).toEqual([
      { id: 'old', label: 'Selected supplier (not in this list)' },
      ...options,
    ]);
  });
});

describe('replenishment availability', () => {
  const base = { branchId: 'b1', medicineId: 'm1', medicineCount: 1, loading: false };

  it('explains each reason the report cannot be read yet', () => {
    expect(replenishmentBlockedReason({ ...base, branchId: '' })).toBe(
      'Select a branch first, then search for a medicine.'
    );
    expect(replenishmentBlockedReason({ ...base, medicineId: '', medicineCount: 0 })).toBe(
      'Search for a medicine and choose it from the list to read its report.'
    );
    expect(replenishmentBlockedReason({ ...base, medicineId: '' })).toBe(
      'Choose a medicine from the list to read its report.'
    );
  });

  it('has no reason when the report can run or is already loading', () => {
    expect(replenishmentBlockedReason(base)).toBeNull();
    expect(replenishmentBlockedReason({ ...base, branchId: '', loading: true })).toBeNull();
  });
});
