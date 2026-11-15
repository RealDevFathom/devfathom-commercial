import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Loading from './loading';

describe('Counter loading', () => {
  it('shows the Counter bill, cart, and total layout while loading', () => {
    const { container } = render(<Loading />);
    expect(screen.getByRole('status', { name: 'Loading pharmacy counter' })).toBeVisible();
    expect(container.querySelector('[aria-label="Counter bill"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Cart"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Bill total"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3);
  });
});
