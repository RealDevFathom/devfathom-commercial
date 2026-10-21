import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluateHotelOnboarding } from '@/lib/hotel/onboarding-checklist';
import type { HotelLanding, HotelLandingProperty } from '@/lib/hotel/landing';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { HotelDashboardContent } from './hotel-dashboard-content';

const checklist = evaluateHotelOnboarding('org_hotel', {
  MODE_CHOSEN: true,
  PROPERTY_FACTS: true,
  TAX_PROFILE: false,
  BUSINESS_DATE_AND_AUDIT: false,
  ROLES_ASSIGNED: true,
  ROOM_TYPES: false,
});
const property: HotelLandingProperty = {
  branchId: 'branch_lahore',
  name: 'Fathom Grand Lahore',
  city: 'Lahore',
  modeLabel: 'Hotel',
  sellsRooms: true,
  sellsFunctionSpaces: false,
  checkInTime: '14:00',
  checkOutTime: '12:00',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
  extrasCount: 4,
  checklist,
  activationSummary:
    'Activation is refused until these 3 steps are done: Tax profile, Business date and audit time and At least one room type.',
};
const AGENCY_WIDGETS = /Revenue This Month|Active Projects|Tasks Completed|Outstanding Invoices/;

function mount(landing: HotelLanding, isAdmin = true) {
  return render(
    <HotelDashboardContent
      landing={landing}
      organizationName="Fathom Grand Hotel"
      isAdmin={isAdmin}
    />
  );
}

afterEach(cleanup);

