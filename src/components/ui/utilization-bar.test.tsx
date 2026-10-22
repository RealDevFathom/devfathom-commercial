import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationBar } from './utilization-bar';

describe('UtilizationBar', () => {
  it('uses its visible label as the progressbar accessible name', () => {
    render(<UtilizationBar label="Mara Quinn" value={92} />);

    expect(screen.getByRole('progressbar', { name: 'Mara Quinn' })).toHaveValue(92);
  });

  it('provides an accessible name when no visible label is supplied', () => {
    render(<UtilizationBar value={40} hidePercent />);

    expect(screen.getByRole('progressbar', { name: 'Utilization' })).toHaveValue(40);
  });
});
