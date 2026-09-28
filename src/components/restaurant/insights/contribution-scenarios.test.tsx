import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContributionScenarios } from './contribution-scenarios';

function setup() {
  return render(<ContributionScenarios branchId="branch_1" from="2026-09-01" to="2026-09-30" />);
}

function enter(side: 'Baseline' | 'Scenario', label: string, value: string) {
  fireEvent.change(
    within(screen.getByRole('group', { name: `${side} assumptions` })).getByLabelText(label),
    { target: { value } }
  );
}

function fill() {
  fireEvent.change(screen.getByLabelText('Assumed currency code'), { target: { value: 'PKR' } });
  for (const side of ['Baseline', 'Scenario'] as const) {
    for (const [label, value] of [
      ['Unit price', '100'],
      ['Unit variable cost', '60'],
      ['Quantity', '100'],
      ['Incremental cost', '0'],
    ])
      enter(side, label, value);
  }
}

function calculate() {
  fireEvent.click(screen.getByRole('button', { name: 'Calculate contribution' }));
}

describe('ContributionScenarios', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts without fabricated prices, costs, currency or results', () => {
    setup();
    expect(screen.getByText('Assumptions', { exact: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Assumed currency code')).toHaveValue('');
    expect(
      within(screen.getByRole('group', { name: 'Baseline assumptions' })).getByLabelText(
        'Unit variable cost'
      )
    ).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Export assumptions JSON' })).toBeDisabled();
    expect(screen.queryByText('PKR 4000.00')).not.toBeInTheDocument();
  });

  it('calculates the discount fixture and invalidates a stale result on edit', () => {
    setup();
    fill();
    enter('Scenario', 'Discount per unit', '10');
    enter('Scenario', 'Quantity', '120');
    calculate();
    const result = screen.getByRole('status', { name: 'Contribution result' });
    expect(within(result).getByText('PKR 4000.00')).toBeInTheDocument();
    expect(within(result).getByText('PKR 3600.00')).toBeInTheDocument();
    expect(within(result).getByText('PKR -400.00')).toBeInTheDocument();
    expect(within(result).getByText('PKR 10800.00')).toBeInTheDocument();
    expect(within(result).getByText(/134 units/)).toBeInTheDocument();
    enter('Scenario', 'Quantity', '121');
    expect(screen.queryByText('PKR 3600.00')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export assumptions JSON' })).toBeDisabled();
  });

  it('preserves invalid values and connects visible cost errors to their inputs', () => {
    setup();
    fill();
    enter('Scenario', 'Unit variable cost', '');
    calculate();
    const input = within(
      screen.getByRole('group', { name: 'Scenario assumptions' })
    ).getByLabelText('Unit variable cost');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Enter a known amount/);
    expect(screen.getByRole('alert')).toHaveTextContent('Complete or correct');
    expect(screen.getByRole('button', { name: 'Export assumptions JSON' })).toBeDisabled();
  });

  it('exports the same exact evidence displayed for explicitly assumed volume', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:assumptions');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const stringify = vi.spyOn(JSON, 'stringify');
    setup();
    fill();
    enter('Scenario', 'Unit price', '110');
    enter('Scenario', 'Quantity', '90');
    calculate();
    expect(screen.getByText('PKR 4500.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export assumptions JSON' }));
    expect(stringify).toHaveBeenCalledWith(
      expect.objectContaining({
        basis: 'assumptions',
        scenario: expect.objectContaining({ contribution: '4500.00' }),
        change: { contribution: '500.00', revenue: '-100.00' },
      }),
      null,
      2
    );
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:assumptions');
  });

  it('preserves results when a download fails and allows retry', () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('Unavailable');
    });
    setup();
    fill();
    calculate();
    fireEvent.click(screen.getByRole('button', { name: 'Export assumptions JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Export unavailable');
    expect(screen.getByRole('button', { name: 'Export assumptions JSON' })).toBeEnabled();
    expect(screen.getAllByText('PKR 4000.00')).toHaveLength(2);
  });

  it('explains an unreachable break-even target without hiding negative contribution', () => {
    setup();
    fill();
    enter('Scenario', 'Unit price', '60');
    enter('Scenario', 'Incremental cost', '20');
    calculate();
    expect(screen.getByText('PKR -20.00')).toBeInTheDocument();
    expect(screen.getByText(/Break-even volume.*Unreachable/)).toBeInTheDocument();
  });
});
