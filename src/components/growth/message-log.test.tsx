import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { GrowthMessage } from '@/lib/growth/view';

import { MessageLog } from './message-log';

const messages: GrowthMessage[] = [
  {
    id: 'msg_1',
    customerId: null,
    direction: 'in',
    body: 'haan',
    status: 'received',
    campaignId: null,
    error: null,
    createdAt: '2026-10-15T04:00:00.000Z',
  },
  {
    id: 'msg_2',
    customerId: 'cus_ayesha',
    direction: 'out',
    body: 'Salaam Ayesha. Reply STOP to opt out.',
    status: 'failed',
    campaignId: 'cmp_eid',
    error: 'Number not on WhatsApp',
    createdAt: '2026-10-10T06:00:00.000Z',
  },
];

describe('MessageLog', () => {
  it('shows direction, body, and a failure', () => {
    render(<MessageLog messages={messages} />);
    expect(screen.getByText('haan')).toBeTruthy();
    expect(screen.getByText('In')).toBeTruthy();
    expect(screen.getByText('Out')).toBeTruthy();
    expect(screen.getByText('Number not on WhatsApp')).toBeTruthy();
  });

  it('explains an empty log', () => {
    render(<MessageLog messages={[]} />);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
  });
});
