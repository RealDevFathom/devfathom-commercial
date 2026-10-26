import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationBar } from './utilization-bar';

describe('UtilizationBar', () => {
  it('uses the visible label as the progressbar accessible name', () => {
    render(<UtilizationBar label="Team utilization" value={72} />);

    expect(screen.getByRole('progressbar', { name: 'Team utilization' })).toHaveValue(72);
  });

  it('provides a default accessible name when no label is shown', () => {
    render(<UtilizationBar value={40} hidePercent />);

    expect(screen.getByRole('progressbar', { name: 'Utilization' })).toHaveValue(40);
  });

  it.each(['', '   '])('provides a default accessible name for an empty label', (label) => {
    render(<UtilizationBar label={label} value={40} />);

    expect(screen.getByRole('progressbar', { name: 'Utilization' })).toHaveValue(40);
  });
});
