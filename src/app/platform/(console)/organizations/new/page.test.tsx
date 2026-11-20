import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewOrganizationPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  packageFindMany: vi.fn(),
}));

vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: mocks.requirePlatformRead,
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

function fillPharmacyOnboarding() {
  for (const [label, value] of [
    ['Display name', 'Clifton Chemist'],
    ['Legal name', 'Clifton Chemist Ltd'],
    ['Workspace slug', 'clifton-chemist'],
    ['First branch name', 'Clifton Chemist'],
    ['First branch address', '12 Clifton Road'],
    ['First branch city', 'Karachi'],
    ['Primary contact', 'Pharmacy owner'],
    ['Primary contact email', 'owner@clifton.test'],
    ['Tenant administrator', 'Pharmacy administrator'],
    ['Administrator email', 'admin@clifton.test'],
    ['Temporary administrator password', 'temporary-password-123'],
  ] as const) {
    fireEvent.change(selectFieldControl(screen.getByLabelText(label, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value } });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.packageFindMany.mockResolvedValue(RESTAURANT_PACKAGES);
  mocks.withPlatformDb.mockImplementation(
    (
      run: (db: { platformPackage: { findMany: typeof mocks.packageFindMany } }) => Promise<unknown>
    ) => run({ platformPackage: { findMany: mocks.packageFindMany } })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(screen.getByRole('link', { name: /Pharmacy/ })).toHaveAttribute(
      'href',
      '/platform/organizations/new?vertical=PHARMACY'
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
  it.each([
    ['qa', 'Workspace slug must be at least 3 characters.'],
    ['a'.repeat(64), 'Workspace slug must be at most 63 characters.'],
    ['clifton_chemist', 'Workspace slug has an invalid format.'],
    ['-clifton', 'Workspace slug has an invalid format.'],
    ['clifton--chemist', 'Workspace slug has an invalid format.'],
  ])('rejects invalid pharmacy workspace slug %s before submitting', async (value, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(await renderPage({ vertical: 'PHARMACY' }));
      fillPharmacyOnboarding();
      const slug = screen.getByLabelText('Workspace slug', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
      expect(slug).toHaveAttribute('minlength', '3');
      expect(slug).toHaveAttribute('maxlength', '63');
      expect(slug).toHaveAttribute('pattern', '\\s*[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\\s*');

      fireEvent.change(selectFieldControl(slug), { target: { value } });
      fireEvent.submit(slug.closest('form')!);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(slug).toHaveFocus();
      expect(slug).toHaveAttribute('aria-invalid', 'true');
      expect(slug).toHaveAccessibleDescription(message);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['Clifton-Chemist', ' Clifton-Chemist '])(
    'accepts pharmacy workspace slug %s for server normalization',
    async (value) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      try {
        render(await renderPage({ vertical: 'PHARMACY' }));
        fillPharmacyOnboarding();
        const slug = screen.getByLabelText('Workspace slug', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
        fireEvent.change(selectFieldControl(slug), { target: { value } });

        // Native submission must permit the same input as the submit handler.
        expect(slug).toBeValid();
        fireEvent.submit(slug.closest('form')!);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
          action: 'organization.create',
          payload: { slug: value },
        });
        expect(slug).toHaveAttribute('aria-invalid', 'false');
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

  it('resets an overridden seat limit to the selected package default', async () => {
    render(await renderPage({ vertical: 'RESTAURANT' }));
    const seats = screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(selectFieldControl(seats)).toHaveValue(25);
    fireEvent.change(selectFieldControl(seats), { target: { value: '7' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Commercial package', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'pkg_r2' } });
    expect(selectFieldControl(screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(120);
    expect(screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('max', '120');
    fireEvent.change(selectFieldControl(screen.getByLabelText('Commercial package', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'pkg_r1' } });
    expect(selectFieldControl(screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(25);
  });

  it('disables seat overrides for other platform operators', async () => {
    mocks.requirePlatformRead.mockResolvedValue({ role: 'SALES' });
    render(await renderPage({ vertical: 'RESTAURANT' }));
    expect(screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Commercial package', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'pkg_r2' } });
    expect(selectFieldControl(screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(120);
  });

  it('offers only shared deployment when Vercel provisioning is not configured', async () => {
    vi.stubEnv('VERCEL_ACCESS_TOKEN', undefined);
    vi.stubEnv('VERCEL_TEAM_ID', undefined);
    vi.stubEnv('VERCEL_ORG_ID', undefined);

    const { container } = render(await renderPage({ vertical: 'RESTAURANT' }));

    const deploymentOptions = [
      ...container.querySelectorAll('select[name="deploymentMode"] option'),
    ];
    expect(deploymentOptions.map((option) => option.textContent)).toEqual(['Shared platform']);
    expect(screen.getByText(/Dedicated enterprise is unavailable/)).toBeInTheDocument();
  });

  it('offers dedicated deployment when the required Vercel settings are configured', async () => {
    vi.stubEnv('VERCEL_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('VERCEL_TEAM_ID', 'test-team');

    const { container } = render(await renderPage({ vertical: 'RESTAURANT' }));

    const deploymentOptions = [
      ...container.querySelectorAll('select[name="deploymentMode"] option'),
    ];
    expect(deploymentOptions.map((option) => option.textContent)).toEqual([
      'Shared platform',
      'Dedicated enterprise',
    ]);
  });

  it('offers only pharmacy packages for a PHARMACY organization', async () => {
    mocks.packageFindMany.mockResolvedValue([
      { id: 'pkg_p1', name: 'Pharmacy Essentials', defaultSeats: 10 },
      { id: 'pkg_p2', name: 'Pharmacy Professional', defaultSeats: 50 },
      { id: 'pkg_p3', name: 'Pharmacy Chain', defaultSeats: 2500 },
    ]);

    const { container } = render(await renderPage({ vertical: 'PHARMACY' }));

    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'PHARMACY' } })
    );
    expect(
      [...container.querySelectorAll('select[name="packageId"] option')].map(
        (option) => option.textContent
      )
    ).toEqual([
      'Pharmacy Essentials · 10 default seats',
      'Pharmacy Professional · 50 default seats',
      'Pharmacy Chain · 2500 default seats',
    ]);
  });

  it('pluralises the default-seat count, keeping "seat" singular for a one-seat package', async () => {
    mocks.packageFindMany.mockResolvedValue([
      { id: 'pkg_solo', name: 'Pharmacy Solo', defaultSeats: 1 },
      { id: 'pkg_team', name: 'Pharmacy Team', defaultSeats: 10 },
    ]);

    const { container } = render(await renderPage({ vertical: 'PHARMACY' }));

    expect(
      [...container.querySelectorAll('select[name="packageId"] option')].map(
        (option) => option.textContent
      )
    ).toEqual(['Pharmacy Solo · 1 default seat', 'Pharmacy Team · 10 default seats']);
  });

  // WHA-1206 — the four premises answers a pharmacy's first branch is created
  // from. Asked here because `pharmacy_branches` requires all four, and the
  // province decides which jurisdiction's published rules the branch licence is
  // later recorded against.
  it('defaults a PHARMACY organization to the Pakistan market timezone and currency', async () => {
    const { container } = render(await renderPage({ vertical: 'PHARMACY' }));

    expect(selectFieldControl(container.querySelector('input[name="currency"]'))).toHaveValue('PKR');
    expect(selectFieldControl(container.querySelector('input[name="timezone"]'))).toHaveValue('Asia/Karachi');
  });

  it('keeps the commercial USD default for an AGENCY organization', async () => {
    const { container } = render(await renderPage({ vertical: 'AGENCY' }));

    expect(selectFieldControl(container.querySelector('input[name="currency"]'))).toHaveValue('USD');
    expect(selectFieldControl(container.querySelector('input[name="timezone"]'))).toHaveValue('UTC');
  });

  it('asks a PHARMACY organization for its first branch premises, province by name', async () => {
    const { container } = render(await renderPage({ vertical: 'PHARMACY' }));

    for (const field of [
      'firstBranchName',
      'firstBranchAddress',
      'firstBranchCity',
      'firstBranchProvinceCode',
    ]) {
      expect(container.querySelector(`[name="${field}"]`)).not.toBeNull();
    }
    // The restaurant-only field does not follow the pharmacy path.
    expect(container.querySelector('[name="businessDayCutoff"]')).toBeNull();
    // UX rule 1: the operator picks a province by its name, never by its code.
    const provinces = [
      ...container.querySelectorAll('select[name="firstBranchProvinceCode"] option'),
    ].map((option) => option.textContent);
    expect(provinces).toContain('Sindh');
    expect(provinces).not.toContain('PK-SD');
  });

  it('filters packages server-side by the chosen vertical and submits it explicitly', async () => {
    const { container } = render(await renderPage({ vertical: 'RESTAURANT' }));

    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'RESTAURANT' } })
    );

    const verticalField = container.querySelector('input[name="vertical"]');
    expect(verticalField).toHaveAttribute('type', 'hidden');
    expect(selectFieldControl(verticalField)).toHaveValue('RESTAURANT');

    const options = [...container.querySelectorAll('select[name="packageId"] option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'Restaurant Growth · 25 default seats',
      'Restaurant Enterprise · 120 default seats',
    ]);
    expect(screen.getByRole('button', { name: /Create onboarding record/ })).toBeInTheDocument();
  });

  it('associates timezone and business day cutoff with exactly one control each', async () => {
    const { container } = render(await renderPage({ vertical: 'RESTAURANT' }));

    expect(screen.getByLabelText(/timezone/i, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('data-field-name', 'timezone');
    expect(screen.getByLabelText(/business day cutoff/i, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBe(
      container.querySelector('input[name="businessDayCutoff"]')
    );
  });

  it('previews the post-submit restaurant state and remaining activation work', async () => {
    render(await renderPage({ vertical: 'RESTAURANT' }));

    const preview = screen.getByRole('region', {
      name: 'This creates an onboarding record, not an active restaurant',
    });
    const submit = screen.getByRole('button', { name: 'Create onboarding record' });

    expect(preview).toHaveTextContent('ONBOARDING');
    expect(preview).toHaveTextContent('Confirm readiness');
    expect(preview).toHaveTextContent('Finish deployment');
    expect(preview).toHaveTextContent('Activate manually');
    expect(preview.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the restaurant activation preview out of other verticals', async () => {
    render(await renderPage({ vertical: 'AGENCY' }));

    expect(
      screen.queryByRole('region', {
        name: 'This creates an onboarding record, not an active restaurant',
      })
    ).toBeNull();
  });

  it('keeps the opportunity on the submitted payload after the type is chosen', async () => {
    const { container } = render(await renderPage({ vertical: 'AGENCY', opportunityId: 'opp_9' }));

    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'AGENCY' } })
    );
    expect(selectFieldControl(container.querySelector('input[name="opportunityId"]'))).toHaveValue('opp_9');
    expect(selectFieldControl(container.querySelector('input[name="vertical"]'))).toHaveValue('AGENCY');
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

it('submits the selected package default and a super admin override within its ceiling', async () => {
  mocks.packageFindMany.mockResolvedValue([
    { id: 'chain', name: 'Pharmacy Chain', defaultSeats: 2500 },
    { id: 'professional', name: 'Pharmacy Professional', defaultSeats: 50 },
  ]);
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'org' } }) });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { container } = render(await renderPage({ vertical: 'PHARMACY' }));
    fillPharmacyOnboarding();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Commercial package', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'professional' },
    });
    const seats = screen.getByLabelText('Seat limit', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(selectFieldControl(seats)).toHaveValue(50);
    expect(seats).toHaveAttribute('max', '50');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body).payload;
    expect(first.packageId).toBe('professional');
    expect(first.seatLimit).toBe(50);
    await waitFor(() => expect(screen.queryByText('Working…')).not.toBeInTheDocument());
    fireEvent.change(selectFieldControl(seats), { target: { value: '25' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).payload.seatLimit).toBe(25);
  } finally {
    vi.unstubAllGlobals();
  }
});
