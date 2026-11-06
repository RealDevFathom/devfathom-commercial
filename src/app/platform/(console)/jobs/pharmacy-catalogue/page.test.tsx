import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PharmacyDefaultCataloguePage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn().mockResolvedValue({ role: 'SUPER_ADMIN' }),
  withPlatformDb: vi.fn(),
}));

vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: mocks.requirePlatformRead,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('@/components/platform/platform-command-form', () => ({
  PlatformCommandButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const TOTAL = 120;
const pharmacies = Array.from({ length: TOTAL }, (_, index) => ({
  id: `org_${String(index).padStart(3, '0')}`,
  // Every name repeats, so only the id tie-break keeps pages stable.
  displayName: `Pharmacy ${String(Math.floor(index / 2)).padStart(3, '0')}`,
  status: 'ACTIVE',
}));

function database() {
  return {
    platformMedicineCatalogueVersion: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'version-1',
          key: 'pharmacy-default',
          version: 1,
          digest: 'a'.repeat(64),
          rowCount: 18_933,
          publishedAt: new Date('2026-11-01T00:00:00Z'),
          createdAt: new Date('2026-11-01T00:00:00Z'),
        },
      ]),
    },
    organization: {
      count: vi.fn().mockResolvedValue(TOTAL),
      findMany: vi.fn(({ skip, take }: { skip: number; take: number }) =>
        Promise.resolve(pharmacies.slice(skip, skip + take))
      ),
    },
    medicineCatalogueProvenance: { groupBy: vi.fn().mockResolvedValue([]) },
    platformJob: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

let db: ReturnType<typeof database>;

beforeEach(() => {
  db = database();
  mocks.withPlatformDb.mockImplementation((run: (scoped: typeof db) => Promise<unknown>) =>
    run(db)
  );
});

describe('PharmacyDefaultCataloguePage pagination', () => {
  it('pages pharmacies on the server with a stable order, total count and next/prev', async () => {
    render(
      await PharmacyDefaultCataloguePage({ searchParams: Promise.resolve({ page: '2' }) })
    );

    expect(db.organization.count).toHaveBeenCalledWith({
      where: { vertical: 'PHARMACY', status: { not: 'PURGED' } },
    });
    expect(db.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        skip: 50,
        take: 50,
      })
    );
    // Only the visible page is aggregated, never a fixed cap of pharmacies.
    expect(db.platformJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: { in: pharmacies.slice(50, 100).map((org) => org.id) },
        }),
      })
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 51–100 of 120 pharmacies by name · page 2 of 3'
    );
    expect(screen.getAllByText('Pharmacy 025')).toHaveLength(2);
    expect(screen.queryByText('Pharmacy 024')).not.toBeInTheDocument();
    expect(screen.queryByText('Pharmacy 050')).not.toBeInTheDocument();

    const pager = screen.getByRole('navigation', { name: 'Pharmacy pages' });
    expect(pager).toHaveTextContent('2 / 3');
    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute(
      'href',
      '/platform/jobs/pharmacy-catalogue?page=1'
    );
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/platform/jobs/pharmacy-catalogue?page=3'
    );
  });

  it('clamps a page past the end to the last page and keeps a custom page size', async () => {
    render(
      await PharmacyDefaultCataloguePage({
        searchParams: Promise.resolve({ page: '99', pageSize: '25' }),
      })
    );

    expect(db.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 25 })
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 101–120 of 120 pharmacies by name · page 5 of 5'
    );
    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute(
      'href',
      '/platform/jobs/pharmacy-catalogue?page=4&pageSize=25'
    );
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('falls back to the first page for an invalid request', async () => {
    render(
      await PharmacyDefaultCataloguePage({
        searchParams: Promise.resolve({ page: '-3', pageSize: 'lots' }),
      })
    );

    expect(db.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 50 })
    );
    expect(screen.queryByRole('link', { name: 'Previous page' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/platform/jobs/pharmacy-catalogue?page=2'
    );
  });
});
