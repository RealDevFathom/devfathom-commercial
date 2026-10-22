import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NewOrganizationPage from './page';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

describe('NewOrganizationPage', () => {
  it('renders the full onboarding order and filters package choices by vertical', async () => {
    const packages = [
      { id: 'agency', name: 'Agency Growth', defaultSeats: 10, vertical: 'AGENCY' },
      {
        id: 'restaurant',
        name: 'Restaurant Essentials',
        defaultSeats: 5,
        vertical: 'RESTAURANT',
      },
    ];
    mocks.withPlatformDb.mockImplementation((run: (db: unknown) => unknown) =>
      run({ platformPackage: { findMany: vi.fn().mockResolvedValue(packages) } })
    );

    render(await NewOrganizationPage({ searchParams: Promise.resolve({}) }));

    const vertical = screen.getByLabelText(/^Organization type/);
    const packageSelect = screen.getByLabelText('Commercial package');
    expect(
      Array.from(
        packageSelect.form!.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >('input:not([type="hidden"]), select, textarea')
      ).map((control) => control.labels?.[0]?.querySelector('span')?.textContent)
    ).toEqual([
      'Organization type',
      'Display name',
      'Legal name',
      'Workspace slug',
      'Deployment mode',
      'Commercial package',
      'Seat limit',
      'Currency',
      'Timezone',
      'Locale',
      'Grace period (days)',
      'Data residency',
      'Primary contact',
      'Primary contact email',
      'Tenant administrator',
      'Administrator email',
      'Temporary administrator password',
      'Operator notes',
    ]);
    expect(vertical).toHaveValue('AGENCY');
    expect(within(packageSelect).getByRole('option')).toHaveTextContent('Agency Growth');

    fireEvent.change(vertical, { target: { value: 'RESTAURANT' } });

    expect(within(packageSelect).getAllByRole('option')).toHaveLength(1);
    expect(within(packageSelect).getByRole('option')).toHaveTextContent('Restaurant Essentials');
  });
});
