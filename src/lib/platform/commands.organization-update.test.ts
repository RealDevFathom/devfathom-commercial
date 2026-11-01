/**
 * The platform's `organization.update` command sets the workspace time zone that
 * every pharmacy day-close, counter, marketing and digest path formats in, and
 * Intl throws on a zone it does not know. The command is held to the IANA check
 * `organization.create` and the workspace profile already apply (mock-style,
 * modeled on commands.package-inheritance.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const before = {
  id: 'org_1',
  vertical: 'PHARMACY',
  status: 'ACTIVE',
  activatedAt: new Date('2026-09-01T00:00:00.000Z'),
  packageId: 'pkg_1',
  deploymentMode: 'SHARED',
  timezone: 'Asia/Karachi',
};
const platformDb = {
  organization: {
    findUnique: vi.fn(async () => before),
    update: vi.fn(async (args: { data: object }) => ({ ...before, ...args.data })),
  },
  platformAuditLog: { create: vi.fn(async () => ({ id: 'audit_1' })) },
};

import { executePlatformCommand } from './commands';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });
const update = (timezone: string) =>
  executePlatformCommand(actor, 'organization.update', { id: 'org_1', timezone }, request);

beforeEach(() => vi.clearAllMocks());

describe('organization.update time zone', () => {
  it.each(['PKT', 'UTC+5', 'Mars/Olympus'])(
    'refuses %s with the field error the create path gives, writing nothing',
    async (timezone) => {
      const error = await update(timezone).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues).toEqual([
        expect.objectContaining({ path: ['timezone'], message: 'Choose a valid IANA timezone.' }),
      ]);
      expect(platformDb.organization.update).not.toHaveBeenCalled();
    }
  );

  it('saves an IANA zone, trimmed', async () => {
    await update(' America/Chicago ');
    expect(platformDb.organization.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_1' },
      data: expect.objectContaining({ timezone: 'America/Chicago' }),
    });
  });
});
