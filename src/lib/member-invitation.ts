import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import { generateInviteToken } from '@/lib/invite-token';

/**
 * The seat-checked "create an INVITED member and mint their single-use link"
 * step, shared by `team.inviteMember` and the restaurant staff console's invite
 * (DEV-253). The caller authorizes the actor and validates the profile first.
 */

// How long an invitation link stays valid.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OCCUPIED_SEAT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INVITED'] as const;

export type MemberInviteProfile = {
  name: string;
  role: 'ADMIN' | 'HR' | 'EMPLOYEE';
  /** Omitted leaves a pending invite's template as it is (new users get none). */
  organizationRoleId?: string;
  department: string;
  title: string;
  phone: string | null;
  bio: string | null;
  skills: string[];
};

// HTTP batch mutations share a transaction. PostgreSQL row locks do not
// serialize callers inside that same transaction, so queue the entire invite
// operation as well as locking the organization against other transactions.
const inviteQueues = new WeakMap<Prisma.TransactionClient, Promise<void>>();

async function serializeInvite<T>(tx: Prisma.TransactionClient, run: () => Promise<T>): Promise<T> {
  const previous = inviteQueues.get(tx) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  inviteQueues.set(tx, pending);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (inviteQueues.get(tx) === pending) inviteQueues.delete(tx);
  }
}

/**
 * Create (or refresh a still-pending) INVITED member with no password and
 * replace any prior invitation with a fresh token. Only a still-pending invite
 * may be re-sent; an existing real account is a CONFLICT. A new member must fit
 * the organization's seat limit, counted under the organization row lock.
 *
 * Refreshing rewrites that person's details and hands the caller their new
 * link, so a caller that may not take over someone else's pending invitation
 * passes `refreshPendingInvite: false` and gets a CONFLICT instead.
 */
export async function createMemberInvitation(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    email: string;
    seatLimit: number;
    invitedById: string;
    profile: MemberInviteProfile;
    refreshPendingInvite?: boolean;
  }
) {
  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const { email, profile } = input;

  const user = await serializeInvite(tx, async () => {
    // Serialize all seat-consuming writes for this organization. The count
    // must happen after taking the lock so a concurrent invite that just
    // committed is included before this transaction decides to create.
    await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${input.organizationId} FOR UPDATE`;
    const existing = await tx.user.findFirst({
      where: { email },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'INVITED') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A user with this email already exists',
      });
    }
    if (existing && input.refreshPendingInvite === false) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'This person already has a pending invitation. An organization administrator can re-send it from Team.',
      });
    }
    if (!existing) {
      const occupiedSeats = await tx.user.count({
        where: { status: { in: [...OCCUPIED_SEAT_STATUSES] } },
      });
      if (occupiedSeats >= input.seatLimit) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Seat limit reached (${occupiedSeats}/${input.seatLimit}). Increase the organization license before inviting another member.`,
        });
      }
    }

    // Upsert the user (re-invite refreshes the seeded details), then replace
    // any prior invitation with a fresh single-use token.
    const u = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { ...profile, password: null, status: 'INVITED' },
        })
      : await tx.user.create({
          data: { ...profile, email, password: null, status: 'INVITED' },
        });

    await tx.invitation.upsert({
      where: { userId: u.id },
      create: {
        userId: u.id,
        email,
        tokenHash,
        invitedById: input.invitedById,
        expiresAt,
      },
      update: { tokenHash, expiresAt, acceptedAt: null, invitedById: input.invitedById },
    });

    return u;
  });

  return { user, token };
}
