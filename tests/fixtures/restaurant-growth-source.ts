import type { GrowthProvenance } from '../../src/lib/restaurant/growth-source';
export function growthSourceFixture(count = 10): GrowthProvenance {
  const at = '1790812800.000000';
  return {
    policy: 'restaurant-catering-confirmed-v1',
    scope: { organizationId: 'org', branchId: 'branch' },
    request: { branchId: 'branch', from: '2026-10-01', to: '2026-10-01' },
    periodBasis: 'CATERING_EVENT_DATE_CURRENT_STATUS',
    currencyBasis: 'CURRENT_ORGANIZATION_COUNT_ONLY',
    source: {
      currency: 'PKR',
      periods: [
        {
          period: 'CURRENT',
          bookings: Array.from({ length: count }, (_, n) => ({
            id: `booking-${n}`,
            customerId: `customer-${n}`,
            customer: `customer-${n}`,
            anonymized: false,
            date: '2026-10-01',
            revision: 1,
            updated: at,
            customerUpdated: at,
            quoteId: `quote-${n}`,
            approvedId: `quote-${n}`,
            quoteRevision: 1,
            quoteHash: 'a'.repeat(64),
            quoteCreated: at,
            approvalId: `approval-${n}`,
            approvalRevision: 1,
            approvalCreated: at,
            eventId: `event-${n}`,
            sequence: 3,
            eventCreated: at,
            transitionId: `event-${n}`,
            transitionTo: 'CONFIRMED',
            transitionCreated: at,
          })),
        },
        { period: 'COMPARISON', bookings: [] },
      ],
    },
  };
}
