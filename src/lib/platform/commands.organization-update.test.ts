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
const { provisioningConfigured } = vi.hoisted(() => ({
  provisioningConfigured: vi.fn((): boolean => false),
}));
vi.mock('@/lib/platform/provisioning-config', () => ({
  isDedicatedProvisioningConfigured: provisioningConfigured,
}));
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
  $queryRaw: vi.fn(async () => [{ id: 'org_1' }]),
  organization: {
    findUnique: vi.fn(async () => before),
    update: vi.fn(async (args: { data: object }) => ({ ...before, ...args.data })),
  },
  organizationDeployment: { upsert: vi.fn(async () => ({ id: 'deployment_1' })) },
  platformJob: { create: vi.fn(async () => ({ id: 'job_1' })) },
  platformAuditLog: { create: vi.fn(async () => ({ id: 'audit_1' })) },
};

import { executePlatformCommand } from './commands';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });
const update = (timezone: string) =>
  executePlatformCommand(actor, 'organization.update', { id: 'org_1', timezone }, request);

beforeEach(() => {
  vi.clearAllMocks();
  provisioningConfigured.mockReturnValue(false);
  platformDb.organization.findUnique.mockResolvedValue(before);
});

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

describe('organization.update deployment mode', () => {
  it('refuses switching to dedicated when dedicated provisioning is unavailable', async () => {
    const error = await executePlatformCommand(
      actor,
      'organization.update',
      { id: 'org_1', deploymentMode: 'DEDICATED' },
      request
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: expect.stringContaining('Dedicated provisioning is unavailable'),
      status: 400,
    });
    expect(platformDb.$queryRaw).toHaveBeenCalledOnce();
    expect(platformDb.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FOR UPDATE')]),
      'org_1'
    );
    expect(platformDb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      platformDb.organization.findUnique.mock.invocationCallOrder[0]!
    );
    expect(platformDb.organization.update).not.toHaveBeenCalled();
    expect(platformDb.organizationDeployment.upsert).not.toHaveBeenCalled();
    expect(platformDb.platformJob.create).not.toHaveBeenCalled();
    expect(platformDb.platformAuditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        action: 'organization.update',
        actorPlatformUserId: 'op_1',
        success: false,
        reason: 'Platform command validation failed.',
        error: 'Platform command validation failed.',
        metadata: { outcomeCategory: 'validation_failed' },
      }),
    });
  });

  it('preserves the dedicated provisioning flow when it is configured', async () => {
    provisioningConfigured.mockReturnValue(true);

    await executePlatformCommand(
      actor,
      'organization.update',
      { id: 'org_1', deploymentMode: 'DEDICATED' },
      request
    );

    expect(platformDb.organization.update).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      data: expect.objectContaining({ deploymentMode: 'DEDICATED' }),
    });
    expect(platformDb.organizationDeployment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { mode: 'DEDICATED', status: 'PENDING' },
      })
    );
    expect(platformDb.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        type: 'PROVISION_DEDICATED',
      }),
    });
  });

  it('allows an unchanged dedicated mode when provisioning is unavailable', async () => {
    platformDb.organization.findUnique.mockResolvedValue({
      ...before,
      deploymentMode: 'DEDICATED',
    });

    await executePlatformCommand(
      actor,
      'organization.update',
      { id: 'org_1', deploymentMode: 'DEDICATED' },
      request
    );

    expect(provisioningConfigured).not.toHaveBeenCalled();
    expect(platformDb.organization.update).toHaveBeenCalledOnce();
    expect(platformDb.organizationDeployment.upsert).not.toHaveBeenCalled();
    expect(platformDb.platformJob.create).not.toHaveBeenCalled();
  });

  it('allows switching from dedicated to shared when provisioning is unavailable', async () => {
    platformDb.organization.findUnique.mockResolvedValue({
      ...before,
      deploymentMode: 'DEDICATED',
    });

    await executePlatformCommand(
      actor,
      'organization.update',
      { id: 'org_1', deploymentMode: 'SHARED' },
      request
    );

    expect(platformDb.organization.update).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      data: expect.objectContaining({ deploymentMode: 'SHARED' }),
    });
    expect(platformDb.organizationDeployment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { mode: 'SHARED', status: 'PENDING' },
      })
    );
    expect(platformDb.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        type: 'PROVISION_SHARED',
      }),
    });
  });
});
