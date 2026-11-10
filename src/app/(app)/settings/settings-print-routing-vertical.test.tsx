import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verticalForModuleKey, type EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({ renderPrintRouting: vi.fn() }));

// Regression (#971): restaurant print routing (KOT/KDS/receipt printers) leaked into
// Settings for pharmacy, hospitality and agency tenants. It must render for restaurants only.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({ trpc: {} }));
vi.mock('@/components/restaurant/print-routing-section', () => ({
  PrintRoutingSection: () => {
    mocks.renderPrintRouting();
    return <section aria-label="Print routing">Print routing</section>;
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantPrintRoutingSection } from './settings-content';

function entitlements(vertical: EntitlementView['vertical']): EntitlementView {
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

function renderFor(vertical: EntitlementView['vertical'], enabledModules: string[] = []) {
  return render(
    <EntitlementsProvider value={{ ...entitlements(vertical), enabledModules }}>
      <RestaurantPrintRoutingSection />
    </EntitlementsProvider>
  );
}

describe('Settings print routing vertical gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders print routing for the restaurant vertical', () => {
    renderFor(verticalForModuleKey('restaurant-core')!);
    expect(screen.getByRole('region', { name: 'Print routing' })).toBeInTheDocument();
    expect(mocks.renderPrintRouting).toHaveBeenCalledOnce();
  });

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY'] as const)(
    'does not render print routing for the %s vertical',
    (vertical) => {
      renderFor(vertical);
      expect(screen.queryByRole('region', { name: 'Print routing' })).not.toBeInTheDocument();
      expect(screen.queryByText('Print routing')).not.toBeInTheDocument();
      expect(mocks.renderPrintRouting).not.toHaveBeenCalled();
    }
  );

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY', undefined] as const)(
    'does not mount print routing for %s even with restaurant module grants',
    (vertical) => {
      renderFor(vertical, ['restaurant-core', 'restaurant-pos', 'restaurant-integrations']);
      expect(screen.queryByRole('region', { name: 'Print routing' })).not.toBeInTheDocument();
      expect(screen.queryByText('Print routing')).not.toBeInTheDocument();
      expect(mocks.renderPrintRouting).not.toHaveBeenCalled();
    }
  );
});
