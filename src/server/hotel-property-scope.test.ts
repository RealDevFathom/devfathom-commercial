import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from './trpc';
const mocks = vi.hoisted(() => ({ can: vi.fn(), module: vi.fn(), verdict: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/auth/session-state', () => ({ evaluateSessionUser: mocks.verdict }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
import { requireHotelPropertyScope, hotelCapabilityInput } from './hotel-property-scope';
const property = { branchId: 'property_1', organizationId: 'org_1', name: 'Synthetic Hotel' };
const find = vi.fn();
function context() {
  return {
    session: { user: { id: 'user_1', organizationId: 'org_1' } },
    entitlements: { organizationId: 'org_1' },
    requestMeta: { ip: null },
    db: { hotelPropertyAssignment: { findFirst: find } },
  } as unknown as TRPCContext;
}
const assignment = (permissions: { capability: string; effect: string }[]) => ({
  property,
  role: { permissions },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.module.mockReturnValue(true);
  mocks.verdict.mockReturnValue({ ok: true });
  find.mockResolvedValue(assignment([{ capability: 'hotel:property-admin', effect: 'ALLOW' }]));
});
describe('hotel property scope', () => {
  it('requires explicit organization, property, member, active property and known role predicates', async () => {
    expect(
      await requireHotelPropertyScope(context(), 'property_1', 'hotel:property-admin')
    ).toEqual(property);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'property_1',
          userId: 'user_1',
          active: true,
          user: { organizationId: 'org_1', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
          property: { organizationId: 'org_1', active: true },
          role: {
            organizationId: 'org_1',
            key: { in: expect.arrayContaining(['owner', 'read-only-auditor']) },
          },
        }),
      })
    );
  });
  it.each(['*', 'hotel:*', 'hotel:property-admin'])(
    'recognizes an explicit %s property grant',
    async (capability) => {
      find.mockResolvedValue(assignment([{ capability, effect: 'ALLOW' }]));
      await expect(
        requireHotelPropertyScope(context(), 'property_1', 'hotel:property-admin')
      ).resolves.toEqual(property);
    }
  );
  it.each(
    [
      [],
      [{ capability: 'hotel:folio', effect: 'ALLOW' }],
      [
        { capability: 'hotel:property-admin', effect: 'ALLOW' },
        { capability: 'hotel:*', effect: 'DENY' },
      ],
    ].map((permissions) => ({ permissions }))
  )('denies missing, unrelated or overridden assignment grants', async ({ permissions }) => {
    find.mockResolvedValue(assignment(permissions));
    await expect(
      requireHotelPropertyScope(context(), 'property_1', 'hotel:property-admin')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('denies missing assignment and rechecks it for every request', async () => {
    await requireHotelPropertyScope(context(), 'property_1', 'hotel:property-admin');
    find.mockResolvedValueOnce(null);
    await expect(
      requireHotelPropertyScope(context(), 'property_1', 'hotel:property-admin')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(find).toHaveBeenCalledTimes(2);
  });
  it.each(['no-session', 'wrong-organization', 'ended-session', 'no-module', 'ceiling-deny'])(
    'rejects %s before reading assignments',
    async (reason) => {
      const ctx = context();
      if (reason === 'no-session') ctx.session = null;
      if (reason === 'wrong-organization') ctx.entitlements.organizationId = 'org_other';
      if (reason === 'ended-session')
        mocks.verdict.mockReturnValue({ ok: false, kind: 'session-ended', message: 'Ended' });
      if (reason === 'no-module') mocks.module.mockReturnValue(false);
      if (reason === 'ceiling-deny') mocks.can.mockResolvedValue(false);
      await expect(
        requireHotelPropertyScope(ctx, 'property_1', 'hotel:property-admin')
      ).rejects.toThrow();
      expect(find).not.toHaveBeenCalled();
    }
  );
  it('rejects unknown capabilities instead of treating them as grants', () => {
    expect(hotelCapabilityInput.safeParse('hotel:unregistered').success).toBe(false);
  });
});
