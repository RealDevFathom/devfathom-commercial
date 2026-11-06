/** Requires a disposable, seeded pharmacy E2E database and a restricted runtime role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PHARMACY_E2E as fixture } from '../../../tests/e2e/pharmacy-counter-fixture';

vi.mock('server-only', () => ({}));
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const enabled = Boolean(url && process.env.PHARMACY_E2E === '1');
const scanId = `immutable_${randomUUID()}`;
const tenant = fixture.organizationId;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let acknowledge: typeof import('./pack-authentication-operations').acknowledgePackAuthenticationFlag;
const act = <T>(
  f: (db: import('@/lib/tenancy/scoped-db').ScopedDb) => Promise<T>,
  org: string = tenant
) => withTenantDb(org, f, { userId: fixture.adminId });

describe.skipIf(!enabled)('pack scan evidence restricted database', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname.includes('e2e') ||
      parsed.port === '5432'
    )
      throw new Error('Disposable pharmacy E2E database required');
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ acknowledgePackAuthenticationFlag: acknowledge } =
      await import('./pack-authentication-operations'));
    await act(async (db) => {
      const [role] = await db.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.pharmacyPackAuthenticationScan.create({
        data: {
          id: scanId,
          organizationId: tenant,
          branchId: fixture.branchId,
          source: 'DISPENSING',
          status: 'FLAGGED',
          gtin: '08901234567890',
          batchNumber: 'SYNTHETIC',
          expiresOn: '251231',
          serial: 'synthetic-serial',
          medicineId: fixture.medicines.otc.id,
          issues: ['EXPIRY_MISMATCH'],
          explanation: 'Synthetic mismatch',
          advisory: false,
          scannedByUserId: fixture.adminId,
        },
      });
    });
  });
  it.each([
    ['status', { status: 'NOT_VERIFIABLE' }],
    ['advisory', { advisory: true }],
    ['issue', { issues: [] }],
    ['identity', { serial: 'other-serial' }],
    ['branch', { branchId: 'other-branch' }],
    ['medicine', { medicineId: null }],
    ['expiry', { expiresOn: '261231' }],
  ])('refuses evidence tampering: %s', async (_label, data) => {
    await expect(
      act((db) =>
        db.pharmacyPackAuthenticationScan.update({ where: { id: scanId }, data: data as never })
      )
    ).rejects.toThrow();
  });
  it('does not expose or acknowledge evidence through another branch scope', async () => {
    const otherBranch = 'synthetic_other_branch';
    const result = await act(async (db) => {
      await db.$queryRaw`SELECT set_config('app.current_branch_id', ${otherBranch}, true)`;
      return db.pharmacyPackAuthenticationScan.findFirst({ where: { id: scanId } });
    });
    expect(result).toBeNull();
    await expect(
      act((db) =>
        acknowledge(db, {
          organizationId: tenant,
          branchId: otherBranch,
          scanId,
          actorId: fixture.adminId,
          reason: 'Synthetic review',
        })
      )
    ).rejects.toThrow();
  });
  it('does not permit verdict replacement racing acknowledgement', async () => {
    const raceId = `scan_race_${randomUUID()}`;
    await act((db) =>
      db.pharmacyPackAuthenticationScan.create({
        data: {
          id: raceId,
          organizationId: tenant,
          branchId: fixture.branchId,
          source: 'DISPENSING',
          status: 'FLAGGED',
          gtin: '08901234567890',
          issues: ['EXPIRY_MISMATCH'],
          explanation: 'Synthetic mismatch',
          advisory: false,
          scannedByUserId: fixture.adminId,
        },
      })
    );
    let release!: () => void;
    let locked!: () => void;
    const entered = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acknowledgement = act(async (db) => {
      await acknowledge(db, {
        organizationId: tenant,
        branchId: fixture.branchId,
        scanId: raceId,
        actorId: fixture.adminId,
        reason: 'Synthetic review',
      });
      locked();
      await gate;
    });
    await entered;
    let completed = false;
    const tamper = act((db) =>
      db.pharmacyPackAuthenticationScan.update({ where: { id: raceId }, data: { advisory: true } })
    ).then(
      () => {
        completed = true;
        return null;
      },
      (error: unknown) => {
        completed = true;
        return error;
      }
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
    } finally {
      release();
    }
    await acknowledgement;
    expect(await tamper).toBeInstanceOf(Error);
    expect(
      await act((db) =>
        db.pharmacyPackAuthenticationScan.findFirstOrThrow({ where: { id: raceId } })
      )
    ).toMatchObject({
      advisory: false,
      status: 'FLAGGED',
      acknowledgementReason: 'Synthetic review',
    });
  });
  it('preserves tenant isolation and permits one immutable acknowledgement', async () => {
    expect(
      await act(
        (db) => db.pharmacyPackAuthenticationScan.findFirst({ where: { id: scanId } }),
        'other_synthetic_tenant'
      )
    ).toBeNull();
    await act((db) =>
      acknowledge(db, {
        organizationId: tenant,
        branchId: fixture.branchId,
        scanId,
        actorId: fixture.adminId,
        reason: 'Synthetic review',
      })
    );
    const scan = await act((db) =>
      db.pharmacyPackAuthenticationScan.findFirstOrThrow({ where: { id: scanId } })
    );
    expect(scan).toMatchObject({
      status: 'FLAGGED',
      advisory: false,
      issues: ['EXPIRY_MISMATCH'],
      acknowledgementReason: 'Synthetic review',
    });
    await expect(
      act((db) =>
        db.pharmacyPackAuthenticationScan.update({
          where: { id: scanId },
          data: { acknowledgementReason: 'Changed later' },
        })
      )
    ).rejects.toThrow();
    await expect(
      act((db) => db.pharmacyPackAuthenticationScan.delete({ where: { id: scanId } }))
    ).rejects.toThrow();
  });
});
