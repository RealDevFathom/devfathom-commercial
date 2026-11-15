import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Loading from './loading';

it('identifies the day close while the route loads', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading day close' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Day close' })).toBeInTheDocument();
});
