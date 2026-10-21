import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UtilizationBar } from './utilization-bar';

afterEach(cleanup);

it('gives the progressbar an accessible name derived from its label', () => {
  render(<UtilizationBar label="Mara Quinn" value={92} />);

  expect(screen.getByRole('progressbar', { name: 'Mara Quinn utilization' })).toHaveAttribute(
    'aria-valuenow',
    '92'
  );
});
