import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { type ActivationGate, unmetActivationGates } from '@/lib/platform/activation-gates';
import {
  evaluatePharmacyReadiness,
  pharmacyOnboardingStep,
  type PharmacyReadiness,
} from '@/lib/pharmacy/onboarding';

/**
 * DEV-905 — the super admin's queue of pharmacies awaiting approval, and the list of
 * checks a pharmacy does not meet.
 *
 * The queue lists only pharmacy organizations in ONBOARDING, oldest first, a page at a
 * time, split into those that meet every check and those still onboarding, each with
 * the checks it does not meet. The checks are the activation preflight's own: the base
 * conditions from `unmetActivationGates` (read with the same filters
 * `assertActivationReady` applies) and the pharmacy onboarding gates from
 * `evaluatePharmacyReadiness`, which include the regulatory profile and qualified
 * person (Premises and licences). They are information for the approver: a super admin
 * may approve past them after confirming them by name (owner decision, 18 Nov), and the
 * approval command recomputes the same list on the server.
 */

/** Bound each page of the queue; the oldest waiting pharmacies come first. */
export const PHARMACY_APPROVAL_QUEUE_PAGE_SIZE = 50;

export type PharmacyApprovalGate = {
  key: string;
  label: string;
  href: string;
};

export type PharmacyApprovalQueueEntry = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  createdAt: Date;
  openGates: PharmacyApprovalGate[];
};

export type PharmacyApprovalQueue = {
  ready: PharmacyApprovalQueueEntry[];
  onboarding: PharmacyApprovalQueueEntry[];
  /** Every pharmacy in ONBOARDING, on this page or not. */
  total: number;
  /** The cursor for the next page, or null when this page is the last. */
  nextCursor: string | null;
  /** True when this page was reached through a cursor. */
  paged: boolean;
};

/** The organization facts the base activation gates decide on, as the preflight reads them. */
const ACTIVATION_FACTS_SELECT = {
  id: true,
  packageId: true,
  package: { select: { moduleLinks: { where: { enabled: true }, select: { id: true } } } },
  modules: { where: { status: { in: ['ENABLED', 'TRIAL'] } }, select: { id: true } },
  users: {
    where: { role: 'ADMIN', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
    select: { id: true },
    take: 1,
  },
  deployments: {
    where: { environment: 'production', status: 'READY' },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.OrganizationSelect;

type ActivationFacts = {
  id: string;
  packageId: string | null;
  package: { moduleLinks: { id: string }[] } | null;
  modules: { id: string }[];
  users: { id: string }[];
  deployments: { id: string }[];
};

/**
 * The approval's unmet checks from the base activation gates and the pharmacy readiness
 * already evaluated: base gates first, then the onboarding gates in walk order. The
 * organization page builds its list here too, so both name the same keys the server
 * asks the operator to confirm.
 */
export function pharmacyApprovalChecks(
  organizationId: string,
  baseGates: readonly ActivationGate[],
  readiness: Pick<PharmacyReadiness, 'blocking'> | null
): PharmacyApprovalGate[] {
  return [
    ...baseGates.map((gate) => ({
      key: gate.gate,
      label: gate.message,
      href: gate.action.href,
    })),
    ...(readiness?.blocking ?? []).map((gate) => ({
      key: gate,
      label: `${pharmacyOnboardingStep(gate).label} (${gate})`,
      href: `/platform/organizations/${organizationId}#vertical-readiness`,
    })),
  ];
}

async function uncheckedGates(
  db: PrismaClient,
  organization: ActivationFacts,
  now: Date
): Promise<PharmacyApprovalGate[]> {
  const baseGates = unmetActivationGates({
    organizationId: organization.id,
    hasPackage: Boolean(organization.packageId),
    enabledModuleCount:
      organization.modules.length + (organization.package?.moduleLinks.length ?? 0),
    administratorCount: organization.users.length,
    readyProductionDeploymentCount: organization.deployments.length,
  });
  const readiness = await evaluatePharmacyReadiness(db, organization.id, now);
  return pharmacyApprovalChecks(organization.id, baseGates, readiness);
}

/**
 * The checks this pharmacy does not meet now, in the order the preflight reports them.
 * Read on the platform connection. Empty for an organization that does not exist.
 */
export async function pharmacyApprovalUnmetChecks(
  db: PrismaClient,
  organizationId: string,
  now: Date = new Date()
): Promise<PharmacyApprovalGate[]> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: ACTIVATION_FACTS_SELECT,
  });
  if (!organization) return [];
  return uncheckedGates(db, organization, now);
}

const QUEUE_WHERE = {
  vertical: 'PHARMACY',
  status: 'ONBOARDING',
} satisfies Prisma.OrganizationWhereInput;

export async function readPharmacyApprovalQueue(
  db: PrismaClient,
  options: { after?: string | null; now?: Date } = {}
): Promise<PharmacyApprovalQueue> {
  const now = options.now ?? new Date();
  // Keyset pagination on (createdAt, id): a cursor that no longer names a waiting
  // pharmacy (approved meanwhile) starts again from the oldest.
  const anchor = options.after
    ? await db.organization.findFirst({
        where: { ...QUEUE_WHERE, id: options.after },
        select: { id: true, createdAt: true },
      })
    : null;
  const [total, organizations] = await Promise.all([
    db.organization.count({ where: QUEUE_WHERE }),
    db.organization.findMany({
      where: anchor
        ? {
            ...QUEUE_WHERE,
            OR: [
              { createdAt: { gt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { gt: anchor.id } },
            ],
          }
        : QUEUE_WHERE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PHARMACY_APPROVAL_QUEUE_PAGE_SIZE + 1,
      select: {
        ...ACTIVATION_FACTS_SELECT,
        slug: true,
        displayName: true,
        legalName: true,
        createdAt: true,
      },
    }),
  ]);
  const page = organizations.slice(0, PHARMACY_APPROVAL_QUEUE_PAGE_SIZE);
  const nextCursor =
    organizations.length > PHARMACY_APPROVAL_QUEUE_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null;

  const queue: PharmacyApprovalQueue = {
    ready: [],
    onboarding: [],
    total,
    nextCursor,
    paged: Boolean(anchor),
  };
  // One organization at a time: each readiness evaluation runs several queries, and the
  // platform connection is shared with the rest of the page.
  for (const organization of page) {
    const openGates = await uncheckedGates(db, organization, now);
    const entry: PharmacyApprovalQueueEntry = {
      id: organization.id,
      slug: organization.slug,
      displayName: organization.displayName,
      legalName: organization.legalName,
      createdAt: organization.createdAt,
      openGates,
    };
    (openGates.length === 0 ? queue.ready : queue.onboarding).push(entry);
  }
  return queue;
}
