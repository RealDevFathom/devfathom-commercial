// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { enforceOperatingMode, type PharmacyApprovalKind } from './operating-mode';
import { authorizeSoloApproval } from './solo-approval';
const suffix = randomUUID();
const pin = '583917';
const solo = {
  organizationId: `solo-mode-${suffix}`,
  branchId: `solo-branch-${suffix}`,
  actorId: `solo-owner-${suffix}`,
};
const staffed = {
  organizationId: `staffed-mode-${suffix}`,
  branchId: `staffed-branch-${suffix}`,
  actorId: `staffed-owner-${suffix}`,
};
const roles = (org: string, key: string) => `${org}-${key}`;
beforeAll(async () => {
  // Without PostgreSQL every test below is skipped; there is nothing to seed.
  if (!process.env.DATABASE_URL) return;
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
  for (const [scope, mode] of [
    [solo, 'SOLO'],
    [staffed, 'STAFFED'],
  ] as const) {
    await withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: scope.organizationId,
          slug: scope.organizationId,
          legalName: 'Operating mode regression',
          displayName: 'Operating mode regression',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          pharmacyOperatingMode: mode,
        },
      })
    );
    await withTenantDb(
      scope.organizationId,
      async (db) => {
        await db.organizationDepartment.create({ data: { key: 'pharmacy', name: 'Pharmacy' } });
        for (const key of mode === 'SOLO'
          ? ['owner']
          : ['owner', 'manager', 'pharmacist', 'cashier']) {
          const role = await db.organizationRole.create({
            data: { key, name: key, isSystem: true },
          });
          for (const capability of key === 'cashier'
            ? ['pharmacy:counter']
            : [
                'pharmacy:counter',
                'pharmacy:inventory',
                'pharmacy:procurement',
                ...(key === 'pharmacist' || mode === 'SOLO' ? ['pharmacy:dispense'] : []),
              ])
            await db.organizationRolePermission.create({
              data: { organizationRoleId: role.id, capability },
            });
          const actorId = key === 'owner' ? scope.actorId : roles(scope.organizationId, key);
          await db.user.create({
            data: {
              id: actorId,
              organizationRoleId: role.id,
              name: key,
              email: `${actorId}@example.invalid`,
              department: 'pharmacy',
              title: key,
            },
          });
          if (key === 'owner') {
            const profile = await db.restaurantStaffProfile.create({
              data: { userId: actorId, displayName: key },
            });
            await db.restaurantOperatorCredential.create({
              data: { staffProfileId: profile.id, type: 'PIN', credentialHash: await hash(pin, 4) },
            });
          }
        }
        await db.pharmacyBranch.create({
          data: {
            id: scope.branchId,
            code: 'MAIN',
            name: 'Main',
            addressLine: 'Synthetic test',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        if (mode === 'STAFFED')
          await db.pharmacyBranchAssignment.createMany({
            data: ['manager', 'pharmacist', 'cashier'].map((key) => ({
              userId: roles(scope.organizationId, key),
              branchId: scope.branchId,
            })),
          });
      },
      { skipDrain: true }
    );
  }
}, 30000);
const kinds: PharmacyApprovalKind[] = [
  'RX',
  'OVERRIDE',
  'REFUND',
  'RETURN',
  'DISCOUNT',
  'ADJUSTMENT',
  'PURCHASE',
];
// Skips like the other database suites when no PostgreSQL is configured.
describe.skipIf(!process.env.DATABASE_URL)('pharmacy operating mode (PostgreSQL)', () => {
  describe.each(kinds)('%s real PIN and audit policy', (kind) => {
    const targetId = `${kind}-${suffix}`;
    it.each(['user', 'role'])(
      'rejects an explicit %s DENY even with the correct SOLO PIN',
      async (source) => {
        const deniedTarget = `denied-${source}-${targetId}`;
        const capability =
          kind === 'RX'
            ? 'pharmacy:dispense'
            : kind === 'PURCHASE'
              ? 'pharmacy:procurement'
              : kind === 'ADJUSTMENT'
                ? 'pharmacy:inventory'
                : 'pharmacy:counter';
        await expect(
          withTenantDb(
            solo.organizationId,
            async (db) => {
              if (source === 'user') {
                await db.userPermissionOverride.create({
                  data: {
                    userId: solo.actorId,
                    capability,
                    effect: 'DENY',
                    reason: 'Approval regression',
                  },
                });
              } else {
                const owner = await db.user.findUniqueOrThrow({ where: { id: solo.actorId } });
                await db.organizationRolePermission.update({
                  where: {
                    organizationRoleId_capability: {
                      organizationRoleId: owner.organizationRoleId!,
                      capability,
                    },
                  },
                  data: { effect: 'DENY' },
                });
              }
              await enforceOperatingMode(db, solo, {
                kind,
                makerIds: [solo.actorId],
                targetType: 'PolicyRegression',
                targetId: deniedTarget,
                pin,
              });
            },
            { skipDrain: true }
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await withTenantDb(
          solo.organizationId,
          async (db) => {
            expect(await db.auditLog.count({ where: { targetId: deniedTarget } })).toBe(0);
          },
          { skipDrain: true }
        );
      }
    );
    it('denies SOLO without PIN, allows verified owner, and retains secret-free evidence', async () => {
      const input = { kind, makerIds: [solo.actorId], targetType: 'PolicyRegression', targetId };
      await expect(
        withTenantDb(solo.organizationId, (db) => enforceOperatingMode(db, solo, input), {
          skipDrain: true,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await withTenantDb(
        solo.organizationId,
        async (db) => {
          expect(await db.auditLog.count({ where: { targetId } })).toBe(0);
          await expect(enforceOperatingMode(db, solo, { ...input, pin })).resolves.toHaveProperty(
            'policy',
            'PHARMACY:SOLO_OWNER_PIN'
          );
          const audit = await db.auditLog.findFirstOrThrow({ where: { targetId } });
          expect(audit.metadata).toMatchObject({
            operatingMode: 'SOLO',
            reauthentication: 'PIN',
            branchId: solo.branchId,
          });
          expect(JSON.stringify(audit)).not.toContain(pin);
        },
        { skipDrain: true }
      );
    });
    it('denies STAFFED owner self approval even with correct PIN; accepts qualified independent checker', async () => {
      const input = { kind, makerIds: [staffed.actorId], targetType: 'PolicyRegression', targetId };
      await expect(
        withTenantDb(
          staffed.organizationId,
          (db) => enforceOperatingMode(db, staffed, { ...input, pin }),
          { skipDrain: true }
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const checker = roles(staffed.organizationId, kind === 'RX' ? 'pharmacist' : 'manager');
      await withTenantDb(
        staffed.organizationId,
        (db) => enforceOperatingMode(db, { ...staffed, actorId: checker }, input),
        { skipDrain: true }
      );
      await expect(
        withTenantDb(
          staffed.organizationId,
          (db) =>
            enforceOperatingMode(
              db,
              { ...staffed, actorId: roles(staffed.organizationId, 'cashier') },
              input
            ),
          { skipDrain: true }
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
  it('STAFFED refuses both the #683 self-approval API and direct forged SOLO audit evidence', async () => {
    await withTenantDb(
      staffed.organizationId,
      async (db) => {
        expect(
          await authorizeSoloApproval(db, staffed, { type: 'PolicyRegression', id: 'forged' }, pin)
        ).toBe(false);
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        staffed.organizationId,
        (db) =>
          db.auditLog.create({
            data: {
              actorId: staffed.actorId,
              source: 'TRPC',
              category: 'PHARMACY',
              action: 'PHARMACY:SOLO_OWNER_PIN',
              targetType: 'PolicyRegression',
              targetId: 'forged',
              metadata: { reauthentication: 'PIN' },
            },
          }),
        { skipDrain: true }
      )
    ).rejects.toThrow(/SOLO operating mode/);
  });

  it('rolls back SOLO evidence if its transaction changes to STAFFED before committing', async () => {
    const targetId = `mode-race-${suffix}`;
    await expect(
      withTenantDb(
        solo.organizationId,
        async (db) => {
          expect(
            await authorizeSoloApproval(db, solo, { type: 'PolicyRegression', id: targetId }, pin)
          ).toBe(true);
          await db.organization.update({
            where: { id: solo.organizationId },
            data: { pharmacyOperatingMode: 'STAFFED' },
          });
        },
        { skipDrain: true }
      )
    ).rejects.toThrow(/SOLO operating mode/);
    await withTenantDb(
      solo.organizationId,
      async (db) => {
        expect(await db.auditLog.count({ where: { targetId } })).toBe(0);
        expect(
          (await db.organization.findUniqueOrThrow({ where: { id: solo.organizationId } }))
            .pharmacyOperatingMode
        ).toBe('SOLO');
      },
      { skipDrain: true }
    );
  });
});
