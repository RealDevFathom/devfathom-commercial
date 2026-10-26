import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationBar } from './utilization-bar';

describe('UtilizationBar', () => {
  it('uses the visible label as the progressbar accessible name', () => {
    render(<UtilizationBar label="Team utilization" value={72} />);

    const progressbar = screen.getByRole('progressbar', { name: 'Team utilization' });
    const label = screen.getByText('Team utilization');

    expect(progressbar).toHaveAttribute('aria-labelledby', label.id);
    expect(progressbar).not.toHaveAttribute('aria-label');
    expect(progressbar).toHaveValue(72);
  });

  it('provides a default accessible name when no label is shown', () => {
    render(<UtilizationBar value={40} hidePercent />);

    const progressbar = screen.getByRole('progressbar', { name: 'Utilization' });

    expect(progressbar).toHaveAttribute('aria-label', 'Utilization');
    expect(progressbar).not.toHaveAttribute('aria-labelledby');
    expect(progressbar).toHaveValue(40);
  });

  it('does not use a visible percentage as the accessible name', () => {
    render(<UtilizationBar value={40} />);

    const progressbar = screen.getByRole('progressbar', { name: 'Utilization' });

    expect(screen.getByText('40%')).toBeVisible();
    expect(progressbar).not.toHaveAccessibleName('40%');
  });

  it.each(['', '   '])('provides a default accessible name for an empty label', (label) => {
    const { container } = render(<UtilizationBar label={label} value={40} />);

    const progressbar = screen.getByRole('progressbar', { name: 'Utilization' });

    expect(container.querySelector('.eyebrow')).not.toBeInTheDocument();
    expect(progressbar).toHaveAttribute('aria-label', 'Utilization');
    expect(progressbar).not.toHaveAttribute('aria-labelledby');
    expect(progressbar).toHaveValue(40);
  });
});
