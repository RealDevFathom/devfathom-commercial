import type { PrismaClient } from '@/generated/prisma/client';
import { unmetActivationGates } from '@/lib/platform/activation-gates';
import { evaluatePharmacyReadiness, pharmacyOnboardingStep } from '@/lib/pharmacy/onboarding';

/**
 * DEV-905 — the super admin's queue of pharmacies awaiting approval.
 *
 * It lists only pharmacy organizations in ONBOARDING, oldest first, split into those
 * ready to approve and those still onboarding with the gates that are not passed. The
 * gates are the activation preflight's own: the base conditions from
 * `unmetActivationGates` (read with the same filters `assertActivationReady` applies)
 * and the pharmacy onboarding gates from `evaluatePharmacyReadiness`, the function the
 * preflight itself calls. This read authorizes nothing: approval re-runs the full
 * preflight on the server, and a pharmacy this queue calls ready is still refused if
 * anything changed in between.
 */

/** Bound the queue; the oldest waiting pharmacies come first. */
export const PHARMACY_APPROVAL_QUEUE_LIMIT = 100;

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
};

export async function readPharmacyApprovalQueue(
  db: PrismaClient,
  now: Date = new Date()
): Promise<PharmacyApprovalQueue> {
  const organizations = await db.organization.findMany({
    where: { vertical: 'PHARMACY', status: 'ONBOARDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PHARMACY_APPROVAL_QUEUE_LIMIT,
    select: {
      id: true,
      slug: true,
      displayName: true,
      legalName: true,
      createdAt: true,
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
    },
  });

  const queue: PharmacyApprovalQueue = { ready: [], onboarding: [] };
  // One organization at a time: each readiness evaluation runs several queries, and the
  // platform connection is shared with the rest of the page.
  for (const organization of organizations) {
    const baseGates = unmetActivationGates({
      organizationId: organization.id,
      hasPackage: Boolean(organization.packageId),
      enabledModuleCount:
        organization.modules.length + (organization.package?.moduleLinks.length ?? 0),
      administratorCount: organization.users.length,
      readyProductionDeploymentCount: organization.deployments.length,
    });
    const readiness = await evaluatePharmacyReadiness(db, organization.id, now);
    const openGates: PharmacyApprovalGate[] = [
      ...baseGates.map((gate) => ({
        key: gate.gate,
        label: gate.message,
        href: gate.action.href,
      })),
      ...readiness.blocking.map((gate) => ({
        key: gate,
        label: `${pharmacyOnboardingStep(gate).label} (${gate})`,
        href: `/platform/organizations/${organization.id}#vertical-readiness`,
      })),
    ];
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
