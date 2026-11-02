// @vitest-environment node
/**
 * Seed reporting for #312: the platform operator is announced as created or
 * updated, a missing one is a warning rather than silence, and a unique
 * violation becomes an instruction instead of a raw Prisma stack.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportPlatformAdmin, upsertPlatformAdmin } from '../prisma/platform-admin';
import { conflictingSeedDataMessage } from '../prisma/seed-failure';

const envKeys = ['PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD'] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function transaction(existing: { id: string } | null) {
  const findUnique = vi.fn(async () => existing);
  const upsert = vi.fn(async () => ({}));
  return { tx: { platformUser: { findUnique, upsert } } as never, findUnique, upsert };
}

describe('upsertPlatformAdmin result', () => {
  it('reports created for an operator that did not exist', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'Ops@Example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'local-operator-password';
    const { tx, findUnique, upsert } = transaction(null);

    await expect(upsertPlatformAdmin(tx)).resolves.toEqual({
      status: 'created',
      email: 'ops@example.com',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'ops@example.com' },
      select: { id: true },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('reports updated for an operator that already existed', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@example.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'rotated-operator-password';
    const { tx, upsert } = transaction({ id: 'platform-user-1' });

    await expect(upsertPlatformAdmin(tx)).resolves.toEqual({
      status: 'updated',
      email: 'ops@example.com',
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('reports skipped, touching nothing, when both variables are unset', async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    const { tx, findUnique, upsert } = transaction(null);

    await expect(upsertPlatformAdmin(tx)).resolves.toEqual({ status: 'skipped' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('still refuses exactly one of the two variables', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@example.com';
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    const { tx, upsert } = transaction(null);

    await expect(upsertPlatformAdmin(tx)).rejects.toThrow(
      /PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD/
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('reportPlatformAdmin', () => {
  function logger() {
    return { log: vi.fn(), warn: vi.fn() };
  }

  it('says when the operator was created', () => {
    const log = logger();
    reportPlatformAdmin({ status: 'created', email: 'ops@example.com' }, log);
    expect(log.log).toHaveBeenCalledWith('✓ Platform operator created: ops@example.com');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('says when the operator was updated', () => {
    const log = logger();
    reportPlatformAdmin({ status: 'updated', email: 'ops@example.com' }, log);
    expect(log.log).toHaveBeenCalledWith(
      '✓ Platform operator updated (password, role, active): ops@example.com'
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns, distinctly, when neither variable is set', () => {
    const log = logger();
    reportPlatformAdmin({ status: 'skipped' }, log);
    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(
      /PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are both unset: no platform operator/
    );
  });
});

describe('conflictingSeedDataMessage', () => {
  it('turns a driver-adapter P2002 into an actionable instruction', () => {
    const error = Object.assign(new Error('Unique constraint failed'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: {
        modelName: 'Invoice',
        driverAdapterError: {
          cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['invoiceNumber'] } },
        },
      },
    });

    const message = conflictingSeedDataMessage(error);

    expect(message).toContain('this database already contains conflicting seed data');
    expect(message).toContain('unique constraint on Invoice (invoiceNumber)');
    expect(message).toContain('bun run db:reset');
    expect(message).not.toContain('at ');
  });

  it('reads the classic meta.target too, and works without any meta', () => {
    expect(conflictingSeedDataMessage({ code: 'P2002', meta: { target: ['slug'] } })).toContain(
      '(unique constraint on slug)'
    );
    expect(conflictingSeedDataMessage({ code: 'P2002' })).toContain('conflicting seed data.\n');
  });

  it('leaves every other failure to the default report', () => {
    expect(conflictingSeedDataMessage({ code: 'P2003' })).toBeUndefined();
    expect(conflictingSeedDataMessage(new Error('boom'))).toBeUndefined();
    expect(conflictingSeedDataMessage(undefined)).toBeUndefined();
  });
});
