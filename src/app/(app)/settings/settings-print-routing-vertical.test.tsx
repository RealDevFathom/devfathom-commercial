import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { OrganizationVertical } from '@/lib/vertical-catalog';

// Regression (#971): restaurant print routing (KOT/KDS/receipt printers) leaked into
// Settings for pharmacy, hospitality and agency tenants. It must render for restaurants only.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({ trpc: {} }));
vi.mock('@/components/restaurant/print-routing-section', () => ({
  PrintRoutingSection: () => <section aria-label="Print routing">Print routing</section>,
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantPrintRoutingSection } from './settings-content';

function entitlements(vertical: OrganizationVertical): EntitlementView {
  return {
    organizationId: 'org_1',
    vertical,
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: [],
    modules: [],
    limits: {},
  };
}

function renderFor(vertical: OrganizationVertical) {
  return render(
    <EntitlementsProvider value={entitlements(vertical)}>
      <RestaurantPrintRoutingSection />
    </EntitlementsProvider>
  );
}

describe('Settings print routing vertical gate', () => {
  it('renders print routing for the restaurant vertical', () => {
    renderFor('RESTAURANT');
    expect(screen.getByRole('region', { name: 'Print routing' })).toBeInTheDocument();
  });

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY'] as const)(
    'does not render print routing for the %s vertical',
    (vertical) => {
      renderFor(vertical);
      expect(screen.queryByRole('region', { name: 'Print routing' })).not.toBeInTheDocument();
      expect(screen.queryByText('Print routing')).not.toBeInTheDocument();
    }
  );
});
