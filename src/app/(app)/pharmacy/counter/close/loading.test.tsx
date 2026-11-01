import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PharmacyDayCloseLoading from './loading';

describe('day close loading state', () => {
  it('is titled Day close, not Counter', () => {
    render(<PharmacyDayCloseLoading />);
    expect(screen.getByRole('heading', { level: 1, name: 'Day close' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading pharmacy day close' })).toBeInTheDocument();
    expect(screen.queryByText('Counter')).not.toBeInTheDocument();
  });
});
