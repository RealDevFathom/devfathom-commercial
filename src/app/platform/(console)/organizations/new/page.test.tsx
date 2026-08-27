import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NewOrganizationPage from './page';

const mocks = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  packageFindMany: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const RESTAURANT_PACKAGES = [
  { id: 'pkg_r1', name: 'Restaurant Growth', defaultSeats: 25 },
  { id: 'pkg_r2', name: 'Restaurant Enterprise', defaultSeats: 120 },
];

function renderPage(searchParams: { opportunityId?: string; vertical?: string }) {
  return NewOrganizationPage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.packageFindMany.mockResolvedValue(RESTAURANT_PACKAGES);
  mocks.withPlatformDb.mockImplementation(
    (
      run: (db: { platformPackage: { findMany: typeof mocks.packageFindMany } }) => Promise<unknown>
    ) => run({ platformPackage: { findMany: mocks.packageFindMany } })
  );
});

describe('NewOrganizationPage type-first choice', () => {
  it('requires an explicit type choice and preselects neither vertical', async () => {
    const { container } = render(await renderPage({}));

    expect(screen.getByRole('heading', { name: 'Organization type' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Agency/ })).toHaveAttribute(
      'href',
      '/platform/organizations/new?vertical=AGENCY'
    );
    expect(screen.getByRole('link', { name: /Restaurant/ })).toHaveAttribute(
      'href',
      '/platform/organizations/new?vertical=RESTAURANT'
    );

    // No preselect: neither the onboarding form nor a defaulted vertical exists
    // before the operator chooses, and no package query has run.
    expect(container.querySelector('input[name="vertical"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create onboarding record/ })).toBeNull();
    expect(mocks.packageFindMany).not.toHaveBeenCalled();
  });

  it('treats an unrecognized vertical as no choice rather than defaulting to AGENCY', async () => {
    const { container } = render(await renderPage({ vertical: 'RETAIL' }));

    expect(screen.getByRole('heading', { name: 'Organization type' })).toBeInTheDocument();
    expect(container.querySelector('input[name="vertical"]')).toBeNull();
    expect(mocks.packageFindMany).not.toHaveBeenCalled();
  });

  it('carries an opportunity through the type choice', async () => {
    render(await renderPage({ opportunityId: 'opp_1' }));

    expect(screen.getByRole('link', { name: /Restaurant/ })).toHaveAttribute(
      'href',
      '/platform/organizations/new?vertical=RESTAURANT&opportunityId=opp_1'
    );
  });
});

describe('NewOrganizationPage package step', () => {
  it('filters packages server-side by the chosen vertical and submits it explicitly', async () => {
    const { container } = render(await renderPage({ vertical: 'RESTAURANT' }));

    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'RESTAURANT' } })
    );

    const verticalField = container.querySelector('input[name="vertical"]');
    expect(verticalField).toHaveAttribute('type', 'hidden');
    expect(verticalField).toHaveValue('RESTAURANT');

    const options = [...container.querySelectorAll('select[name="packageId"] option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'Restaurant Growth · 25 default seats',
      'Restaurant Enterprise · 120 default seats',
    ]);
    expect(screen.getByRole('button', { name: /Create onboarding record/ })).toBeInTheDocument();
  });

  it('keeps the opportunity on the submitted payload after the type is chosen', async () => {
    const { container } = render(await renderPage({ vertical: 'AGENCY', opportunityId: 'opp_9' }));

    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'AGENCY' } })
    );
    expect(container.querySelector('input[name="opportunityId"]')).toHaveValue('opp_9');
    expect(container.querySelector('input[name="vertical"]')).toHaveValue('AGENCY');
  });

  it('offers a way back to the type choice instead of an irreversible step', async () => {
    render(await renderPage({ vertical: 'RESTAURANT', opportunityId: 'opp_1' }));

    expect(screen.getByRole('link', { name: 'Change type' })).toHaveAttribute(
      'href',
      '/platform/organizations/new?opportunityId=opp_1'
    );
  });

  it('explains the empty case rather than rendering a form with no package', async () => {
    mocks.packageFindMany.mockResolvedValue([]);

    render(await renderPage({ vertical: 'RESTAURANT' }));

    expect(
      screen.getByRole('heading', { name: 'No commercial package available' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create onboarding record/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Modules and plans' })).toHaveAttribute(
      'href',
      '/platform/catalog'
    );
  });
});
