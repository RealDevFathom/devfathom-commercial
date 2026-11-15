import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import Loading from './loading';

it('shows the counter layout while the route loads', () => {
  const { container } = render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading pharmacy counter' })).toBeInTheDocument();
  expect(container.querySelector('[data-counter-skeleton-bill]')).toBeInTheDocument();
  expect(container.querySelector('[data-counter-skeleton-total]')).toBeInTheDocument();
  expect(screen.queryByText('Loading the counter…')).not.toBeInTheDocument();
});
