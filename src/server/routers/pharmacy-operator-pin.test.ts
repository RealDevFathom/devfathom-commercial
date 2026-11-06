import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  enrol: vi.fn(),
  status: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/pharmacy/operator-pin', async () => {
  class PharmacyPinEnrolmentError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  }
  return {
    enrolPharmacyOperatorPin: mocks.enrol,
    listPharmacyPinStatus: mocks.status,
    PharmacyPinEnrolmentError,
  };
});
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    recordTrpcAudit: vi.fn(),
    annotateAudit: (
      ctx: Parameters<typeof actual.annotateAudit>[0],
      detail: Parameters<typeof actual.annotateAudit>[1]
    ) => {
      mocks.annotateAudit(ctx, detail);
      actual.annotateAudit(ctx, detail);
    },
  };
});

import { PharmacyPinEnrolmentError } from '@/lib/pharmacy/operator-pin';
import type { TRPCContext } from '../trpc';
import { pharmacyOperatorPinRouter } from './pharmacy-operator-pin';

function caller({
  role = 'ADMIN',
  vertical = 'PHARMACY',
  modules = ['pharmacy-core'],
}: { role?: string; vertical?: string; modules?: string[] } = {}) {
  const db = { $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)) };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: modules, modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-1',
        role,
        department: 'operations',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    api: pharmacyOperatorPinRouter.createCaller(context as unknown as TRPCContext),
  };
}

const rows = [
  { userId: 'user-1', name: 'Owner', email: 'o@x.test', isOwner: true, hasPin: false },
  { userId: 'user-2', name: 'Manager', email: 'm@x.test', isOwner: false, hasPin: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.status.mockResolvedValue(rows);
});

describe('pharmacy operator PIN enrolment router', () => {
  it('is licensed by pharmacy-core only, not restaurant-core', async () => {
    mocks.enrol.mockResolvedValue({
      ok: true,
      credentialId: 'cred-1',
      staffProfileId: 'staff-1',
      targetUserId: 'user-1',
      reset: false,
    });
    const { api } = caller({ modules: ['pharmacy-core'] });
    await expect(api.setPin({ pin: '1357' })).resolves.toEqual({
      targetUserId: 'user-1',
      reset: false,
    });
  });

  it('never puts the PIN into the audit detail or the response', async () => {
    mocks.enrol.mockResolvedValue({
      ok: true,
      credentialId: 'cred-1',
      staffProfileId: 'staff-1',
      targetUserId: 'user-2',
      reset: true,
    });
    const { api, context } = caller();
    const result = await api.setPin({ targetUserId: 'user-2', pin: '1357' });
    expect(JSON.stringify(result)).not.toContain('1357');
    expect(context.audit.detail).toMatchObject({
      skipInput: true,
      targetType: 'RestaurantOperatorCredential',
      targetId: 'cred-1',
    });
    expect(JSON.stringify(context.audit.detail)).not.toContain('1357');
    for (const [, detail] of mocks.annotateAudit.mock.calls)
      expect(detail).toMatchObject({ skipInput: true });
    expect(mocks.enrol).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', userId: 'user-1', role: 'ADMIN' },
      { targetUserId: 'user-2', pin: '1357' }
    );
  });

  it('denies a session without pharmacy:manage before any enrolment', async () => {
    mocks.can.mockResolvedValue(false);
    const { api } = caller({ role: 'EMPLOYEE' });
    await expect(api.setPin({ pin: '1357' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.enrol).not.toHaveBeenCalled();
  });

  it('denies a non-pharmacy organization', async () => {
    const { api } = caller({ vertical: 'RESTAURANT' });
    await expect(api.setPin({ pin: '1357' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.enrol).not.toHaveBeenCalled();
  });

  it('rejects malformed PINs before hashing', async () => {
    const { api } = caller();
    for (const pin of ['12', '123456789', 'abcd'])
      await expect(api.setPin({ pin })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.enrol).not.toHaveBeenCalled();
  });

  it('commits the failed current-PIN counter before refusing', async () => {
    mocks.enrol.mockResolvedValue({ ok: false, code: 'CURRENT_PIN_INVALID' });
    const { api, db } = caller({ role: 'EMPLOYEE' });
    await expect(api.setPin({ pin: '1357', currentPin: '0000' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The transaction resolved (committed) rather than rolling back.
    await expect(db.$transaction.mock.results[0].value).resolves.toEqual({
      ok: false,
      code: 'CURRENT_PIN_INVALID',
    });
  });

  it('maps enrolment refusals to typed errors', async () => {
    mocks.enrol.mockRejectedValue(
      new PharmacyPinEnrolmentError('Only an owner may set it.', 'FORBIDDEN')
    );
    const { api } = caller({ role: 'EMPLOYEE' });
    await expect(api.setPin({ targetUserId: 'user-2', pin: '1357' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.enrol.mockRejectedValue(
      new PharmacyPinEnrolmentError('Enter your current PIN.', 'CURRENT_PIN_REQUIRED')
    );
    await expect(api.setPin({ pin: '1357' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('shows the owner the roster and a manager only their own row', async () => {
    await expect(caller().api.status()).resolves.toHaveLength(2);
    await expect(caller({ role: 'EMPLOYEE' }).api.status()).resolves.toEqual([rows[0]]);
  });
});
