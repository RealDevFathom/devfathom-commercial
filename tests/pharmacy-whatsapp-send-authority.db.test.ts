/**
 * SEC-624-01: real PostgreSQL conditional UPDATE and commit behavior. Only the
 * provider and synchronization/fault hooks are synthetic; no Meta/network calls.
 * Requires TEST_DATABASE_URL for a migrated LOCAL disposable database, reached
 * through a NOSUPERUSER/NOBYPASSRLS role with fixture DML permissions. No DDL,
 * role creation, migrations or service startup are performed by this suite.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { WhatsAppProviderError } from '@/lib/pharmacy/whatsapp/provider';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import { deferred, rendezvous } from './support/whatsapp-message-log-store';

const hooks = vi.hoisted(() => ({
  beforeAuthority: undefined as undefined | (() => Promise<void>),
  failOutcomeWrite: false,
}));

// Preserve the real scoped transactions/Prisma UPDATEs, only pausing immediately
// before authority acquisition or injecting an outcome-write failure on demand.
vi.mock('@/lib/tenancy/scoped-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenancy/scoped-db')>();
  const withTenantDb: typeof actual.withTenantDb = (organizationId, run, options) =>
    actual.withTenantDb(
      organizationId,
      (tx) =>
        run(
          new Proxy(tx, {
            get(target, key, receiver) {
              const value = Reflect.get(target, key, receiver);
              if (key !== 'pharmacyMessageLog') return value;
              return new Proxy(value, {
                get(delegate, operation, delegateReceiver) {
                  const method = Reflect.get(delegate, operation, delegateReceiver);
                  if (operation !== 'updateMany' && operation !== 'update') return method;
                  return async (...args: unknown[]) => {
                    if (operation === 'updateMany') await hooks.beforeAuthority?.();
                    if (operation === 'update' && hooks.failOutcomeWrite)
                      throw new Error('injected outcome write failure');
                    return Reflect.apply(method, delegate, args);
                  };
                },
              });
            },
          })
        ),
      options
    );
  return { ...actual, withTenantDb };
});

const url = process.env.TEST_DATABASE_URL;
const describeDatabase = url ? describe : describe.skip;
const suffix = randomUUID();
const organizationId = 'sec624_a_' + suffix;
const otherOrganizationId = 'sec624_b_' + suffix;
const accepted = { providerMessageId: 'synthetic-accepted', acceptedByProvider: true };
type Entry = import('@/lib/pharmacy/whatsapp/message-log').MessageLogEntry;
let log: typeof import('@/lib/pharmacy/whatsapp/message-log');
let scoped: typeof import('@/lib/tenancy/scoped-db');
let disconnect: (() => Promise<void>) | undefined;
let seeded = false;

function entry(dedupeKey = 'out:' + randomUUID()): Entry {
  return { organizationId, kind: 'ORDER_CONFIRMATION', dedupeKey };
}
async function reserve(value: Entry) {
  const id = await log.claimMessageLog({ ...value, direction: 'OUTBOUND', status: 'PENDING' });
  expect(id).not.toBeNull();
  return id!;
}
async function row(value: Entry) {
  return scoped.withTenantDb(value.organizationId, (tx) =>
    tx.pharmacyMessageLog.findFirst({
      where: { organizationId: value.organizationId, dedupeKey: value.dedupeKey },
    })
  );
}

// Timers do not arrange any interleaving: all races use explicit rendezvous or
// provider-entry/release barriers, and all authority changes are real DB writes.
describeDatabase('SEC-624 exclusive send authority on PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url!).hostname)) {
      throw new Error('SEC-624 suite requires a local disposable database');
    }
    process.env.DATABASE_URL = url;
    scoped = await import('@/lib/tenancy/scoped-db');
    log = await import('@/lib/pharmacy/whatsapp/message-log');
    const { db } = await import('@/lib/db');
    disconnect = () => db.$disconnect();
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb(async (tx) => {
      const flags = await tx.$queryRawUnsafe<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(
        'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = CAST($1 AS regclass)',
        'public.pharmacy_message_logs'
      );
      expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await tx.organization.createMany({
        data: [organizationId, otherOrganizationId].map((id) => ({
          id,
          slug: id,
          legalName: 'SEC-624 synthetic fixture',
          displayName: 'SEC-624 synthetic fixture',
          status: 'ACTIVE' as const,
        })),
      });
    });
    seeded = true;
  });

  beforeEach(() => {
    hooks.beforeAuthority = undefined;
    hooks.failOutcomeWrite = false;
  });
  afterAll(async () => {
    hooks.beforeAuthority = undefined;
    hooks.failOutcomeWrite = false;
    try {
      if (seeded)
        await scoped.withPlatformDb(async (tx) => {
          await tx.pharmacyMessageLog.deleteMany({
            where: { organizationId: { in: [organizationId, otherOrganizationId] } },
          });
          await tx.organization.deleteMany({
            where: { id: { in: [organizationId, otherOrganizationId] } },
          });
        });
    } finally {
      await disconnect?.();
    }
  });

  it('gives only one of two concurrent retries authority for a committed reservation', async () => {
    const value = entry();
    const id = await reserve(value);
    hooks.beforeAuthority = rendezvous(2);
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return accepted;
    });
    const attempts = [
      log.sendClaimedMessage(value, id, send),
      log.sendClaimedMessage(value, id, send),
    ];
    await entered.promise;
    try {
      // The winner is still blocked inside the provider. The loser must finish
      // DUPLICATE before release, not merely after the winner records SENT.
      expect(await Promise.race(attempts)).toBe('DUPLICATE');
      expect(send).toHaveBeenCalledTimes(1);
      expect(await row(value)).toMatchObject({
        id,
        organizationId,
        direction: 'OUTBOUND',
        dedupeKey: value.dedupeKey,
        status: 'PENDING',
        error: 'UNKNOWN_PROVIDER_OUTCOME',
        providerMessageId: null,
      });
    } finally {
      release.resolve();
    }
    expect((await Promise.all(attempts)).sort()).toEqual(['DUPLICATE', 'SENT']);
    const delivered = {
      id,
      organizationId,
      direction: 'OUTBOUND',
      dedupeKey: value.dedupeKey,
      status: 'SENT',
      error: null,
      providerMessageId: accepted.providerMessageId,
    };
    expect(await row(value)).toMatchObject(delivered);
    // Replay the same committed reservation and the original entry point.
    expect(await log.sendClaimedMessage(value, id, send)).toBe('DUPLICATE');
    expect(await log.sendAndLog(value, send)).toBe('DUPLICATE');
    expect(send).toHaveBeenCalledTimes(1);
    expect(await row(value)).toMatchObject(delivered);
  });

  it('uses the same DB gate for an original sender and retry racing before the provider call', async () => {
    const value = entry();
    const originalAtGate = deferred();
    const bothAtGate = rendezvous(2);
    hooks.beforeAuthority = async () => {
      originalAtGate.resolve();
      await bothAtGate();
    };
    const send = vi.fn(async () => accepted);
    const original = log.sendAndLog(value, send);
    await originalAtGate.promise;
    const pending = await row(value);
    expect(pending).toMatchObject({ error: 'SEND_RESERVED' });
    const retry = log.sendClaimedMessage(value, pending!.id, send);
    expect((await Promise.all([original, retry])).sort()).toEqual(['DUPLICATE', 'SENT']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('suppresses retries during an original provider call and after SENT', async () => {
    const value = entry();
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return accepted;
    });
    const original = log.sendAndLog(value, send);
    await entered.promise;
    const pending = await row(value);
    try {
      expect(await log.sendClaimedMessage(value, pending!.id, send)).toBe('DUPLICATE');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect(await original).toBe('SENT');
    const delivered = {
      id: pending!.id,
      organizationId,
      direction: 'OUTBOUND',
      dedupeKey: value.dedupeKey,
      status: 'SENT',
      error: null,
      providerMessageId: accepted.providerMessageId,
    };
    // Read in a fresh transaction after the original send has completed.
    expect(await row(value)).toMatchObject(delivered);
    expect(await log.sendClaimedMessage(value, pending!.id, send)).toBe('DUPLICATE');
    expect(await log.sendAndLog(value, send)).toBe('DUPLICATE');
    expect(send).toHaveBeenCalledTimes(1);
    expect(await row(value)).toMatchObject(delivered);
  });

  it('isolates identical keys across tenants and rejects a foreign log ID', async () => {
    const value = entry();
    const other = { ...value, organizationId: otherOrganizationId };
    const firstId = await reserve(value);
    const secondId = await reserve(other);
    const forbiddenSend = vi.fn();
    expect(await log.sendClaimedMessage(value, secondId, forbiddenSend)).toBe('DUPLICATE');
    expect(forbiddenSend).not.toHaveBeenCalled();
    const bothEntered = rendezvous(2);
    const send = vi.fn(async () => {
      await bothEntered();
      return accepted;
    });
    expect(
      await Promise.all([
        log.sendClaimedMessage(value, firstId, send),
        log.sendClaimedMessage(other, secondId, send),
      ])
    ).toEqual(['SENT', 'SENT']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    new WhatsAppProviderError('NOT_CONFIGURED'),
    new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED'),
    new WhatsAppProviderError('SEND_FAILED', 'HTTP 429', true),
  ])('allows one competing retry only after a definitive failure (%s)', async (error) => {
    const value = entry();
    expect(
      await log.sendAndLog(value, async () => {
        throw error;
      })
    ).toBe('FAILED');
    const failed = await row(value);
    expect(failed).toMatchObject({ status: 'FAILED', error: error.reason });
    hooks.beforeAuthority = rendezvous(2);
    const send = vi.fn(async () => accepted);
    expect(
      (
        await Promise.all([
          log.sendClaimedMessage(value, failed!.id, send),
          log.sendClaimedMessage(value, failed!.id, send),
        ])
      ).sort()
    ).toEqual(['DUPLICATE', 'SENT']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('transport interrupted'),
    new WhatsAppProviderError('SEND_FAILED', 'HTTP 503'),
  ])('leaves ambiguous failures non-retryable (%s)', async (error) => {
    const value = entry();
    expect(
      await log.sendAndLog(value, async () => {
        throw error;
      })
    ).toBe('UNKNOWN');
    const pending = await row(value);
    expect(pending).toMatchObject({ status: 'PENDING', error: 'UNKNOWN_PROVIDER_OUTCOME' });
    const send = vi.fn();
    expect(await log.sendClaimedMessage(value, pending!.id, send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['PENDING', null],
    ['FAILED', null],
    ['FAILED', 'UNKNOWN_PROVIDER_OUTCOME'],
    ['IGNORED', 'MOCK_PREPARED'],
  ] as const)('does not treat unproven legacy %s / %s as send authority', async (status, error) => {
    const value = entry();
    const prior = await scoped.withTenantDb(organizationId, (tx) =>
      tx.pharmacyMessageLog.create({
        data: {
          ...value,
          direction: 'OUTBOUND',
          status,
          error,
        },
      })
    );
    const send = vi.fn();
    expect(await log.sendClaimedMessage(value, prior.id, send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not redeliver after provider acceptance when the subsequent log transaction fails', async () => {
    const value = entry();
    const send = vi.fn(async () => accepted);
    hooks.failOutcomeWrite = true;
    await expect(log.sendAndLog(value, send)).rejects.toThrow('injected outcome write failure');
    hooks.failOutcomeWrite = false;
    const pending = await row(value);
    expect(pending).toMatchObject({ status: 'PENDING', error: 'UNKNOWN_PROVIDER_OUTCOME' });
    expect(await log.sendClaimedMessage(value, pending!.id, send)).toBe('DUPLICATE');
    expect(await log.sendAndLog(value, send)).toBe('DUPLICATE');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps inbound and outbound claims in their existing caller-owned transaction', async () => {
    const value = entry();
    const inboundKey = 'in:' + randomUUID();
    await expect(
      scoped.withTenantDb(organizationId, async (tx) => {
        await log.claimMessageLogInTransaction(tx, {
          ...value,
          dedupeKey: inboundKey,
          direction: 'INBOUND',
          kind: 'ORDER_REQUEST',
          status: 'RECEIVED',
        });
        await log.claimMessageLogInTransaction(tx, {
          ...value,
          direction: 'OUTBOUND',
          status: 'PENDING',
        });
        throw new Error('synthetic order transaction rollback');
      })
    ).rejects.toThrow('synthetic order transaction rollback');
    expect(await row(value)).toBeNull();
    expect(await row({ ...value, dedupeKey: inboundKey })).toBeNull();
    expect(await log.sendAndLog(value, async () => accepted)).toBe('SENT');
  });
});
