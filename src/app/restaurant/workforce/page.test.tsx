import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import RestaurantWorkforcePage from './page';

describe('RestaurantWorkforcePage', () => {
  it('presents scheduling, attendance, swap, and safe state guidance', () => {
    render(<RestaurantWorkforcePage />);
    expect(screen.getByRole('heading', { name: 'Workforce' })).toBeInTheDocument();
    expect(screen.getByText('Clock in')).toBeInTheDocument();
    expect(screen.getByText('Start or end break')).toBeInTheDocument();
    expect(screen.getByText('Request a swap')).toBeInTheDocument();
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.queryByText(/payroll|payout/i)).toBeNull();
  });
});
