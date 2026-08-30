import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  transactionCalls: 0,
  runtimeFailure: false,
  auditFailure: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual };
});

const platformDb = {
  $queryRawUnsafe: vi.fn(async (_query: string, organizationId: string) => [
    { id: organizationId },
  ]),
  platformSetting: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async (args: { data?: unknown; create: Record<string, unknown> }) => {
      if (state.runtimeFailure) throw new Error('database exploded with password=hunter2');
      return { id: 'setting_1', ...args.create };
    }),
  },
  platformAuditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (state.auditFailure) throw new Error('audit sink exposed token=secret');
      if (data.id && state.audits.some((row) => row.id === data.id)) {
        throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      }
      state.audits.push(data);
      return data;
    }),
  },
};

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: typeof platformDb) => Promise<unknown>) => {
    state.transactionCalls += 1;
    return run(platformDb);
  }),
}));

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = (role: 'SUPER_ADMIN' | 'AUDITOR' = 'SUPER_ADMIN') =>
  ({ id: 'operator_1', role }) as never;
const request = (requestId = 'req_failure_1') =>
  new Request('https://admin.devfathom.test/api/platform/control', {
    method: 'POST',
    headers: {
      'x-devfathom-request-id': requestId,
      'user-agent': 'vitest secret-agent-value',
    },
  });

const setting = (value: unknown = { ordinary: true }) => ({
  key: 'audit.failure.test',
  category: 'test',
  value,
  sensitive: false,
});

describe('platform command failure auditing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.audits.length = 0;
    state.transactionCalls = 0;
    state.runtimeFailure = false;
    state.auditFailure = false;
  });

  it('persists one attributed capability denial outside a command transaction', async () => {
    await expect(
      executePlatformCommand(actor('AUDITOR'), 'setting.upsert', setting(), request())
    ).rejects.toMatchObject({ status: 403 });

    expect(state.transactionCalls).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      actorPlatformUserId: 'operator_1',
      action: 'setting.upsert',
      success: false,
      reason: 'Platform command capability denied.',
      metadata: { outcomeCategory: 'capability_denied' },
      requestId: 'req_failure_1',
    });
  });

  it('persists validation failure without copying raw input', async () => {
    const secret = 'password=validation-secret';
    await expect(
      executePlatformCommand(actor(), 'setting.upsert', { ...setting(), key: secret }, request())
    ).rejects.toThrow();

    expect(state.transactionCalls).toBe(2);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      success: false,
      reason: 'Platform command validation failed.',
      metadata: { outcomeCategory: 'validation_failed' },
    });
    expect(JSON.stringify(state.audits[0])).not.toContain(secret);
  });

  it('persists runtime failure after the command transaction rejects', async () => {
    state.runtimeFailure = true;
    await expect(
      executePlatformCommand(actor(), 'setting.upsert', setting(), request())
    ).rejects.toThrow('database exploded');

    expect(state.transactionCalls).toBe(2);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      success: false,
      error: 'Platform command transaction failed.',
      metadata: { outcomeCategory: 'command_failed' },
    });
    expect(JSON.stringify(state.audits[0])).not.toContain('hunter2');
  });

  it('preserves success audit semantics inside one transaction', async () => {
    await expect(
      executePlatformCommand(actor(), 'setting.upsert', setting(), request())
    ).resolves.toMatchObject({ id: 'setting_1' });

    expect(state.transactionCalls).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: 'setting.upsert' });
    expect(state.audits[0].success).toBeUndefined();
  });

  it('deduplicates a replay by actor, action, category, and correlation id', async () => {
    state.runtimeFailure = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        executePlatformCommand(actor(), 'setting.upsert', setting(), request('req_replay'))
      ).rejects.toThrow('database exploded');
    }

    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].requestId).toBe('req_replay');
  });

  it('fails closed with a generic error and constant operational log if audit persistence fails', async () => {
    state.runtimeFailure = true;
    state.auditFailure = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const error = await executePlatformCommand(
      actor(),
      'setting.upsert',
      setting({ token: 'do-not-log' }),
      request()
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 500,
      message: 'The platform command failed and its audit record could not be persisted.',
    });
    expect(log).toHaveBeenCalledWith('[platform-audit] failed to persist command failure');
    expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log');
    log.mockRestore();
  });
});
