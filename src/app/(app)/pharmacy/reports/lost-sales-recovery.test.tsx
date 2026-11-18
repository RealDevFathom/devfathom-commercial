import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LOST_SALES_RECOVERY_DEFINITIONS } from '@/lib/pharmacy/back-in-stock';

import { LostSalesRecovery } from './lost-sales-recovery';

const group = (label: string, lost: number, recovered: number) => ({
  key: label,
  label,
  estimatedLostMinor: lost,
  recoveredMinor: recovered,
  netMinor: lost - recovered,
  events: 1,
  recoveredEvents: recovered ? 1 : 0,
});
const money = (minor: number | null) => (minor == null ? '—' : `PKR ${(minor / 100).toFixed(2)}`);
const report = {
  estimated: true as const,
  period: { from: '2026-11-01', to: '2026-11-15' },
  policy: { requestExpiryDays: 14, recoveryWindowDays: 7 },
  truncated: false,
  definitions: LOST_SALES_RECOVERY_DEFINITIONS,
  totals: {
    estimatedLostMinor: 200_000,
    recoveredMinor: 65_000,
    netMinor: 135_000,
    events: 4,
    recoveredEvents: 2,
  },
  byBranch: [group('Gulberg', 120_000, 20_000), group('Main', 80_000, 45_000)],
  bySalt: [group('Amoxicillin', 120_000, 20_000)],
  byDistributor: [],
  missingEstimates: 1,
};

describe('DEV-79 lost sales and recovery', () => {
  it('shows estimated lost, recovered and net with grouped views', () => {
    render(<LostSalesRecovery report={report} money={money} financial />);
    expect(screen.getByText('PKR 2000.00')).toBeTruthy();
    expect(screen.getByText('PKR 650.00')).toBeTruthy();
    expect(screen.getByText('PKR 1350.00')).toBeTruthy();
    const branches = screen.getByRole('table', { name: /by branch/i });
    expect(within(branches).getByRole('rowheader', { name: 'Gulberg' })).toBeTruthy();
    expect(within(branches).getByText('PKR 1000.00')).toBeTruthy();
    expect(screen.getByText(/within 7 days of the back-in-stock notice/)).toBeTruthy();
    expect(screen.getByText(/expire after 14 days/)).toBeTruthy();
    expect(screen.getByText('No recorded demand in this scope.')).toBeTruthy();
  });

  it('withholds value without financial permission and states unavailability', () => {
    const { rerender } = render(
      <LostSalesRecovery report={report} money={money} financial={false} />
    );
    expect(screen.getByText(/Financial report permission is required/)).toBeTruthy();
    expect(screen.queryByText('PKR 2000.00')).toBeNull();
    rerender(<LostSalesRecovery report={null} money={money} financial />);
    expect(screen.getByRole('status').textContent).toMatch(/No zero totals inferred/);
  });

  it('shows the period in plain dates and keeps the UTC-day note inside Details (DEV-722)', () => {
    const { container } = render(<LostSalesRecovery report={report} money={money} financial />);
    expect(screen.getByText(/Estimates for 1 Nov – 15 Nov\./)).toBeTruthy();
    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    // The report still covers exactly the dates the server read: whole UTC calendar days.
    expect(details?.textContent).toContain('2026-11-01 to 2026-11-15 are whole UTC calendar days');
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelector('details')?.remove();
    expect(outside.textContent).not.toMatch(/\bUTC\b|2026-11-01/);
  });
});
