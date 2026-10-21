import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { UtilizationBar } from './utilization-bar';

it('names the progressbar from its visible label and clamps its value', () => {
  render(<UtilizationBar label={<strong>Spend versus cap</strong>} value={120} />);
  expect(screen.getByRole('progressbar', { name: 'Spend versus cap' })).toHaveAttribute(
    'aria-valuenow',
    '100'
  );
});
it('supplies a name without a visible label', () => {
  render(<UtilizationBar value={20} hidePercent />);
  expect(screen.getByRole('progressbar', { name: 'Utilization' })).toBeInTheDocument();
});
it('forwards a caller supplied name to the progressbar', () => {
  render(<UtilizationBar value={20} aria-label="Storage usage" />);
  expect(screen.getByRole('progressbar', { name: 'Storage usage' })).toBeInTheDocument();
});
