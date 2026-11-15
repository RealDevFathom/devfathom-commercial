import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { licenceRenewalReminders } from '@/lib/pharmacy/licence-renewal';
import { LicenceRenewalBanner } from './licence-renewal-banner';

const at = new Date('2026-11-15T09:00:00.000Z');

describe('#720 LicenceRenewalBanner', () => {
  it('shows a licence expiring in 30 days with its Punjab renewal checklist', () => {
    const reminders = licenceRenewalReminders(
      [
        {
          kind: 'BRANCH_LICENCE',
          holder: 'Main branch',
          reference: 'DSL-123',
          validTo: new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000),
          provinceCode: 'PK-PB',
          licenceCategory: 'MEDICAL_STORE',
        },
      ],
      at
    );
    render(<LicenceRenewalBanner reminders={reminders} />);
    expect(screen.getByRole('heading', { name: 'Licence renewals due' })).toBeInTheDocument();
    expect(screen.getAllByText('30 days left', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('Fee: Rs 2,000 (medical store)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Save the renewed licence' })).toHaveAttribute(
      'href',
      '/pharmacy/regulatory'
    );
  });

  it('renders nothing once nothing is due', () => {
    const { container } = render(<LicenceRenewalBanner reminders={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
