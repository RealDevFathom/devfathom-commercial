import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GrowthCampaign, GrowthTemplate } from '@/lib/growth/view';

import { GrowthInbox } from './growth-inbox';

const rationale =
  'Seventeen customers have not come back since their usual gap. A small 10% code usually brings a few of them in without spending the month cap.';

function campaign(overrides: Partial<GrowthCampaign> = {}): GrowthCampaign {
  return {
    id: 'cmp_winback',
    organizationId: 'org_1',
    kind: 'winback',
    status: 'proposed',
    name: 'Wapas aao',
    rationale,
    segment: { type: 'all' },
    sendAt: '2026-10-24T06:00:00.000Z',
    discountType: 'percent',
    discountValue: 10,
    codeExpiresAt: null,
    budgetCapMinor: 800_000,
    spentMinor: 0,
    templateId: 'tpl_winback',
    estimatedReach: 17,
    createdBy: 'ai',
    approvedBy: null,
    approvedAt: null,
    redemptionCount: 0,
    ...overrides,
  };
}

const templates: GrowthTemplate[] = [
  {
    id: 'tpl_winback',
    key: 'winback',
    language: 'ur-en',
    body: 'Salaam {{name}}. Reply STOP to opt out.',
  },
];

type FormAction = (formData: FormData) => void | Promise<void>;

function renderInbox(extra: Partial<GrowthCampaign>[] = []) {
  const approve = vi.fn<FormAction>();
  const reject = vi.fn<FormAction>();
  render(
    <GrowthInbox
      campaigns={[campaign(), ...extra.map((item) => campaign(item))]}
      templates={templates}
      connection={{ status: 'needs_pairing', managerUrl: 'http://127.0.0.1:8080' }}
      defaultSendAt="2026-10-22T11:00"
      approveAction={approve}
      rejectAction={reject}
      saveAction={vi.fn<FormAction>()}
    />
  );
  return { approve, reject };
}

describe('GrowthInbox', () => {
  it('shows a proposal and the full rationale on hover', () => {
    renderInbox();
    expect(screen.queryByText('This month')).toBeNull();
    expect(screen.getByText('WhatsApp needs pairing')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pair in the manager' }).getAttribute('href')).toBe(
      'http://127.0.0.1:8080'
    );
    expect(screen.getAllByTitle(rationale).length).toBeGreaterThan(0);
    expect(screen.getByTestId('campaign-cards').className).toContain('md:hidden');
    expect(screen.getByTestId('campaign-table').className).toContain('md:block');
  });

  it('approves, rejects, and opens the edit dialog with the proposal name', () => {
    const { approve, reject } = renderInbox();
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve Wapas aao' })[0]!);
    expect(approve).toHaveBeenCalled();
    expect(approve.mock.calls[0]?.[0].get('campaignId')).toBe('cmp_winback');

    fireEvent.click(screen.getAllByRole('button', { name: 'Reject Wapas aao' })[0]!);
    expect(reject.mock.calls[0]?.[0].get('campaignId')).toBe('cmp_winback');

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit Wapas aao' })[0]!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Wapas aao');
  });

  it('moves to the sent tab without the proposal', () => {
    renderInbox([
      campaign({
        id: 'cmp_eid',
        name: 'Eid offer',
        status: 'sent',
        kind: 'holiday',
        sendAt: '2026-10-10T06:00:00.000Z',
      }),
    ]);
    fireEvent.click(screen.getByRole('tab', { name: /Sent/ }));
    expect(screen.getAllByText('Eid offer').length).toBeGreaterThan(0);
    expect(screen.queryByText('Wapas aao')).toBeNull();
  });
});
