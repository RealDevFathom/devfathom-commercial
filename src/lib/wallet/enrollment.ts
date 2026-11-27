import 'server-only';

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { normalizeCustomerIdentifier } from '@/lib/restaurant/customers';
import { mintWalletAlias } from './alias';
import { loyaltyBalance } from '@/lib/restaurant/loyalty';
import { joinPharmacyWallet } from './pharmacy-enrollment';
import { ensureWalletPasses } from './carriers';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
export const ENROLLMENT_TOKEN_PATTERN = /^wel_[0-9a-hjkmnp-tv-z]{26}$/;
const OTP_TTL_MS = 10 * 60_000;

function opaque(prefix: string): string {
  const bits = Array.from(randomBytes(16), (byte) => byte.toString(2).padStart(8, '0'))
    .join('')
    .padStart(130, '0');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5) {
    encoded += CROCKFORD[Number.parseInt(bits.slice(index, index + 5), 2)];
  }
  return `${prefix}${encoded}`;
}

export function hashEnrollmentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintEnrollmentLink(origin: string): {
  token: string;
  tokenHash: string;
  url: string;
} {
  const token = opaque('wel_');
  return {
    token,
    tokenHash: hashEnrollmentToken(token),
    url: new URL(`/wallet/join/${token}`, origin).toString(),
  };
}

