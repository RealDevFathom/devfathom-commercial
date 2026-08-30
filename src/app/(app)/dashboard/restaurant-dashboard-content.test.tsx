import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./restaurant-management-overview', () => ({
  RestaurantManagementOverview: () => <div>Management overview</div>,
}));

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
    expect(screen.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Quick access' })).toBeVisible();
    expect(
      screen.getByText('Restaurant workspace').closest('[data-slot="page-header"]')
    ).toHaveClass('[&_[data-slot=eyebrow]]:text-text-body');
    expect(screen.getByText('Management workspace')).toHaveClass('text-text-body');
  });

  it('renders a useful core-only setup state', () => {
    render(<RestaurantDashboardContent enabledModules={['restaurant-core']} />);
    expect(screen.getByText(/ready for modules/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up restaurant staff/i })).toHaveAttribute(
      'href',
      '/restaurant/staff'
    );
    expect(screen.getByRole('heading', { level: 2, name: /ready for modules/i })).toBeVisible();
  });
});
