// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { moduleForPath } from '@/lib/module-catalog';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';
import { canAccessOffice, type StaffContext } from './access';
import { universityOffices } from './offices';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (e: { enabledModules: string[] }, key: string) => e.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
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
