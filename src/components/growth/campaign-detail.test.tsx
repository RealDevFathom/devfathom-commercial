import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GrowthCampaign, GrowthRecipient } from '@/lib/growth/view';

import { CampaignDetail } from './campaign-detail';

const campaign: GrowthCampaign = {
  id: 'cmp_eid',
  organizationId: 'org_1',
  kind: 'holiday',
  status: 'sent',
  name: 'Eid offer',
  rationale: 'Eid week is the busy one.',
  segment: { type: 'all' },
  sendAt: '2026-10-10T06:00:00.000Z',
  discountType: 'percent',
  discountValue: 10,
  codeExpiresAt: '2026-10-24T06:00:00.000Z',
  budgetCapMinor: 500_000,
  spentMinor: 180_000,
  templateId: 'tpl_holiday',
  estimatedReach: 40,
  createdBy: 'ai',
  approvedBy: 'user_owner',
  approvedAt: '2026-10-09T06:00:00.000Z',
  redemptionCount: 2,
};

const recipients: GrowthRecipient[] = [
  {
    id: 'rcp_ayesha',
    campaignId: 'cmp_eid',
    customerId: 'cus_ayesha',
    name: 'Ayesha Khan',
    phoneMasked: '•••• 2233',
    code: 'SEHA-EID001',
    status: 'redeemed',
    sentAt: '2026-10-10T06:00:00.000Z',
    redeemedAt: '2026-10-12T09:00:00.000Z',
    saleId: 'sale_eid_1842',
    error: null,
  },
];

describe('CampaignDetail', () => {
  it('shows reach, spend versus cap, redemptions, and a masked phone', () => {
    render(
      <CampaignDetail
        campaign={campaign}
        recipients={recipients}
        preview="Salaam Ayesha Khan! 10% at Sehat Pharmacy. Reply STOP to opt out."
        cancelAction={vi.fn()}
      />
    );
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('PKR 1,800.00')).toBeTruthy();
    expect(screen.getByText(/of PKR 5,000.00 cap/)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('•••• 2233')).toBeTruthy();
    expect(screen.queryByText(/\+92300/)).toBeNull();
    expect(screen.getByLabelText('Message preview').textContent).toContain('Ayesha Khan');
    expect(screen.getByText('sale_eid_1842')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel campaign' })).toBeNull();
  });

  it('offers cancel before sending starts', () => {
    render(
      <CampaignDetail
        campaign={{ ...campaign, status: 'scheduled', id: 'cmp_tuesday', name: 'Tuesday' }}
        recipients={[]}
        preview={null}
        cancelAction={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Cancel campaign' })).toBeTruthy();
    expect(screen.getByText(/Nobody is on this list yet/)).toBeTruthy();
  });
});
