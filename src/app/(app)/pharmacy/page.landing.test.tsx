import { TRPCError } from '@trpc/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PharmacyOnboardingPage from './page';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  navigation: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  enabledModules: [] as string[],
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({
    session: { user: { id: 'member_1', role: 'EMPLOYEE' } },
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1', enabledModules: mocks.enabledModules },
    db: {},
  })),
}));
vi.mock('@/server/routers/pharmacy-onboarding', () => ({
  pharmacyOnboardingRouter: {
    createCaller: () => ({
      overview: mocks.overview,
      fbrTier1Status: vi.fn().mockResolvedValue(null),
      licenceRenewals: vi.fn().mockResolvedValue([]),
    }),
  },
}));
vi.mock('./loyalty/loyalty-router', () => ({
  pharmacyLoyaltyRouter: { createCaller: () => ({ earnRate: vi.fn().mockResolvedValue(null) }) },
}));
vi.mock('./loyalty/earn-rate-actions', () => ({ saveEarnRate: vi.fn() }));
vi.mock('@/server/routers/pharmacy-access', () => ({
  pharmacyAccessRouter: { createCaller: () => ({ navigation: mocks.navigation }) },
}));
vi.mock('@/lib/pharmacy/owner-data-export', () => ({
  isLiveOrganizationOwner: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/components/pharmacy/onboarding-console', () => ({
  PharmacyOnboardingConsole: () => <p>Onboarding steps</p>,
}));
vi.mock('@/components/pharmacy/fbr-tier1-summary', () => ({ FbrTier1Summary: () => null }));
vi.mock('@/components/pharmacy/licence-renewal-banner', () => ({
  LicenceRenewalBanner: () => null,
}));

const forbidden = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access is required.' });

async function landing() {
  try {
    await PharmacyOnboardingPage();
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (match) return match[1];
    throw error;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabledModules = ['pharmacy-core', 'pharmacy-counter', 'pharmacy-dispensing'];
  mocks.overview.mockRejectedValue(forbidden());
});

describe('/pharmacy landing by capability (DEV-497)', () => {
  it('sends a cashier to the counter instead of the onboarding dead end', async () => {
    mocks.navigation.mockResolvedValue({ capabilities: ['pharmacy:counter'] });
    expect(await landing()).toBe('/pharmacy/counter');
  });

  it('sends a pharmacist to the pharmacist queue', async () => {
    mocks.navigation.mockResolvedValue({
      capabilities: ['pharmacy:dispense', 'pharmacy:prescriptions', 'pharmacy:counter'],
    });
    expect(await landing()).toBe('/pharmacy/pharmacist-queue');
  });

  it('sends a member holding operational reports to the command centre', async () => {
    mocks.navigation.mockResolvedValue({
      capabilities: ['reports:operational', 'pharmacy:counter', 'pharmacy:dispense'],
    });
    expect(await landing()).toBe('/dashboard');
  });

  it('never lands on a surface the workspace does not license', async () => {
    mocks.enabledModules = ['pharmacy-core'];
    mocks.navigation.mockResolvedValue({
      capabilities: ['pharmacy:dispense', 'pharmacy:counter'],
    });
    expect(await landing()).toBe('/dashboard');
  });

  it('falls back to the staff home when the capability read fails', async () => {
    mocks.navigation.mockRejectedValue(new Error('unavailable'));
    expect(await landing()).toBe('/dashboard');
  });

  it('keeps onboarding for the administrator', async () => {
    mocks.overview.mockResolvedValue({ organization: { status: 'ACTIVE', displayName: 'Shifa' } });
    const page = await PharmacyOnboardingPage();
    expect(renderToStaticMarkup(page)).toContain('Onboarding steps');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.navigation).not.toHaveBeenCalled();
  });

  it('explains a failure that is not a permission refusal instead of redirecting', async () => {
    mocks.overview.mockRejectedValue(new Error('database unavailable'));
    const page = await PharmacyOnboardingPage();
    expect(renderToStaticMarkup(page)).toContain('Onboarding is not available to you');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
