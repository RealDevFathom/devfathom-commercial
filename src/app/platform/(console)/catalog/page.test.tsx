import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CatalogPage from './page';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

describe('CatalogPage', () => {
  it('shows each package vertical', async () => {
    const database = {
      platformModule: { findMany: vi.fn().mockResolvedValue([]) },
      // WHA-257 added the camera brand presets panel to this page.
      platformCameraBrandPreset: { findMany: vi.fn().mockResolvedValue([]) },
      platformPackage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'restaurant-package',
            key: 'restaurant-essentials',
            name: 'Restaurant Essentials',
            vertical: 'RESTAURANT',
            version: 1,
            active: true,
            defaultSeats: 5,
            description: null,
            moduleLinks: [],
            _count: { organizations: 0 },
          },
        ]),
      },
    };
    mocks.withPlatformDb.mockImplementation((run: (db: typeof database) => unknown) =>
      run(database)
    );

    render(await CatalogPage());

    expect(screen.getByText('restaurant-essentials · version 1 · Restaurant')).toBeVisible();
  });
});
