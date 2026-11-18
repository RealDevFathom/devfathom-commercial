import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  PHARMACY_APPROVED_MESSAGE,
  PHARMACY_AWAITING_APPROVAL_MESSAGE,
} from '@/lib/pharmacy/approval-status';
import { PharmacyApprovalNotice } from './approval-notice';

const now = new Date('2026-11-18T12:00:00Z');

// DEV-905: the owner's dashboard says where the pharmacy stands with DevFathom approval.
describe('PharmacyApprovalNotice', () => {
  it('tells the owner onboarding is complete and approval is pending', () => {
    render(
      <PharmacyApprovalNotice
        approval={{ state: 'AWAITING_APPROVAL' }}
        canFinishOnboarding
        now={now}
      />
    );
    expect(screen.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(PHARMACY_AWAITING_APPROVAL_MESSAGE);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('names the open steps and links the owner to finish them', () => {
    render(
      <PharmacyApprovalNotice
        approval={{ state: 'ONBOARDING_OPEN', openSteps: ['Legal business'] }}
        canFinishOnboarding
        now={now}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'This onboarding step is still open: Legal business.'
    );
    expect(screen.getByRole('link', { name: 'Finish the onboarding steps' })).toHaveAttribute(
      'href',
      '/pharmacy'
    );
  });

  it('asks a member who cannot finish onboarding to ask their owner', () => {
    render(
      <PharmacyApprovalNotice
        approval={{ state: 'ONBOARDING_OPEN', openSteps: ['Legal business'] }}
        canFinishOnboarding={false}
        now={now}
      />
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Ask your owner or manager to finish these steps.')).toBeVisible();
  });

  it('says a recently approved pharmacy can sell', () => {
    render(
      <PharmacyApprovalNotice
        approval={{ state: 'APPROVED', approvedAt: '2026-11-18T09:00:00.000Z' }}
        canFinishOnboarding
        now={now}
      />
    );
    expect(screen.getByRole('heading', { name: 'Pharmacy approved' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(PHARMACY_APPROVED_MESSAGE);
  });

  it('renders nothing for a pharmacy approved long ago or without an answer', () => {
    const { container, rerender } = render(
      <PharmacyApprovalNotice
        approval={{ state: 'APPROVED', approvedAt: '2026-01-01T00:00:00.000Z' }}
        canFinishOnboarding
        now={now}
      />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<PharmacyApprovalNotice approval={null} canFinishOnboarding now={now} />);
    expect(container).toBeEmptyDOMElement();
  });
});
