import type { Prisma } from '@/generated/prisma/client';

// DEV-961: the member shape the owner and reset checks read, in a module of its own so the
// approval-authenticator gate (read by web sign-in) does not import the PIN verifier.

type Rule = { capability: string; effect: string };

/** A member as `hasAllCapabilityAccess` reads them, loaded live from the database. */
export type ApprovalAuthenticatorParty = {
  id: string;
  role: string;
  status: string;
  organizationRole?: { key?: string; isSystem?: boolean; permissions: readonly Rule[] } | null;
  permissionOverrides: readonly Rule[];
};

/** Live select for `approvalAuthenticatorResetDenial` and the owner checks. */
export function approvalAuthenticatorPartySelect(now = new Date()) {
  return {
    id: true,
    role: true,
    status: true,
    organizationRole: {
      select: {
        key: true,
        isSystem: true,
        permissions: { select: { capability: true, effect: true } },
      },
    },
    permissionOverrides: {
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { capability: true, effect: true },
    },
  } satisfies Prisma.UserSelect;
}
