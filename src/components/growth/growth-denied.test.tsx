import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GrowthDenied } from './growth-denied';

describe('GrowthDenied', () => {
  it('tells a cashier this is a 403', () => {
    render(<GrowthDenied reason="permission" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Growth is closed' })).toBeTruthy();
    expect(screen.getByText(/403/)).toBeTruthy();
    expect(screen.getByText(/Cashiers stay on the counter/)).toBeTruthy();
    expect(screen.getByText(/growth\.manage/)).toBeTruthy();
  });

  it('says when the growth_ai flag is off', () => {
    render(<GrowthDenied reason="flag" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Growth is off' })).toBeTruthy();
    expect(screen.getByText(/growth_ai/)).toBeTruthy();
  });
});
