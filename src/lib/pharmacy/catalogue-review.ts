import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import { can, isExplicitlyDenied, subjectFromSession } from '@/lib/abac';

/**
 * Catalogue review authority.
 *
 * Editing the medicine catalogue (ingredients, medicines, packs, printed MRPs,
 * barcodes, aliases) only ever proposes a change. A change is written to the
 * catalogue when a different user holding `pharmacy:catalogue-review` approves
 * it. The one exception is a solo owner: a tenant administrator with no other
 * active member who could review may decide their own change.
 */

export type CatalogueDb = Prisma.TransactionClient;

export type CatalogueActor = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

export type CatalogueReviewMode = 'SECOND_REVIEWER' | 'SOLO_OWNER';

type CheckOptions = { ip?: string | null; now?: Date };

/** Users above this count are never treated as a solo workspace. */
const SOLO_OWNER_MEMBER_SCAN_LIMIT = 500;

/**
 * Proposing a catalogue edit needs `pharmacy:catalogue-edit`. Roles stored before
 * that capability existed are honoured through the capabilities that already
 * covered catalogue upkeep (`pharmacy:catalogue-review`, `pharmacy:manage`), so
 * no tenant's role has to be rewritten. An explicit DENY of
 * `pharmacy:catalogue-edit` still wins over those equivalents. The cashier,
 * procurement, inventory, finance and auditor templates hold none of them.
 */
export async function canProposeCatalogueChange(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<boolean> {
  const subject = subjectFromSession(actor);
  const opts = { db, source: 'TRPC' as const, ip: options.ip ?? null, now: options.now };
  if (await can(subject, 'pharmacy:catalogue-edit', undefined, opts)) return true;
  if (await isExplicitlyDenied(db, actor.id, 'pharmacy:catalogue-edit', options.now)) return false;
  for (const equivalent of ['pharmacy:catalogue-review', 'pharmacy:manage'] as const) {
    if (await can(subject, equivalent, undefined, opts)) return true;
  }
  return false;
}

export async function assertCanProposeCatalogueChange(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<void> {
  if (await canProposeCatalogueChange(db, actor, options)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Editing the medicine catalogue needs the catalogue edit permission.',
  });
}

/**
 * A solo owner is a tenant administrator for whom no other active member of the
 * workspace holds `pharmacy:catalogue-review`, so nobody else could ever review
 * their change.
 */
export async function isSoloCatalogueOwner(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<boolean> {
  if (actor.role !== 'ADMIN') return false;
  const others = await db.user.findMany({
    where: { id: { not: actor.id }, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
    select: { id: true, role: true, department: true, status: true },
    take: SOLO_OWNER_MEMBER_SCAN_LIMIT + 1,
  });
  if (others.length > SOLO_OWNER_MEMBER_SCAN_LIMIT) return false;
  for (const other of others) {
    if (
      await can(subjectFromSession(other), 'pharmacy:catalogue-review', undefined, {
        db,
        source: 'TRPC',
        ip: options.ip ?? null,
        now: options.now,
      })
    )
      return false;
  }
  return true;
}

export type CatalogueReviewAuthority = { reviewer: boolean; soloOwner: boolean };

/** Whether `actor` holds pharmacy:catalogue-review and whether they are a solo owner. */
export async function catalogueReviewAuthority(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<CatalogueReviewAuthority> {
  const reviewer = await can(subjectFromSession(actor), 'pharmacy:catalogue-review', undefined, {
    db,
    source: 'TRPC',
    ip: options.ip ?? null,
    now: options.now,
  });
  return { reviewer, soloOwner: await isSoloCatalogueOwner(db, actor, options) };
}

/** FORBIDDEN unless `actor` may review catalogue changes at all. */
export async function assertCatalogueReviewer(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<CatalogueReviewAuthority> {
  const authority = await catalogueReviewAuthority(db, actor, options);
  if (authority.reviewer || authority.soloOwner) return authority;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Reviewing catalogue changes needs the pharmacy:catalogue-review permission.',
  });
}

/**
 * How `actorId` may decide a change proposed by `proposedBy`, or FORBIDDEN.
 * - a different user with pharmacy:catalogue-review: SECOND_REVIEWER;
 * - a solo owner (including for their own change): SOLO_OWNER;
 * - every other self-review is refused.
 */
export function catalogueReviewModeFor(
  authority: CatalogueReviewAuthority,
  actorId: string,
  proposedBy: string
): CatalogueReviewMode {
  if (proposedBy !== actorId) {
    if (authority.reviewer) return 'SECOND_REVIEWER';
    if (authority.soloOwner) return 'SOLO_OWNER';
  } else if (authority.soloOwner) {
    return 'SOLO_OWNER';
  }
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      proposedBy === actorId
        ? 'You proposed this catalogue change. A different user with catalogue review permission must decide it.'
        : 'Reviewing catalogue changes needs the pharmacy:catalogue-review permission.',
  });
}
