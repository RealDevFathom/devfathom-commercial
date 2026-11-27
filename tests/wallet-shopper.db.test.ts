import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
vi.mock('@/lib/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/entitlements')>()),
  resolveOrganizationEntitlements: async (organizationId: string) => ({
    organizationId,
    vertical: 'PHARMACY',
    enabledModules: ['pharmacy-crm'],
    limits: {},
  }),
}));
const runtime = process.env.M8_TEST_RUNTIME_DATABASE_URL,
  ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;

it.skipIf(!runtime || !ownerUrl)(
  'verifies a branch phone challenge once and projects sale, refund and adjustment through the shared wallet outbox',
  async () => {
    assertDisposableRlsDatabase(runtime!);
    assertDisposableRlsDatabase(ownerUrl!);
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { branchPoster } = await import('@/lib/wallet/poster');
    const { startEnrollment, verifyEnrollment } = await import('@/lib/wallet/enrollment');
    const { deliverWalletUpdates } = await import('@/lib/wallet/balance-updates');
    const id = randomUUID(),
      owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,'Fixture','Fixture','PHARMACY','ACTIVE','SHARED',now(),now())`,
        [id]
      );
    } finally {
      await owner.end();
    }
    vi.stubEnv('AUTH_SECRET', randomUUID());
    try {
      const token = await withTenantDb(id, async (db) => {
        const [role] = await db.$queryRaw<
          { rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
        await db.pharmacyBranch.create({
          data: {
            id,
            code: 'N',
            name: 'North',
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
          },
        });
        await db.walletTenantConfig.create({
          data: {
            enabled: true,
            programDisplayName: 'Synthetic rewards',
            googleClassSuffix: (await import('@/lib/wallet/alias'))
              .mintWalletAlias()
              .replace('wla_', 'wgc_'),
          },
        });
        return (await branchPoster(db, id, true, id)).split('/').at(-1)!;
      });
      let otp = '';
      const phone = '+923000000001';
      const start = await startEnrollment({
        organizationId: id,
        token,
        phone,
        sendOtp: async (data) => {
          otp = data.otp;
        },
      });
      expect(start?.id).toBeTruthy();
      expect(otp).toMatch(/^\d{6}$/);
      const verify = { organizationId: id, token, attemptId: start!.id, otp, consent: true };
      expect(await verifyEnrollment({ ...verify, organizationId: randomUUID() })).toBeNull();
      const joined = await verifyEnrollment(verify);
      expect(joined?.passes).toHaveLength(2);
      const { issueVerifiedWallet } = await import('@/lib/wallet/issue');
      vi.stubEnv('WALLET_MODE', 'TEST');
      const files = await issueVerifiedWallet(id, joined!);
      expect(files.mode).toBe('TEST');
      expect(files.google).toHaveProperty('barcode.value', joined!.alias);
      expect(await verifyEnrollment(verify)).toBeNull();
      const send = vi.fn().mockResolvedValue(undefined);
      await withTenantDb(id, async (db) => {
        const card = await db.pharmacyLoyaltyCard.findFirstOrThrow();
        await db.pharmacySale.create({
          data: { id, branchId: id, createdByUserId: 'owner', customerId: card.customerId },
        });
        const drawer = await db.pharmacyDrawerSession.create({
          data: {
            branchId: id,
            deviceId: 'fixture',
            openingFloatMinor: 0,
            openedByActorId: 'owner',
            businessDate: new Date(),
          },
        });
        const tender = await db.pharmacyTender.create({
          data: {
            branchId: id,
            saleId: id,
            type: 'CASH',
            drawerSessionId: drawer.id,
            amountMinor: 1000,
            cashReceivedMinor: 1000,
            changeGivenMinor: 0,
            businessDate: new Date(),
            actorId: 'owner',
            deviceId: 'fixture',
          },
        });
        const base = { branchId: id, customerId: card.customerId, actorId: 'owner' };
        await db.pharmacyLoyaltyPointsEntry.create({
          data: {
            ...base,
            kind: 'EARN',
            saleId: id,
            points: 10,
            netPaidMinor: 1000,
            idempotencyKey: 'earn',
          },
        });
        const delivery = { apple: send, google: send };
        async function balance(n: number) {
          send.mockClear();
          expect((await deliverWalletUpdates(db, delivery)).sent).toBe(2);
          expect(send.mock.calls.map(([v]) => v.balance)).toEqual([n, n]);
        }
        await balance(10);
        const refund = await db.pharmacyRefund.create({
          data: {
            branchId: id,
            saleId: id,
            originalTenderId: tender.id,
            drawerSessionId: drawer.id,
            amountMinor: 400,
            businessDate: new Date(),
            reason: 'Fixture return',
            actorId: 'owner',
          },
        });
        await db.pharmacyLoyaltyPointsEntry.create({
          data: {
            ...base,
            kind: 'EARN_REVERSAL',
            saleId: id,
            points: -4,
            netPaidMinor: 400,
            tenderId: tender.id,
            refundId: refund.id,
            idempotencyKey: 'refund',
          },
        });
        await balance(6);
        await db.pharmacyLoyaltyPointsEntry.create({
          data: {
            ...base,
            kind: 'ADJUSTMENT',
            points: 3,
            reason: 'Fixture adjustment',
            idempotencyKey: 'adjust',
          },
        });
        await balance(9);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
