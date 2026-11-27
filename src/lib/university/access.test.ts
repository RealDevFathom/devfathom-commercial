// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { moduleForPath } from '@/lib/module-catalog';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';
import { canAccessOffice, withUniversityStaff, type StaffContext } from './access';
import { universityOffices } from './offices';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), entitlements: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (e: { enabledModules: string[] }, key: string) => e.enabledModules.includes(key),
  resolveCurrentOrganizationEntitlements: mocks.entitlements,
}));
const academic = universityOffices.get('academics')!;
function subject(rules: StaffContext['rules'], roleKey = 'university-registrar'): StaffContext {
  return {
    roleKey,
    rules,
    admin: roleKey === 'university-admin',
    coverage: 'INSTITUTION',
    entitlements: { enabledModules: ['university-academics'], vertical: 'UNIVERSITY' },
  } as StaffContext;
}
describe('university office roles and capability inheritance', () => {
  it('finishes commercial authorization before opening each staff transaction, then verifies the current member', async () => {
    mocks.actor.mockResolvedValue({
      organization: { id: 'university' },
      session: { user: { id: 'registrar' } },
    });
    const entitlements = {
      organizationId: 'university',
      enabledModules: ['university-core'],
      vertical: 'UNIVERSITY',
    };
    let authorize!: () => void;
    mocks.entitlements.mockReturnValueOnce(
      new Promise((resolve) => {
        authorize = () => resolve(entitlements);
      })
    );
    const member = vi
      .fn()
      .mockResolvedValueOnce({ role: 'ADMIN', organizationRole: null, permissionOverrides: [] })
      .mockResolvedValueOnce(null);
    const db = { user: { findFirst: member }, $queryRaw: vi.fn() };
    mocks.withTenantDb.mockImplementation(async (_id, fn) => fn(db));
    const act = vi.fn(async (ctx: StaffContext) => ctx.userId);
    const pending = withUniversityStaff(act);
    await vi.waitFor(() => expect(mocks.entitlements).toHaveBeenCalledWith('university'));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    authorize();
    expect(await pending).toBe('registrar');
    expect(act.mock.calls[0]?.[0].entitlements).toBe(entitlements);
    expect(mocks.withTenantDb).toHaveBeenCalledWith('university', expect.any(Function), {
      userId: 'registrar',
    });
    mocks.entitlements.mockResolvedValueOnce(entitlements);
    await expect(withUniversityStaff(act)).rejects.toThrow('access');
    expect(act).toHaveBeenCalledTimes(1);
    expect(member).toHaveBeenCalledTimes(2);
  });

  it('requires an effective grant and applies explicit denial to inherited role and administrator grants', () => {
    expect(canAccessOffice(subject([]), academic)).toBe(false);
    expect(
      canAccessOffice(subject([{ capability: 'university:finance', effect: 'ALLOW' }]), academic)
    ).toBe(false);
    for (const capability of ['university:academics', 'university:*', '*']) {
      expect(canAccessOffice(subject([{ capability, effect: 'ALLOW' }]), academic)).toBe(true);
      expect(
        canAccessOffice(
          subject([
            { capability, effect: 'ALLOW' },
            { capability: 'university:academics', effect: 'DENY' },
          ]),
          academic
        )
      ).toBe(false);
    }
    expect(
      canAccessOffice(
        subject(
          [
            { capability: '*', effect: 'ALLOW' },
            { capability: 'university:*', effect: 'DENY' },
          ],
          'university-admin'
        ),
        academic
      )
    ).toBe(false);
    expect(
      canAccessOffice(
        subject([{ capability: '*', effect: 'ALLOW' }], 'university-bursar'),
        academic
      )
    ).toBe(false);
  });
  it('maps every workspace route and declared system role to its office capability', () => {
    const templates = roleTemplatesForVertical('UNIVERSITY');
    for (const [path, office] of universityOffices) {
      expect(moduleForPath('/university/' + path), path).toBe(office.moduleKey);
      for (const role of office.roles) {
        const template = templates.find((t) => t.key === role);
        expect(template, role).toBeDefined();
        const ctx = subject(
          template!.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
          role
        );
        ctx.entitlements.enabledModules = [office.moduleKey];
        expect(canAccessOffice(ctx, office), office.title + ' / ' + role).toBe(true);
        ctx.rules = ctx.rules.filter(
          (rule) =>
            rule.capability !== office.moduleKey.replace('university-', 'university:') &&
            rule.capability !== '*'
        );
        expect(canAccessOffice(ctx, office), office.title + ' / ' + role).toBe(false);
      }
    }
  });
});
