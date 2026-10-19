import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrintJob, PrintRoutingConfig } from './contract';
import { acknowledgePrintJob, claimNextPrintJob, PrintBridgeService } from './service';
import { SimulatedPrintBridgeAdapter } from './stub';
import { writeToPrinter } from '../../../../scripts/print-bridge';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgA = `org_print_a_${suffix}`;
const orgB = `org_print_b_${suffix}`;
const branchA = `branch_print_a_${suffix}`;
const branchB = `branch_print_b_${suffix}`;
const bridgeA = `bridge_print_a_${suffix}`;
const printerA = `printer_print_a_${suffix}`;
const bridgeB = `bridge_print_b_${suffix}`;

let tenancy: typeof import('@/lib/tenancy/scoped-db');

const config: PrintRoutingConfig = {
  branchId: branchA,
  routes: [{ documentType: 'BAR_TICKET', stationId: null, printerId: printerA, enabled: true }],
};
const job: PrintJob = {
  branchId: branchA,
  stationId: null,
  idempotencyKey: `print-replay-${suffix}`,
  document: {
    type: 'BAR_TICKET',
    reference: 'KOT 42',
    title: 'BAR',
    createdAt: '2026-08-29T08:00:00.000Z',
    lines: [{ quantity: 1, label: 'Soda' }],
  },
};

