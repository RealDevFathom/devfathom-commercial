import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';

describe('RestaurantDashboardContent', () => {
  it('shows links only for enabled operational modules', () => {
    render(
      <RestaurantDashboardContent
        enabledModules={['restaurant-core', 'restaurant-inventory', 'restaurant-sop']}
      />
    );
    expect(screen.getByRole('link', { name: /inventory/i })).toHaveAttribute(
      'href',
      '/restaurant/inventory'
    );
    expect(screen.getByRole('link', { name: /sop board/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /orders/i })).not.toBeInTheDocument();
  });

  it('renders a useful core-only setup state', () => {
    render(<RestaurantDashboardContent enabledModules={['restaurant-core']} />);
    expect(screen.getByText(/ready for modules/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up restaurant staff/i })).toHaveAttribute(
      'href',
      '/restaurant/staff'
    );
  });
});
