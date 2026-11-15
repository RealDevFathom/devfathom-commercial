import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StaffingSuggestions } from './staffing-suggestions';

const hours = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  receipts: hour === 9 ? 14 : hour === 18 ? 42 : 0,
  averagePerDay: hour === 9 ? 2 : hour === 18 ? 6 : 0,
  busiestDay: hour === 9 ? 3 : hour === 18 ? 9 : 0,
  suggestedStaff: hour === 9 ? 1 : hour === 18 ? 2 : null,
}));
const report = {
  label: 'Suggestion' as const,
  method: 'Completed original receipts counted by local hour, averaged per calendar day',
  exclusions: ['returns', 'voided, held and open sales', 'quotations'],
  window: { from: new Date('2026-08-31T19:00:00Z'), to: new Date('2026-09-07T19:00:00Z') },
  days: 7,
  totalReceipts: 56,
  config: { receiptsPerStaffHour: 4, minimumStaff: 1 },
  hours,
};
const base = {
  failed: false,
  selected: true,
  timeZone: 'Asia/Karachi',
  carry: { branch: 'b1', from: '2026-09-01', to: '2026-09-07' },
  receiptsPerStaffHour: 4,
  minimumStaff: 1,
};

describe('StaffingSuggestions', () => {
  it('lists only trading hours with footfall and suggested staff', () => {
    render(<StaffingSuggestions {...base} report={report} />);
    const table = screen.getByRole('region', { name: 'Hourly staffing suggestions' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('18:00–19:00');
    expect(rows[2]).toHaveTextContent('6.00');
    expect(within(rows[2]).getAllByRole('cell').at(-1)).toHaveTextContent('2');
    expect(screen.getByText('Busiest hour').parentElement).toHaveTextContent('18:00–19:00');
    expect(screen.getByText(/Suggestions only; no roster or shift is changed/)).toBeVisible();
  });

  it('keeps the capacity assumption editable and carries the report filters', () => {
    const { container } = render(<StaffingSuggestions {...base} report={report} />);
    expect(screen.getByLabelText(/Assumed receipts per staff per hour/)).toHaveValue(4);
    expect(screen.getByLabelText('Minimum staff in a trading hour')).toHaveValue(1);
    const hidden = [...container.querySelectorAll('input[type=hidden]')].map((input) => [
      input.getAttribute('name'),
      input.getAttribute('value'),
    ]);
    expect(hidden).toEqual([
      ['branch', 'b1'],
      ['from', '2026-09-01'],
      ['to', '2026-09-07'],
    ]);
  });

  it('explains empty, unselected and failed states', () => {
    const { rerender } = render(
      <StaffingSuggestions
        {...base}
        report={{
          ...report,
          totalReceipts: 0,
          hours: hours.map((h) => ({ ...h, receipts: 0, suggestedStaff: null })),
        }}
      />
    );
    expect(screen.getByText(/no staffing suggestion is made/)).toBeVisible();
    rerender(<StaffingSuggestions {...base} selected={false} report={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Choose one authorized branch');
    rerender(<StaffingSuggestions {...base} failed report={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Staffing suggestions unavailable');
  });
});
