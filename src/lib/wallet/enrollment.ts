import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { normalizeCustomerIdentifier } from '@/lib/restaurant/customers';
import { mintWalletAlias } from './alias';
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

async function licensed(db: ScopedDb, organizationId: string) {
  const entitlements = await resolveOrganizationEntitlements(organizationId, db);
  return {
    ok: hasModule(entitlements, 'restaurant-loyalty'),
    activeCustomersMax:
      entitlements.limits['loyalty.activeCustomers.max'] ??
      entitlements.limits['restaurant-core.loyalty.activeCustomers.max'] ??
      0,
  };
}

export async function resolveEnrollmentLink(hostOrganizationId: string, token: string) {
  if (!ENROLLMENT_TOKEN_PATTERN.test(token)) return null;
  const candidate = await withPlatformDb((db) =>
    db.walletEnrollmentLink.findUnique({
      where: { tokenHash: hashEnrollmentToken(token) },
      select: { organizationId: true, branchId: true, active: true, revokedAt: true },
    })
  );
  if (
    !candidate ||
    candidate.organizationId !== hostOrganizationId ||
    !candidate.active ||
    candidate.revokedAt
  ) {
    return null;
  }
  return withTenantDb(candidate.organizationId, async (db) => {
    const access = await licensed(db, candidate.organizationId);
    if (!access.ok) return null;
    const [branch, config] = await Promise.all([
      db.restaurantBranch.findUnique({ where: { id: candidate.branchId }, select: { name: true } }),
      db.walletTenantConfig.findUnique({
        where: { organizationId: candidate.organizationId },
        select: { programDisplayName: true },
      }),
    ]);
    if (!branch || !config) return null;
    return { ...candidate, branchName: branch.name, programDisplayName: config.programDisplayName };
  });
}

export async function startEnrollment(input: {
  organizationId: string;
  token: string;
  email: string;
  sendOtp: (input: { email: string; otp: string; programName: string }) => Promise<void>;
}) {
  const link = await resolveEnrollmentLink(input.organizationId, input.token);
  if (!link) return null;
  const email = normalizeCustomerIdentifier({ kind: 'EMAIL', value: input.email });
  const otp = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
  const attempt = await withTenantDb(input.organizationId, (db) =>
    db.walletEnrollmentAttempt.create({
      data: {
        branchId: link.branchId,
        identifierKind: 'EMAIL',
        normalizedValue: email,
        otpHash: hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
      select: { id: true },
    })
  );
  try {
    await input.sendOtp({ email, otp, programName: link.programDisplayName });
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
}) {
  const link = await resolveEnrollmentLink(input.organizationId, input.token);
  if (!link) return null;
  return withTenantDb(input.organizationId, async (db) => {
    const attempt = await db.walletEnrollmentAttempt.findUnique({ where: { id: input.attemptId } });
    if (
      !attempt ||
      attempt.branchId !== link.branchId ||
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
    const access = await licensed(db, input.organizationId);
    if (!access.ok) return null;
    return (db.$transaction as unknown as <T>(work: (tx: ScopedDb) => Promise<T>) => Promise<T>)(
      async (tx) => {
        const existingIdentifier = await tx.customerIdentifier.findUnique({
          where: {
            organizationId_kind_normalizedValue: {
              organizationId: input.organizationId,
              kind: 'EMAIL',
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
                      kind: 'EMAIL',
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
            where: { customerId, kind: 'EMAIL', normalizedValue: attempt.normalizedValue },
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
              channel: 'EMAIL',
              granted: true,
              source: 'WALLET_ENROLLMENT',
              actorId: 'PUBLIC_WALLET_ENROLLMENT',
              policyVersion: 'wallet-v1',
              idempotencyKey,
            },
          }),
          tx.walletEnrollmentAttempt.delete({ where: { id: attempt.id } }),
        ]);
        return { passes: serials };
      }
    );
  });
}
