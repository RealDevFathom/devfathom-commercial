import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { planRenewalReminders, type RenewalReminder } from '@/lib/pharmacy/licence-renewal';

const query = vi.hoisted(() => ({ data: { reminders: [] as RenewalReminder[] } }));

vi.mock('@/lib/trpc', () => ({
  trpc: { pharmacyReports: { licenceRenewals: { useQuery: () => query } } },
}));

import { LicenceRenewalBanner } from './licence-renewal-banner';

describe('LicenceRenewalBanner navigation', () => {
  it.each([
    ['BRANCH_LICENCE', 'b1', '/pharmacy/regulatory?branch=b1'],
    ['BRANCH_LICENCE', 'b2', '/pharmacy/regulatory?branch=b2'],
    ['QUALIFIED_PERSON_REGISTRATION', 'b2', '/pharmacy/regulatory?branch=b2'],
    ['BRANCH_LICENCE', 'b&2', '/pharmacy/regulatory?branch=b%262'],
    ['SUPPLIER_LICENCE', null, '/pharmacy/purchasing/suppliers'],
  ] as const)('links %s for branch %s to its renewal form', (kind, branchId, href) => {
    query.data.reminders = planRenewalReminders(
      [
        {
          kind,
          branchId,
          subjectId: branchId ?? 'supplier:wholesale',
          label: 'Licence due',
          reference: 'LIC-1',
          expiresAt: new Date('2026-10-04T00:00:00.000Z'),
          provinceCode: kind === 'SUPPLIER_LICENCE' ? null : 'PK-PB',
          licenceCategory: kind === 'BRANCH_LICENCE' ? 'PHARMACY' : null,
        },
      ],
      new Date('2026-09-04T00:00:00.000Z')
    );

    // The reminder's branch must win even when the dashboard is on another branch.
    render(<LicenceRenewalBanner branchId="b1" />);

    expect(
      screen.getByRole('link', {
        name:
          kind === 'SUPPLIER_LICENCE'
            ? 'Record the renewed supplier licence'
            : 'Record the renewal on the regulatory profile',
      })
    ).toHaveAttribute('href', href);
  });
});