describe('HotelDashboardContent', () => {
  it('lands on property setup instead of the agency dashboard', () => {
    mount({ kind: 'properties', properties: [property] });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Fathom Grand Hotel' })
    ).toBeInTheDocument();
    expect(screen.queryByText(AGENCY_WIDGETS)).not.toBeInTheDocument();
    // KPI ledger from the checklist and catalog.
    const ledger = screen.getByRole('region', { name: 'Property setup at a glance' });
    expect(ledger).toHaveTextContent('Properties1');
    expect(ledger).toHaveTextContent('Setup steps done3/6');
    expect(ledger).toHaveTextContent('Steps blocking go-live3');
    expect(ledger).toHaveTextContent('Extras in catalog4');
    // The setup walk, with every step and its link carrying the property.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Open Fathom Grand Lahore for business' })
    ).toBeInTheDocument();
    expect(screen.getByText(property.activationSummary)).toBeInTheDocument();
    const walk = document
      .querySelector('[data-slot="readiness-checklist"]')!
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(within(walk).getAllByRole('listitem')).toHaveLength(6);
    for (const link of within(walk).getAllByRole('link', { name: /Open property settings/ }))
      expect(link).toHaveAttribute('href', '/hotel/settings/property?branchId=branch_lahore');
    expect(within(walk).getByRole('link', { name: /Open rooms/ })).toHaveAttribute(
      'href',
      '/hotel/settings/rooms?branchId=branch_lahore'
    );
    expect(within(walk).getByText('Tax profile')).toBeInTheDocument();
    // The property list names the property's facts, not its ids.
    const row = screen
      .getByRole('heading', { level: 3, name: 'Fathom Grand Lahore' })
      .closest('li')!;
    expect(row).toHaveTextContent('Lahore');
    expect(row).toHaveTextContent('Hotel');
    expect(row).toHaveTextContent('In 14:00 · Out 12:00');
    expect(row).toHaveTextContent('PKR · 4 extras');
    expect(row).toHaveTextContent('3 to do');
    expect(row).not.toHaveTextContent('branch_lahore');
    // Header actions and next steps point at the surfaces that exist today.
    expect(screen.getByRole('link', { name: 'Property settings' })).toHaveAttribute(
      'href',
      '/hotel/settings/property?branchId=branch_lahore'
    );
    expect(screen.getByRole('link', { name: 'Extras catalog' })).toHaveAttribute(
      'href',
      '/hotel/settings/extras?branchId=branch_lahore'
    );
    expect(screen.getByRole('link', { name: 'Rooms' })).toHaveAttribute(
      'href',
      '/hotel/settings/rooms?branchId=branch_lahore'
    );
    expect(screen.getByRole('link', { name: 'Add room types and rooms' })).toHaveAttribute(
      'href',
      '/hotel/settings/rooms?branchId=branch_lahore'
    );
    expect(screen.getByRole('link', { name: 'Check the meal plans you sell' })).toHaveAttribute(
      'href',
      '/hotel/settings/meal-plans?branchId=branch_lahore'
    );
    // A hotel sells no function space, so the spaces page is not offered.
    expect(screen.queryByRole('link', { name: 'Set up the function spaces' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Invite the team and assign Hotel roles' })
    ).toHaveAttribute('href', '/organization');
    // Rooms exist in this build; what does not is still said out loud.
    expect(
      screen.getByText(/Rates, reservations and folios are not available/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Rooms, rates, reservations/)).not.toBeInTheDocument();
  });

  it('reports a property that is ready to activate', () => {
    const ready = evaluateHotelOnboarding('org_hotel', {
      MODE_CHOSEN: true,
      PROPERTY_FACTS: true,
      TAX_PROFILE: true,
      BUSINESS_DATE_AND_AUDIT: true,
      ROLES_ASSIGNED: true,
      ROOM_TYPES: true,
    });
    mount({
      kind: 'properties',
      properties: [
        { ...property, checklist: ready, activationSummary: 'Every readiness step is done.' },
      ],
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Fathom Grand Lahore is ready to activate' })
    ).toBeInTheDocument();
    expect(screen.getByText('Ready to activate')).toBeInTheDocument();
    expect(screen.getByText(/Every property can be activated/)).toBeInTheDocument();
  });

  it('offers the function spaces page only for a property configured to sell them', () => {
    mount({
      kind: 'properties',
      properties: [{ ...property, modeLabel: 'Venue', sellsFunctionSpaces: true }],
    });
    expect(screen.getByRole('link', { name: 'Set up the function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_lahore'
    );
  });

  it('walks a venue to a function space instead of a room type, and offers no rooms page', () => {
    const venueChecklist = evaluateHotelOnboarding('org_venue', {
      MODE_CHOSEN: true,
      PROPERTY_FACTS: true,
      TAX_PROFILE: true,
      BUSINESS_DATE_AND_AUDIT: true,
      ROLES_ASSIGNED: true,
      FUNCTION_SPACES: true,
    });
    mount({
      kind: 'properties',
      properties: [
        {
          ...property,
          branchId: 'branch_venue',
          name: 'Fathom Lawns',
          modeLabel: 'Venue',
          sellsRooms: false,
          sellsFunctionSpaces: true,
          checklist: venueChecklist,
          activationSummary: 'Every readiness step is done. This property can be activated.',
        },
      ],
    });
    const walk = document
      .querySelector('[data-slot="readiness-checklist"]')!
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(within(walk).getAllByRole('listitem')).toHaveLength(6);
    expect(within(walk).getByText('At least one active function space')).toBeInTheDocument();
    expect(within(walk).queryByText('At least one room type')).not.toBeInTheDocument();
    expect(within(walk).getByRole('link', { name: /Open function spaces/ })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
    expect(within(walk).queryByRole('link', { name: /Open rooms/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Fathom Lawns is ready to activate' })
    ).toBeInTheDocument();
    // The header and the next steps follow what the venue sells.
    expect(screen.queryByRole('link', { name: 'Rooms' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add room types and rooms' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
    expect(screen.getByRole('link', { name: 'Set up the function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
  });

  it('offers rooms for the property that sells them when another property is a venue', () => {
    mount({
      kind: 'properties',
      properties: [
        property,
        {
          ...property,
          branchId: 'branch_venue',
          name: 'Fathom Lawns',
          modeLabel: 'Venue',
          sellsRooms: false,
          sellsFunctionSpaces: true,
        },
      ],
    });
    expect(screen.getByRole('link', { name: 'Rooms' })).toHaveAttribute(
      'href',
      '/hotel/settings/rooms?branchId=branch_lahore'
    );
    expect(screen.queryByRole('link', { name: 'Function spaces' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
  });

  it('suggests meal plans only where a property sells rooms', () => {
    const venue: HotelLandingProperty = {
      ...property,
      branchId: 'branch_venue',
      name: 'Fathom Lawns',
      modeLabel: 'Venue',
      sellsRooms: false,
      sellsFunctionSpaces: true,
    };
    const view = mount({ kind: 'properties', properties: [venue] });
    // A venue sells no stay to put a meal plan on; its function-space step stays.
    expect(screen.queryByRole('link', { name: 'Check the meal plans you sell' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Set up the function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
    view.unmount();

    // Beside a hotel, the step names the property that sells rooms.
    mount({ kind: 'properties', properties: [property, venue] });
    expect(screen.getByRole('link', { name: 'Check the meal plans you sell' })).toHaveAttribute(
      'href',
      '/hotel/settings/meal-plans?branchId=branch_lahore'
    );
    expect(screen.getByRole('link', { name: 'Set up the function spaces' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces?branchId=branch_venue'
    );
  });

  it('hides the admin-only step from a non-admin member', () => {
    mount({ kind: 'properties', properties: [property] }, false);
    expect(
      screen.queryByRole('link', { name: 'Invite the team and assign Hotel roles' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Review your workspace settings' })
    ).toBeInTheDocument();
  });

  it('keeps next-step links readable under a tenant brand colour', () => {
    mount({ kind: 'properties', properties: [property] });
    const steps = screen
      .getByRole('heading', { level: 2, name: 'What to do next' })
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    const links = within(steps).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      // A tenant brand overrides `--primary` with an unchecked colour in both themes.
      expect(link.className).not.toMatch(/\btext-primary\b/);
      expect(link.className).toMatch(/\bunderline\b/);
    }
  });

  it.each([
    [
      'denied',
      'Property administration is not part of your role',
      /Ask your workspace administrator for a Hotel role/,
    ],
    ['unassigned', 'No property is assigned to you yet', /assign you to a property/],
    ['error', 'Property setup could not be loaded', /Reload to try again/],
  ] as const)('explains the %s state instead of a blank page', (kind, title, detail) => {
    mount({ kind });
    expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.queryByText(AGENCY_WIDGETS)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Property settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review your workspace settings' })).toHaveAttribute(
      'href',
      '/settings'
    );
    if (kind === 'error')
      expect(screen.getByRole('link', { name: 'Reload the dashboard' })).toHaveAttribute(
        'href',
        '/dashboard'
      );
  });
});
