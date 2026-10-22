import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can } from '@/lib/abac';
import { canReleaseRxSale } from './rx-sale-gate';

vi.mock('@/lib/abac', () => ({ can: vi.fn() }));

const mockedCan = vi.mocked(can);
const actor = { id: 'pharmacist-a', role: 'EMPLOYEE', status: 'ACTIVE' };

function fixture(prescription: { id: string } | null = { id: 'rx-a' }) {
  const findFirst = vi.fn(async () => prescription);
  const db = { prescription: { findFirst } };
  return { db, findFirst };
}

describe('Rx sale gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCan.mockResolvedValue(true);
  });

  it('requires the central exact dispense grant and honours its DENY decision', async () => {
    const { db, findFirst } = fixture();
    mockedCan.mockResolvedValue(false);

    await expect(
      canReleaseRxSale(db as never, {
        organizationId: 'org-a',
        actor,
        prescriptionId: 'rx-a',
      })
    ).resolves.toBe(false);

    expect(mockedCan).toHaveBeenCalledWith(actor, 'pharmacy:dispense', undefined, {
      db,
      now: undefined,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('allows a granted actor only when the Rx exists in the same tenant', async () => {
    const { db, findFirst } = fixture();

    await expect(
      canReleaseRxSale(db as never, {
        organizationId: 'org-a',
        actor,
        prescriptionId: 'rx-a',
      })
    ).resolves.toBe(true);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'rx-a', organizationId: 'org-a' },
      select: { id: true },
    });
  });

  it.each([
    ['missing', null],
    ['cross-tenant', null],
  ])('rejects a %s Rx reference', async (_case, prescription) => {
    const { db } = fixture(prescription);

    await expect(
      canReleaseRxSale(db as never, {
        organizationId: 'org-a',
        actor,
        prescriptionId: 'rx-from-request',
      })
    ).resolves.toBe(false);
  });
});
