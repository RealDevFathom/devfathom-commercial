import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusPill } from './status-pill';

describe('StatusPill', () => {
  it('uses the theme-safe info token instead of the tenant-overridable primary token', () => {
    render(<StatusPill status="Primary" tone="info" />);

    const pill = screen.getByText('Primary');

    expect(pill).toHaveAttribute('data-tone', 'info');
    expect(pill).toHaveClass('bg-info/10', 'text-info');
    expect(pill).not.toHaveClass('bg-primary/10', 'text-primary');
    expect(pill.querySelector('[aria-hidden="true"]')).toHaveClass('bg-current');
  });
});
