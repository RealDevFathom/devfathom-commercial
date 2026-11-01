import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import { can, isExplicitlyDenied, subjectFromSession } from '@/lib/abac';

/**
 * Catalogue review authority.
 *
 * Editing the medicine catalogue (ingredients, medicines, packs, printed MRPs,
 * barcodes, aliases) only ever proposes a change. A change is written to the
 * catalogue when a different user holding `pharmacy:catalogue-review` approves
 * it. Where nobody holds that capability, a catalogue owner (a tenant
 * administrator whose own rules cover the catalogue) may decide other users'
 * changes; only a solo owner, with no other member who could ever review, may
 * decide their own change.
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
 * A catalogue owner is a tenant administrator whose own rules still cover the
 * catalogue: no explicit DENY of `pharmacy:catalogue-review`, and either no
 * organization role (legacy administrator) or a role granting a catalogue
 * capability (see canProposeCatalogueChange). An ADMIN whose assigned role is,
 * say, Cashier is therefore never a catalogue owner.
 */
export async function isCatalogueOwner(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<boolean> {
  if (actor.role !== 'ADMIN') return false;
  if (await isExplicitlyDenied(db, actor.id, 'pharmacy:catalogue-review', options.now))
    return false;
  return canProposeCatalogueChange(db, actor, options);
}

export type CatalogueReviewAuthority = {
  /** Holds pharmacy:catalogue-review. */
  reviewer: boolean;
  /**
   * A catalogue owner in a workspace where no other active member holds
   * pharmacy:catalogue-review: may decide other users' changes.
   */
  ownerReviewer: boolean;
  /**
   * An owner reviewer with no other active member who could ever review
   * (neither a catalogue reviewer nor another catalogue owner): may also decide
   * their own changes.
   */
  soloOwner: boolean;
};

/** How `actor` may review catalogue changes. */
export async function catalogueReviewAuthority(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<CatalogueReviewAuthority> {
  const opts = { db, source: 'TRPC' as const, ip: options.ip ?? null, now: options.now };
  const reviewer = await can(
    subjectFromSession(actor),
    'pharmacy:catalogue-review',
    undefined,
    opts
  );
  const none = { reviewer, ownerReviewer: false, soloOwner: false };
  if (!(await isCatalogueOwner(db, actor, options))) return none;
  const others = await db.user.findMany({
    where: { id: { not: actor.id }, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
    select: { id: true, role: true, department: true, status: true },
    take: SOLO_OWNER_MEMBER_SCAN_LIMIT + 1,
  });
  if (others.length > SOLO_OWNER_MEMBER_SCAN_LIMIT) return none;
  let otherOwner = false;
  for (const other of others) {
    if (await can(subjectFromSession(other), 'pharmacy:catalogue-review', undefined, opts))
      return none;
    if (!otherOwner && (await isCatalogueOwner(db, other, options))) otherOwner = true;
  }
  return { reviewer, ownerReviewer: true, soloOwner: !otherOwner };
}

/**
 * Whether `actor` is a solo owner: a catalogue owner for whom no other active
 * member of the workspace could ever review their change.
 */
export async function isSoloCatalogueOwner(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<boolean> {
  return (await catalogueReviewAuthority(db, actor, options)).soloOwner;
}

/** FORBIDDEN unless `actor` may review catalogue changes at all. */
export async function assertCatalogueReviewer(
  db: CatalogueDb,
  actor: CatalogueActor,
  options: CheckOptions = {}
): Promise<CatalogueReviewAuthority> {
  const authority = await catalogueReviewAuthority(db, actor, options);
  if (authority.reviewer || authority.ownerReviewer || authority.soloOwner) return authority;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Reviewing catalogue changes needs the pharmacy:catalogue-review permission.',
  });
}

/**
 * How `actorId` may decide a change proposed by `proposedBy`, or FORBIDDEN.
 * - a different user with pharmacy:catalogue-review, or an owner reviewer
 *   (catalogue owner where nobody holds catalogue review): SECOND_REVIEWER;
 * - a solo owner deciding their own change: SOLO_OWNER;
 * - every other self-review is refused.
 */
export function catalogueReviewModeFor(
  authority: CatalogueReviewAuthority,
  actorId: string,
  proposedBy: string
): CatalogueReviewMode {
  if (proposedBy !== actorId) {
    if (authority.reviewer || authority.ownerReviewer || authority.soloOwner)
      return 'SECOND_REVIEWER';
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
