import { describe, expect, it, vi } from 'vitest';
import { can, type Subject } from '@/lib/abac';
import { readAIAvailability } from './provider';

vi.mock('server-only', () => ({}));

const pharmacist: Subject = {
  id: 'user_abbasi_pharmacist',
  role: 'EMPLOYEE',
  department: 'Pharmacy',
  status: 'ACTIVE',
};

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
function authorizationDb(roleRules: Rule[], overrideRules: Rule[] = []) {
  return {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: roleRules },
        permissionOverrides: overrideRules,
      })),
    },
  } as never;
}

describe('pharmacy AI budget-alert security contracts', () => {
  it.each(['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'] as const)(
    'requires an exact %s grant rather than a pharmacy wildcard',
    async (capability) => {
      await expect(
        can(pharmacist, capability, undefined, {
          db: authorizationDb([{ capability: 'pharmacy:*', effect: 'ALLOW' }]),
        })
      ).resolves.toBe(false);
      await expect(
        can(pharmacist, capability, undefined, {
          db: authorizationDb([{ capability, effect: 'ALLOW' }]),
        })
      ).resolves.toBe(true);
    }
  );

  it.each(['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'] as const)(
    'gives an explicit DENY precedence over an ALLOW for %s through central can()',
    async (capability) => {
      await expect(
        can(pharmacist, capability, undefined, {
          db: authorizationDb(
            [{ capability, effect: 'ALLOW' }],
            [{ capability, effect: 'DENY' }]
          ),
        })
      ).resolves.toBe(false);
    }
  );

  it('keeps DevFathom AI off by default when the server has no provider selector', () => {
    expect(readAIAvailability({})).toEqual({ available: false, reason: 'DISABLED' });
  });

  it('keeps Anthropic off until its provider secret is configured server-side', () => {
    expect(readAIAvailability({ AI_PROVIDER: 'anthropic' })).toEqual({
      available: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(
      readAIAvailability({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'server-secret' })
    ).toEqual({ available: true, provider: 'anthropic' });
  });
});
