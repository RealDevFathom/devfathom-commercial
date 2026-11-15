import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  fbrTier1Status: vi.fn(),
  licenceRenewals: vi.fn(),
  earnRate: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('@/server/routers/pharmacy-onboarding', () => ({
  pharmacyOnboardingRouter: { createCaller: () => mocks },
}));
vi.mock('./loyalty/loyalty-router', () => ({
  pharmacyLoyaltyRouter: { createCaller: () => ({ earnRate: mocks.earnRate }) },
}));
vi.mock('./loyalty/earn-rate-actions', () => ({ saveEarnRate: vi.fn() }));
// DEV-497: read only when onboarding is refused; page.landing.test.tsx covers it.
vi.mock('@/server/routers/pharmacy-access', () => ({
  pharmacyAccessRouter: { createCaller: () => ({ navigation: vi.fn() }) },
}));
vi.mock('@/components/pharmacy/onboarding-console', () => ({
  PharmacyOnboardingConsole: () => <div>checklist</div>,
}));
vi.mock('@/components/pharmacy/licence-renewal-banner', () => ({
  LicenceRenewalBanner: () => null,
}));
vi.mock('@/components/pharmacy/fbr-tier1-summary', () => ({ FbrTier1Summary: () => null }));
vi.mock('@/lib/pharmacy/owner-data-export', () => ({
  isLiveOrganizationOwner: vi.fn().mockResolvedValue(false),
}));
import PharmacyOnboardingPage from './page';

const overview = (status: string) => ({ organization: { status, displayName: 'Shifa' } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.overview.mockResolvedValue(overview('ONBOARDING'));
  mocks.fbrTier1Status.mockResolvedValue(null);
  mocks.licenceRenewals.mockResolvedValue([]);
  mocks.earnRate.mockResolvedValue({ current: null, versions: [] });
});
afterEach(cleanup);

const show = async () => render(await PharmacyOnboardingPage());
const step = () => screen.queryByRole('heading', { name: 'Loyalty programme' });

describe('DEV-814 loyalty question during onboarding', () => {
  it('asks an onboarding owner with no earning rate whether to enable loyalty', async () => {
    await show();
    expect(step()).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Enable the loyalty programme?' })).toBeTruthy();
    expect(screen.getByText('checklist')).toBeTruthy();
  });

  it('does not ask once an earning rate is set', async () => {
    mocks.earnRate.mockResolvedValue({ current: { version: 1 }, versions: [{ version: 1 }] });
    await show();
    expect(step()).toBeNull();
  });

  it('does not ask a pharmacy that already finished onboarding', async () => {
    mocks.overview.mockResolvedValue(overview('ACTIVE'));
    await show();
    expect(step()).toBeNull();
    expect(mocks.earnRate).not.toHaveBeenCalled();
  });

  it('does not ask a user who may not set the rate, and the page still renders', async () => {
    mocks.earnRate.mockRejectedValue(new Error('FORBIDDEN'));
    await show();
    expect(step()).toBeNull();
    expect(screen.getByText('checklist')).toBeTruthy();
  });
});