function hashOtp(otp: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}.${createHash('sha256').update(`${salt}:${otp}`).digest('hex')}`;
}

function otpMatches(stored: string, otp: string): boolean {
  const [salt, expected] = stored.split('.');
  if (!salt || !expected) return false;
  const actual = createHash('sha256').update(`${salt}:${otp}`).digest();
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

async function licensed(db: ScopedDb, organizationId: string, pharmacy = false) {
  const entitlements = await resolveOrganizationEntitlements(organizationId, db);
  return {
    ok:
      hasModule(entitlements, pharmacy ? 'pharmacy-crm' : 'restaurant-loyalty') &&
      (!pharmacy || entitlements.vertical === 'PHARMACY'),
    activeCustomersMax:
      entitlements.limits['loyalty.activeCustomers.max'] ??
      entitlements.limits['restaurant-core.loyalty.activeCustomers.max'] ??
      0,
  };
}

export async function resolveEnrollmentLink(hostOrganizationId: string, token: string) {
  if (!ENROLLMENT_TOKEN_PATTERN.test(token)) return null;
  return withTenantDb(hostOrganizationId, async (db) => {
    const candidate = await db.walletEnrollmentLink.findUnique({
      where: { tokenHash: hashEnrollmentToken(token) },
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        pharmacyBranchId: true,
        phoneJoin: true,
        active: true,
        revokedAt: true,
        branch: { select: { name: true, active: true } },
        pharmacyBranch: { select: { name: true, active: true } },
      },
    });
    const branch = candidate?.pharmacyBranch ?? candidate?.branch;
    if (
      !candidate ||
      candidate.organizationId !== hostOrganizationId ||
      !candidate.active ||
      candidate.revokedAt ||
      !branch?.active
    )
      return null;
    const access = await licensed(db, hostOrganizationId, !!candidate.pharmacyBranchId);
    if (!access.ok) return null;
    const config = await db.walletTenantConfig.findUnique({
      where: { organizationId: hostOrganizationId },
      select: { programDisplayName: true, enabled: true },
    });
    if (!config?.enabled) return null;
    return { ...candidate, branchName: branch.name, programDisplayName: config.programDisplayName };
  });
}

type StartInput = { organizationId: string; token: string } & (
  | {
      email: string;
      sendOtp: (data: { email: string; otp: string; programName: string }) => Promise<void>;
    }
  | {
      phone: string;
      sendOtp: (data: { phone: string; otp: string; programName: string }) => Promise<void>;
    }
);
export async function startEnrollment(input: StartInput) {
  const link = await resolveEnrollmentLink(input.organizationId, input.token);
  const phone = 'phone' in input;
  if (!link || link.phoneJoin !== phone) return null;
  const kind = phone ? 'PHONE' : 'EMAIL';
  const value = normalizeCustomerIdentifier({ kind, value: phone ? input.phone : input.email });
  const otp = String(randomInt(1_000_000)).padStart(6, '0');
  const attempt = await withTenantDb(input.organizationId, (db) =>
    db.walletEnrollmentAttempt.create({
      data: {
        branchId: link.branchId,
        pharmacyBranchId: link.pharmacyBranchId,
        linkId: link.id,
        identifierKind: kind,
        normalizedValue: value,
        otpHash: hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
      select: { id: true },
    })
  );
  try {
    if (phone) await input.sendOtp({ phone: value, otp, programName: link.programDisplayName });
    else await input.sendOtp({ email: value, otp, programName: link.programDisplayName });
  } catch {
    await withTenantDb(input.organizationId, (db) =>
      db.walletEnrollmentAttempt.deleteMany({ where: { id: attempt.id } })
    );
    return null;
  }
  return attempt;
}

export async function verifyEnrollment(input: {
  organizationId: string;
  token: string;
  attemptId: string;
  otp: string;
  consent?: boolean;
  cardCode?: string;
}) {
  const link = await resolveEnrollmentLink(input.organizationId, input.token);
  if (!link) return null;
  return withTenantDb(input.organizationId, async (db) => {
    // Lock the configuration and attempt through consumption. A concurrent disable or retry
    // cannot race a successful issuance.
    const [allowed] = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM restaurant_wallet_tenant_config WHERE "organizationId"=${input.organizationId} AND enabled FOR SHARE`;
    if (!allowed) return null;
    await db.$queryRaw`SELECT id FROM restaurant_wallet_enrollment_attempts WHERE id=${input.attemptId} FOR UPDATE`;
    const attempt = await db.walletEnrollmentAttempt.findUnique({ where: { id: input.attemptId } });
    if (
      !attempt ||
      attempt.branchId !== link.branchId ||
      attempt.pharmacyBranchId !== link.pharmacyBranchId ||
      (attempt.linkId !== null && attempt.linkId !== link.id) ||
      (link.phoneJoin &&
        (attempt.identifierKind !== 'PHONE' || !input.consent || attempt.linkId !== link.id)) ||
      attempt.consumedAt ||
      attempt.expiresAt <= new Date() ||
      attempt.failedAttempts >= 5
    ) {
      return null;
    }
    if (!otpMatches(attempt.otpHash, input.otp)) {
      await db.walletEnrollmentAttempt.update({
        where: { id: attempt.id },
        data: { failedAttempts: { increment: 1 } },
      });
      return null;
    }
    const access = await licensed(db, input.organizationId, !!link.pharmacyBranchId);
    if (!access.ok) return null;
    return (db.$transaction as unknown as <T>(work: (tx: ScopedDb) => Promise<T>) => Promise<T>)(
      async (tx) => {
        if (link.pharmacyBranchId) {
          const issued = await joinPharmacyWallet(
            tx,
            input.organizationId,
            attempt.normalizedValue,
            input.cardCode
          );
          if (!issued) return null;
          await tx.walletEnrollmentAttempt.delete({ where: { id: attempt.id } });
          return { ...issued, phoneJoin: true };
        }
        if (!link.branchId || attempt.identifierKind === 'WALLET') return null;
        const kind = attempt.identifierKind;
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${input.organizationId} FOR UPDATE`;
        const existingIdentifier = await tx.customerIdentifier.findUnique({
          where: {
            organizationId_kind_normalizedValue: {
              organizationId: input.organizationId,
              kind,
              normalizedValue: attempt.normalizedValue,
            },
          },
          select: { customerId: true },
        });
        const customerId = existingIdentifier
          ? existingIdentifier.customerId
          : (
              await tx.restaurantCustomer.create({
                data: {
                  identifiers: {
                    create: {
                      kind,
                      normalizedValue: attempt.normalizedValue,
                      verifiedAt: new Date(),
                    },
                  },
                },
                select: { id: true },
              })
            ).id;
        if (existingIdentifier) {
          await tx.customerIdentifier.updateMany({
            where: { customerId, kind, normalizedValue: attempt.normalizedValue },
            data: { verifiedAt: new Date() },
          });
        }
        let account = await tx.loyaltyAccount.findUnique({ where: { customerId } });
        if (!account?.active) {
          await tx.$queryRaw`SELECT id FROM organizations WHERE id = current_setting('app.current_organization_id', true) FOR UPDATE`;
          const activeCount = await tx.loyaltyAccount.count({ where: { active: true } });
          if (access.activeCustomersMax <= 0 || activeCount >= access.activeCustomersMax)
            return null;
          account = account
            ? await tx.loyaltyAccount.update({
                where: { id: account.id },
                data: { active: true, enrolledAt: new Date(), deactivatedAt: null },
              })
            : await tx.loyaltyAccount.create({ data: { customerId } });
        }
        let alias = await tx.customerIdentifier.findFirst({
          where: { customerId, kind: 'WALLET' },
          select: { normalizedValue: true },
        });
        if (!alias) {
          alias = await tx.customerIdentifier.create({
            data: {
              customerId,
              kind: 'WALLET',
              normalizedValue: mintWalletAlias(),
              verifiedAt: new Date(),
            },
            select: { normalizedValue: true },
          });
        }
        const serials = await ensureWalletPasses(tx, { customerId, loyaltyAccountId: account.id });
        const idempotencyKey = `wallet-enrollment:${attempt.id}`;
        await Promise.all([
          tx.customerInteraction.create({
            data: {
              customerId,
              branchId: link.branchId,
              type: 'WALLET_ENROLLMENT',
              idempotencyKey,
            },
          }),
          tx.customerConsent.create({
            data: {
              customerId,
              channel: kind === 'EMAIL' ? 'EMAIL' : 'PHONE',
              granted: true,
              source: 'WALLET_ENROLLMENT',
              actorId: 'PUBLIC_WALLET_ENROLLMENT',
              policyVersion: 'wallet-v1',
              idempotencyKey,
            },
          }),
          tx.walletEnrollmentAttempt.delete({ where: { id: attempt.id } }),
        ]);
        return {
          passes: serials,
          phoneJoin: link.phoneJoin,
          alias: alias.normalizedValue,
          balance: await loyaltyBalance(tx, account.id),
        };
      }
    );
  });
}
