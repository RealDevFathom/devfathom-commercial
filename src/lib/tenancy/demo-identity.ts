export function demoSeatSlug(seat: number): string {
  return `demo-restaurant-seat-${seat}`;
}

export function demoOrganizationId(seat: number): string {
  return `org_demo_restaurant_seat_${seat}`;
}

export function demoSeatFromOrganizationId(
  organizationId: string,
  seatCount: number
): number | null {
  const match = /^org_demo_restaurant_seat_(\d+)$/.exec(organizationId);
  const seat = match ? Number(match[1]) : 0;
  return Number.isInteger(seat) && seat >= 1 && seat <= seatCount ? seat : null;
}

export function isCanonicalDemoOrganization(
  organization: {
    id: string;
    slug: string;
    isDemo: boolean;
    status: string;
    vertical?: string;
    deploymentMode: string;
  },
  seatCount: number
): boolean {
  const seat = demoSeatFromOrganizationId(organization.id, seatCount);
  return Boolean(
    seat &&
    organization.id === demoOrganizationId(seat) &&
    organization.slug === demoSeatSlug(seat) &&
    organization.isDemo &&
    organization.status === 'ACTIVE' &&
    organization.vertical === 'RESTAURANT' &&
    organization.deploymentMode === 'SHARED'
  );
}

export function isReservedDemoOrganizationId(organizationId: string): boolean {
  return organizationId.startsWith('org_demo_restaurant_seat_');
}
