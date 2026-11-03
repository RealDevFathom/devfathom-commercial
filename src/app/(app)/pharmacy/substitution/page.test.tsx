import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  can: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role: string }) => user,
}));
vi.mock('@/components/pharmacy/dispensing/substitution-console', () => ({
  SubstitutionConsole: () => null,
}));

import { SubstitutionConsole } from '@/components/pharmacy/dispensing/substitution-console';
import SubstitutionPage from './page';

function signIn(role: string, grants: readonly string[]) {
  const session = { user: { id: `${role}-user`, role } };
  mocks.actor.mockResolvedValue({ session, organization: { id: 'org' }, support: null });
  mocks.context.mockResolvedValue({ session, db: {} });
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    grants.includes(action)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation(() => {
    throw new Error('redirect');
  });
});

describe('Substitution workspace by role', () => {
  it.each([
    ['cashier', 'EMPLOYEE', ['pharmacy:counter', 'pharmacy:orders']],
    [
      'manager',
      'EMPLOYEE',
      ['pharmacy:manage', 'pharmacy:procurement', 'pharmacy:close', 'reports:operational'],
    ],
    ['owner without a clinical grant', 'ADMIN', ['reports:operational', 'reports:financial']],
  ] as const)(
    'sends the %s home instead of showing an error or a locked workspace',
    async (_persona, role, grants) => {
      signIn(role, grants);
      await expect(SubstitutionPage()).rejects.toThrow('redirect');
      expect(mocks.redirect).toHaveBeenCalledWith('/dashboard');
    }
  );

  it.each([
    ['pharmacist', ['pharmacy:dispense']],
    ['safety holder', ['pharmacy:safety']],
  ] as const)('opens the workspace for a %s', async (_persona, grants) => {
    signIn('EMPLOYEE', grants);
    const page = await SubstitutionPage();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.type).toBe(SubstitutionConsole);
  });

  it('sends a signed-out visitor home without asking for capabilities', async () => {
    mocks.actor.mockResolvedValue(null);
    await expect(SubstitutionPage()).rejects.toThrow('redirect');
    expect(mocks.can).not.toHaveBeenCalled();
  });
});
