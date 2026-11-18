import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PHARMACY_AWAITING_APPROVAL_MESSAGE } from '@/lib/pharmacy/approval-status';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOnboarding: {
      recordGate: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));
vi.mock('@/components/onboarding/readiness-checklist', () => ({
  ReadinessChecklist: () => <div>checklist</div>,
}));

import { PharmacyOnboardingConsole } from './onboarding-console';

afterEach(cleanup);

function overview(status: string, ready: boolean) {
  return {
    organization: { displayName: 'Shifa Pharmacy', status, vertical: 'PHARMACY' },
    items: [],
    doneCount: ready ? 12 : 11,
    totalCount: 12,
    blocking: ready
      ? []
      : [
          {
            key: 'LEGAL_BUSINESS',
            step: 2,
            label: 'Legal business',
            href: '/organization',
            linkLabel: 'Open organization',
          },
        ],
    ready,
    activationSummary: ready ? 'Every readiness step is done.' : 'One step is open.',
  } as never;
}

// DEV-905: the pharmacy's onboarding page says whether it waits for DevFathom approval.
describe('PharmacyOnboardingConsole approval status', () => {
  it('says a complete onboarding pharmacy is waiting for DevFathom approval', () => {
    render(<PharmacyOnboardingConsole initial={overview('ONBOARDING', true)} />);
    expect(screen.getByText(PHARMACY_AWAITING_APPROVAL_MESSAGE)).toBeVisible();
  });

  it('lists the open steps while onboarding is not finished', () => {
    render(<PharmacyOnboardingConsole initial={overview('ONBOARDING', false)} />);
    expect(screen.queryByText(PHARMACY_AWAITING_APPROVAL_MESSAGE)).toBeNull();
    expect(screen.getByText(/Shifa Pharmacy is not approved yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open organization' })).toHaveAttribute(
      'href',
      '/organization'
    );
  });

  it('says an approved pharmacy can sell', () => {
    render(<PharmacyOnboardingConsole initial={overview('ACTIVE', true)} />);
    expect(
      screen.getByText(/DevFathom has approved Shifa Pharmacy\. It can sell now\./)
    ).toBeVisible();
  });
});
