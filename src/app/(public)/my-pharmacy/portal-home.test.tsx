import { render, screen } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { PortalHome } from './portal-home';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['Asia/Karachi', '2 Nov 2026'],
  ['America/New_York', '1 Nov 2026'],
])('shows receipt dates on the %s pharmacy clock', async (timeZone, date) => {
  const home = {
    customer: { displayName: 'Pat' },
    branchName: 'Main',
    timeZone,
    currency: 'PKR',
    loyaltyPoints: 0,
    receipts: [
      {
        saleId: 's',
        receiptNumber: 'R1',
        completedAt: '2026-11-02T00:30:00+05:00',
        totalMinor: 10,
      },
    ],
    khataAccounts: [],
    raast: null,
    offers: [],
    requests: [],
  };
  vi.stubGlobal('fetch', async () => Response.json({ ok: true, home }));
  render(<PortalHome />);
  expect(await screen.findByText(date)).toBeVisible();
});
