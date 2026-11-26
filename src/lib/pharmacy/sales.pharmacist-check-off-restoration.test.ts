import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-911: a controlled void or return at the counter needs a pharmacist witness while the
// owner's check is on. While it is off, the restoration goes ahead without one and its
// register correction carries the owner-switched-off marker.
vi.mock('server-only', () => ({}));
vi.mock('./controlled-restoration-authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./controlled-restoration-authorization')>()),
  authorizeControlledRestoration: vi.fn(),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  authorizeControlledRestoration,
  ControlledRestorationDenied,
} from './controlled-restoration-authorization';
import { controlledSaleRestorationWitness } from './sales';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const pin = { staffProfileId: 'staff-1', pin: '1234' };

function dbWith(policy: unknown, requireSecondPharmacist = false) {
  const findUnique = vi.fn(async () => {
    if (policy instanceof Error) throw policy;
    return policy;
  });
  return {
    db: {
      $queryRaw: async () => [{ requireSecondPharmacist }],
      pharmacyOwnerPolicy: { findUnique },
    } as unknown as ScopedDb,
    findUnique,
  };
}

beforeEach(() => {
  vi.mocked(authorizeControlledRestoration).mockReset();
});

describe('controlledSaleRestorationWitness', () => {
  it('uses the pharmacist witness unchanged when one is given, without reading the setting', async () => {
    const witness = { witnessedByUserId: 'pharmacist-1', signatureRef: 'pin:cred:1' };
    vi.mocked(authorizeControlledRestoration).mockResolvedValue(witness);
    const { db, findUnique } = dbWith({
      pharmacistCheckEnabled: false,
      pharmacistCheckPolicyVersion: 2,
    });
    await expect(controlledSaleRestorationWitness(db, scope, pin)).resolves.toBe(witness);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([new ControlledRestorationDenied(), new ControlledRestorationDenied(true)])(
    'goes ahead without a pharmacist while the check is off, marked for the register (%s)',
    async (refusal) => {
      vi.mocked(authorizeControlledRestoration).mockRejectedValue(refusal);
      const { db } = dbWith({ pharmacistCheckEnabled: false, pharmacistCheckPolicyVersion: 2 });
      await expect(controlledSaleRestorationWitness(db, scope)).resolves.toEqual({
        witnessedByUserId: 'cashier-1',
        signatureRef: 'pharmacist-check-off:v2',
      });
    }
  );

  it.each([
    ['on', { pharmacistCheckEnabled: true, pharmacistCheckPolicyVersion: 3 }],
    ['missing', null],
    ['unreadable', new Error('read failed')],
  ])('refuses exactly as before while the setting is %s', async (_label, policy) => {
    const refusal = new ControlledRestorationDenied();
    vi.mocked(authorizeControlledRestoration).mockRejectedValue(refusal);
    await expect(controlledSaleRestorationWitness(dbWith(policy).db, scope)).rejects.toBe(refusal);
  });

  it('never turns an unrelated failure into a marked restoration', async () => {
    vi.mocked(authorizeControlledRestoration).mockRejectedValue(new Error('database down'));
    const { db } = dbWith({ pharmacistCheckEnabled: false, pharmacistCheckPolicyVersion: 2 });
    await expect(controlledSaleRestorationWitness(db, scope, pin)).rejects.toThrow('database down');
  });
});

it('keeps the independent counter restoration when the branch requires it despite the business check being OFF', async () => {
  const refusal = new ControlledRestorationDenied();
  vi.mocked(authorizeControlledRestoration).mockRejectedValue(refusal);
  const { db } = dbWith({ pharmacistCheckEnabled: false, pharmacistCheckPolicyVersion: 2 }, true);
  await expect(controlledSaleRestorationWitness(db, scope)).rejects.toBe(refusal);
});
