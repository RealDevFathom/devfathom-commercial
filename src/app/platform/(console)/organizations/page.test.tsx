import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock('@/lib/platform/page-access', () => ({ requirePlatformRead: mocks.requirePlatformRead }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));

const verticals = ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const;
const organizations = verticals.map((vertical) => ({
  id: vertical,
  displayName: `${vertical} workspace`,
  slug: vertical.toLowerCase(),
  vertical,
  status: 'ACTIVE',
  primaryContactEmail: null,
  package: null,
  deployments: [],
  deploymentMode: 'SHARED',
  seatLimit: 10,
  _count: { users: 2, modules: 3, contracts: 1 },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.findMany.mockResolvedValue(organizations);
  mocks.withPlatformDb.mockImplementation((run) =>
    run({ organization: { findMany: mocks.findMany } })
  );
});
afterEach(cleanup);

describe('OrganizationsPage verticals', () => {
  it('shows every vertical in the unfiltered registry and selector', async () => {
    render(await OrganizationsPage({ searchParams: Promise.resolve({}) }));

    expect(mocks.requirePlatformRead).toHaveBeenCalledWith('/platform/organizations');
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, take: 250 }));
    expect(screen.getByRole('columnheader', { name: 'Vertical' })).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Vertical' });
    expect(selectFieldControl(select)).toHaveValue('');
    expect(
      within(selectFieldControl(select))
        .getAllByRole('option', { hidden: true })
        .map((option) => option.getAttribute('value'))
    ).toEqual(['', ...verticals]);
    for (const [index, label] of ['Agency', 'Restaurant', 'Pharmacy'].entries()) {
      const row = screen
        .getByRole('link', { name: organizations[index].displayName })
        .closest('tr')!;
      expect(within(row).getByRole('cell', { name: label })).toBeInTheDocument();
    }
  });

  it.each(verticals)(
    'applies %s with the existing search and lifecycle filters',
    async (vertical) => {
      mocks.findMany.mockResolvedValue(
        organizations.filter((organization) => organization.vertical === vertical)
      );
      render(
        await OrganizationsPage({
          searchParams: Promise.resolve({ vertical, status: 'ACTIVE', q: '  workspace  ' }),
        })
      );

      expect(mocks.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            vertical,
            status: 'ACTIVE',
            OR: ['displayName', 'legalName', 'slug', 'primaryContactEmail'].map((field) => ({
              [field]: { contains: 'workspace', mode: 'insensitive' },
            })),
          },
        })
      );
      expect(selectFieldControl(screen.getByRole('combobox', { name: 'Vertical' }))).toHaveValue(vertical);
      expect(selectFieldControl(screen.getByRole('combobox', { name: 'Lifecycle status' }))).toHaveValue('ACTIVE');
      expect(selectFieldControl(screen.getByPlaceholderText('Search name, slug, or contact'))).toHaveValue('workspace');
      const form = screen.getByRole('button', { name: 'Apply filters' }).closest('form')!;
      expect(new FormData(form).get('vertical')).toBe(vertical);
      expect(screen.getAllByRole('row')).toHaveLength(2);
      expect(screen.getByRole('link', { name: `${vertical} workspace` })).toBeInTheDocument();
    }
  );

  it.each(['', 'INVALID', 'agency', ['AGENCY', 'PHARMACY']])(
    'ignores invalid or ambiguous vertical %j',
    async (vertical) => {
      render(await OrganizationsPage({ searchParams: Promise.resolve({ vertical }) }));
      expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
      expect(selectFieldControl(screen.getByRole('combobox', { name: 'Vertical' }))).toHaveValue('');
    }
  );

  it('preserves the selected vertical when no organizations match', async () => {
    mocks.findMany.mockResolvedValue([]);
    render(await OrganizationsPage({ searchParams: Promise.resolve({ vertical: 'PHARMACY' }) }));
    expect(screen.getByText('No organizations match these filters.')).toBeInTheDocument();
    expect(selectFieldControl(screen.getByRole('combobox', { name: 'Vertical' }))).toHaveValue('PHARMACY');
  });

  it('does not enter the database scope when access is denied', async () => {
    mocks.requirePlatformRead.mockRejectedValue(new Error('Forbidden'));
    await expect(
      OrganizationsPage({ searchParams: Promise.resolve({ vertical: 'AGENCY' }) })
    ).rejects.toThrow('Forbidden');
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('propagates database failure to the existing route error boundary', async () => {
    mocks.findMany.mockRejectedValue(new Error('Database unavailable'));
    await expect(OrganizationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'Database unavailable'
    );
  });
});
