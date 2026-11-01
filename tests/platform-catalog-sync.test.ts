// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '../src/generated/prisma/client';
import { syncPlatformCatalog } from '../prisma/catalog-sync';
import {
  HOSPITALITY_PACKAGES,
  PHARMACY_PACKAGES,
  packageDefaultSeats,
  RESTAURANT_PACKAGES,
} from '../src/lib/vertical-catalog';

describe('catalog sync legacy seat defaults (#191)', () => {
  it.each([1, 7, 3000])('reconciles already-seeded packages with %i seats', async (seats) => {
    const definitions = [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES];
    const packages = definitions.map((definition) => ({
      key: definition.key,
      defaultSeats: seats,
      name: 'Admin package name',
      active: false,
      version: 27,
      moduleLinks: [{ enabled: false, limits: { custom: 12 } }],
    }));
    const before = structuredClone(packages);
    const tx = {
      platformModule: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(async ({ create }) => ({ ...create, id: create.key })),
      },
      platformPackage: {
        findMany: vi.fn().mockResolvedValue(packages),
        updateMany: vi.fn(async ({ where, data }) => {
          const row = packages.find(
            (pkg) => pkg.key === where.key && pkg.defaultSeats === where.defaultSeats
          );
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        }),
        upsert: vi.fn(),
      },
      platformPackageModule: { upsert: vi.fn() },
    };

    const result = await syncPlatformCatalog(tx as unknown as Prisma.TransactionClient);
    const expectedSeats = definitions.map(packageDefaultSeats);
    expect(packages).toEqual(
      before.map((pkg, index) => ({
        ...pkg,
        defaultSeats: seats === 1 ? expectedSeats[index] : seats,
      }))
    );
    expect(result).toMatchObject({ packagesCreated: 0, linksCreated: 0 });
    expect(tx.platformPackage.upsert).not.toHaveBeenCalled();
    expect(tx.platformPackageModule.upsert).not.toHaveBeenCalled();

    const after = structuredClone(packages);
    await syncPlatformCatalog(tx as unknown as Prisma.TransactionClient);
    expect(packages).toEqual(after);
  });
});