describeIfDatabase('durable print bridge', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb(async (db) => {
      await db.organization.createMany({
        data: [
          { id: orgA, slug: orgA, legalName: orgA, displayName: orgA },
          { id: orgB, slug: orgB, legalName: orgB, displayName: orgB },
        ],
      });
    });
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantBranch.create({ data: { id: branchA, organizationId: orgA, name: 'A' } })
    );
    await tenancy.withTenantDb(orgA, async (db) => {
      await db.restaurantRegisteredDevice.create({
        data: {
          id: bridgeA,
          organizationId: orgA,
          branchId: branchA,
          name: 'Bridge A',
          kind: 'PRINT_BRIDGE',
          deviceSecretHash: `hash_${suffix}`,
        },
      });
      await db.restaurantRegisteredDevice.create({
        data: {
          id: bridgeB,
          organizationId: orgA,
          branchId: branchA,
          name: 'Bridge B',
          kind: 'PRINT_BRIDGE',
          deviceSecretHash: `hash_b_${suffix}`,
        },
      });
      await db.restaurantPrinter.create({
        data: {
          id: printerA,
          organizationId: orgA,
          branchId: branchA,
          bridgeId: bridgeA,
          name: 'Printer A',
          connectionKind: 'DEVICE_PATH',
          address: '/dev/null',
          paperWidthMm: 80,
        },
      });
    });
    await tenancy.withTenantDb(orgB, (db) =>
      db.restaurantBranch.create({ data: { id: branchB, organizationId: orgB, name: 'B' } })
    );
  });

  afterAll(async () => {
    if (!tenancy) return;
    await tenancy.withPlatformDb((db) =>
      db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    );
  });

  it('persists configuration and RLS hides it across tenants', async () => {
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintRoute.create({
        data: { organizationId: orgA, branchId: branchA, ...config.routes[0] },
      })
    );
    await expect(tenancy.withTenantDb(orgA, (db) => db.restaurantPrintRoute.count())).resolves.toBe(
      1
    );
    await expect(tenancy.withTenantDb(orgB, (db) => db.restaurantPrintRoute.count())).resolves.toBe(
      0
    );
  });

  it('expires enrollment codes and consumes a valid code once', async () => {
    const { issuePrintBridgeEnrollmentCode, exchangePrintBridgeEnrollmentCode } =
      await import('../print-bridge-enrollment');
    const issuedAt = new Date('2026-09-02T10:00:00.000Z');
    const expired = await tenancy.withTenantDb(orgA, (db) =>
      issuePrintBridgeEnrollmentCode(db, bridgeA, issuedAt)
    );
    await expect(
      exchangePrintBridgeEnrollmentCode(expired.code, new Date('2026-09-02T10:11:00.000Z'))
    ).resolves.toBeNull();
    const valid = await tenancy.withTenantDb(orgA, (db) =>
      issuePrintBridgeEnrollmentCode(db, bridgeA, issuedAt)
    );
    const exchanged = await exchangePrintBridgeEnrollmentCode(
      valid.code,
      new Date('2026-09-02T10:01:00.000Z')
    );
    expect(exchanged?.token).toMatch(/^rdk_/);
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        db.restaurantRegisteredDevice.findUniqueOrThrow({ where: { id: bridgeA } })
      )
    ).resolves.toMatchObject({ lastSeenAt: new Date('2026-09-02T10:01:00.000Z') });
    await expect(
      exchangePrintBridgeEnrollmentCode(valid.code, new Date('2026-09-02T10:02:00.000Z'))
    ).resolves.toBeNull();
  });

  it('records bridge-routed printer OFFLINE status and error text', async () => {
    const offlineJob = { ...job, idempotencyKey: `bridge-offline-${suffix}` };
    await tenancy.withTenantDb(orgA, (db) =>
      new PrintBridgeService(db).enqueue(orgA, config, offlineJob)
    );
    const claimed = await tenancy.withTenantDb(orgA, (db) => claimNextPrintJob(db, bridgeA));
    expect(claimed).not.toBeNull();
    await tenancy.withTenantDb(orgA, (db) =>
      acknowledgePrintJob(db, {
        bridgeId: bridgeA,
        jobId: claimed!.id,
        status: 'OFFLINE',
        error: 'ECONNREFUSED',
      })
    );
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        db.restaurantPrinter.findUniqueOrThrow({ where: { id: printerA } })
      )
    ).resolves.toMatchObject({ status: 'OFFLINE', lastError: 'ECONNREFUSED' });
  });

  it('survives service restart and concurrent replay without duplicate delivery', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const submit = () =>
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, job)
      );
    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(adapter.deliveries).toHaveLength(1);
    await expect(submit()).resolves.toMatchObject({ status: 'PRINTED', replayed: true });
    expect(adapter.deliveries).toHaveLength(1);
  });

  it('persists offline retry state and prints once after recovery', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const retryJob = { ...job, idempotencyKey: `offline-retry-${suffix}` };
    adapter.setOffline(printerA, true);
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, retryJob)
      )
    ).resolves.toMatchObject({ status: 'OFFLINE' });
    adapter.setOffline(printerA, false);
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, retryJob)
      )
    ).resolves.toMatchObject({ status: 'PRINTED', replayed: false });
    expect(adapter.deliveries).toHaveLength(1);
    const stored = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintJob.findUniqueOrThrow({
        where: {
          organizationId_branchId_idempotencyKey: {
            organizationId: orgA,
            branchId: branchA,
            idempotencyKey: retryJob.idempotencyKey,
          },
        },
      })
    );
    expect(stored).toMatchObject({ status: 'PRINTED', attemptCount: 2 });
  });

  it('claims a durable job, writes ESC/POS to a fake TCP printer, and acknowledges it', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake printer did not bind TCP.');
    const received = new Promise<Buffer>((resolve) => {
      server.once('connection', (socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });
    try {
      const tcpConfig: PrintRoutingConfig = {
        branchId: branchA,
        routes: [
          {
            documentType: 'BAR_TICKET',
            stationId: null,
            printerId: printerA,
            enabled: true,
          },
        ],
      };
      const tcpJob = { ...job, idempotencyKey: `fake-tcp-${suffix}` };
      await tenancy.withTenantDb(orgA, (db) =>
        db.restaurantPrinter.update({
          where: { id: printerA },
          data: { connectionKind: 'TCP', address: `tcp://127.0.0.1:${address.port}` },
        })
      );
      await tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(db).enqueue(orgA, tcpConfig, tcpJob)
      );
      const claimed = await tenancy.withTenantDb(orgA, (db) => claimNextPrintJob(db, bridgeA));
      expect(claimed).not.toBeNull();
      await expect(
        tenancy.withTenantDb(orgA, (db) => claimNextPrintJob(db, bridgeB))
      ).resolves.toBeNull();
      await writeToPrinter(claimed!.address, Buffer.from(claimed!.bytes, 'base64'));
      expect((await received).includes(Buffer.from('Soda'))).toBe(true);
      await expect(
        tenancy.withTenantDb(orgA, (db) =>
          acknowledgePrintJob(db, { bridgeId: bridgeA, jobId: claimed!.id, status: 'PRINTED' })
        )
      ).resolves.toEqual({ acknowledged: true, replayed: false });
      await expect(
        tenancy.withTenantDb(orgA, (db) =>
          db.restaurantPrintJob.findUniqueOrThrow({ where: { id: claimed!.id } })
        )
      ).resolves.toMatchObject({ status: 'PRINTED', attemptCount: 1 });
      await expect(
        tenancy.withTenantDb(orgA, (db) =>
          db.restaurantPrinter.findUniqueOrThrow({ where: { id: printerA } })
        )
      ).resolves.toMatchObject({ status: 'ONLINE', lastError: null });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
