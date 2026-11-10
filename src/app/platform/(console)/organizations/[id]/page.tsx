import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CircleDashed } from 'lucide-react';
import {
  PlatformCommandButton,
  PlatformCommandForm,
} from '@/components/platform/platform-command-form';
import { sharedDeploymentUrl, unmetActivationGates } from '@/lib/platform/activation-gates';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { SupportAccessForm } from '@/components/platform/support-access-form';
import { evaluatePharmacyReadiness } from '@/lib/pharmacy/onboarding';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { resolveEntitlementLimit, SOP_TEMPLATES_LIMIT } from '@/lib/entitlement-limits';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { ianaTimezoneOptions } from '@/lib/platform/timezones';
import {
  ALL_VERTICALS,
  VERTICALS,
  mandatoryModulesForVertical,
  type OrganizationVertical,
} from '@/lib/vertical-catalog';

const transitionTargets: Record<string, string[]> = {
  PROSPECT: ['ONBOARDING', 'TERMINATED'],
  ONBOARDING: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  ACTIVE: ['GRACE', 'SUSPENDED', 'TERMINATED'],
  GRACE: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['PURGING'],
  PURGING: [],
  PURGED: [],
};

export default async function OrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformRead('/platform/organizations');
  const timezoneOptions = ianaTimezoneOptions();
  const { id } = await params;
  const now = new Date();
  const data = await withPlatformDb(async (db) => {
    const [
      organization,
      modules,
      packages,
      liveContracts,
      branchCount,
      restaurantBranches,
      failedProvisioningJob,
    ] = await Promise.all([
      db.organization.findUnique({
        where: { id },
        include: {
          package: {
            select: {
              id: true,
              name: true,
              key: true,
              vertical: true,
              // Package defaults are the entitlement baseline; only enabled links
              // to still-active catalog modules count.
              moduleLinks: {
                where: { enabled: true },
                select: {
                  moduleId: true,
                  limits: true,
                  module: { select: { active: true, key: true } },
                },
              },
            },
          },
          modules: {
            include: { module: true },
            orderBy: { module: { sortOrder: 'asc' } },
          },
          limits: { orderBy: { key: 'asc' } },
          usageCounters: { orderBy: { updatedAt: 'desc' }, take: 12 },
          brand: true,
          emailSettings: true,
          domains: { orderBy: [{ isPrimary: 'desc' }, { host: 'asc' }] },
          identityConnections: { orderBy: { createdAt: 'desc' } },
          scimTokens: { orderBy: { createdAt: 'desc' } },
          scimEvents: { orderBy: { createdAt: 'desc' }, take: 20 },
          departments: {
            where: { active: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          },
          roles: {
            orderBy: { name: 'asc' },
            include: {
              permissions: { orderBy: { capability: 'asc' } },
              _count: { select: { users: true } },
            },
          },
          permissionOverrides: {
            orderBy: { updatedAt: 'desc' },
            include: { user: { select: { name: true, email: true } } },
          },
          deployments: { orderBy: { environment: 'asc' } },
          contracts: { orderBy: { endDate: 'desc' }, take: 5 },
          invoices: { orderBy: { dueAt: 'desc' }, take: 5 },
          lifecycleEvents: { orderBy: { createdAt: 'desc' }, take: 12 },
          restaurantActivationAcknowledgements: {
            orderBy: { kind: 'asc' },
          },
          users: {
            orderBy: [{ role: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              status: true,
              title: true,
              department: true,
              organizationRoleId: true,
            },
          },
          _count: { select: { users: true } },
        },
      }),
      db.platformModule.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      // Every active package is loaded once and partitioned by vertical below:
      // the profile form may offer only same-vertical packages (§2.3), while a
      // pre-activation correction may offer only the target vertical's packages.
      db.platformPackage.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      // Mirrors the live-contract predicate in `resolveOrganizationEntitlements`
      // so the console reports the same effective source the runtime resolves.
      db.platformContract.findMany({
        where: {
          organizationId: id,
          status: { in: ['ACTIVE', 'GRACE', 'RENEWAL_DUE'] },
          startDate: { lte: now },
          OR: [{ endDate: { gte: now } }, { graceUntil: { gte: now } }],
        },
        select: {
          modules: { select: { moduleId: true, module: { select: { active: true } } } },
        },
      }),
      // §2.2 — the command refuses a vertical correction once vertical-owned rows
      // exist, so the affordance must not be offered once they do.
      db.restaurantBranch.count({ where: { organizationId: id } }),
      db.restaurantBranch.findMany({
        where: { organizationId: id, isDefault: true, active: true },
        select: { id: true, name: true, address: true, timezone: true, businessDayCutoff: true },
      }),
      db.platformJob.findFirst({
        where: {
          organizationId: id,
          type: { in: ['PROVISION_SHARED', 'PROVISION_DEDICATED'] },
          status: 'FAILED',
        },
        orderBy: { finishedAt: 'desc' },
        select: {
          id: true,
          type: true,
          attempts: true,
          maxAttempts: true,
          finishedAt: true,
        },
      }),
    ]);
    const pharmacyReadiness =
      organization?.vertical === 'PHARMACY' ? await evaluatePharmacyReadiness(db, id, now) : null;
    return {
      pharmacyReadiness,
      organization,
      modules,
      packages,
      liveContracts,
      branchCount,
      restaurantBranches,
      failedProvisioningJob,
    };
  });
  if (!data.organization) notFound();
  const organization = data.organization;
  const vertical: OrganizationVertical = organization.vertical;
  const verticalDefinition = VERTICALS[vertical];
  const assigned = new Map(organization.modules.map((item) => [item.moduleId, item]));
  const targets = transitionTargets[organization.status] ?? [];
  // WHA-1180 — the same base preflight conditions `assertActivationReady`
  // enforces, evaluated against the rows this page already loaded. The
  // predicates below mirror that command's `include` filters exactly; the
  // page's own includes are unfiltered because other panels need every row.
  const activationGates = unmetActivationGates({
    organizationId: organization.id,
    hasPackage: Boolean(organization.packageId),
    enabledModuleCount:
      organization.modules.filter((item) => item.status === 'ENABLED' || item.status === 'TRIAL')
        .length + (organization.package?.moduleLinks.length ?? 0),
    administratorCount: organization.users.filter(
      (user) => user.role === 'ADMIN' && (user.status === 'ACTIVE' || user.status === 'ON_LEAVE')
    ).length,
    readyProductionDeploymentCount: organization.deployments.filter(
      (deployment) => deployment.environment === 'production' && deployment.status === 'READY'
    ).length,
  });
  const sharedDeployment = sharedDeploymentUrl(organization);
  const packageLimits: Record<string, number> = {};
  for (const link of organization.package?.moduleLinks ?? []) {
    if (!link.limits || typeof link.limits !== 'object' || Array.isArray(link.limits)) continue;
    for (const [key, value] of Object.entries(link.limits)) {
      if (typeof value === 'number') packageLimits[`${link.module.key}.${key}`] = value;
    }
  }
  const sopLimitDiagnostic = resolveEntitlementLimit(
    {
      ...packageLimits,
      ...Object.fromEntries(organization.limits.map((limit) => [limit.key, limit.value])),
    },
    SOP_TEMPLATES_LIMIT
  );

  // §2.3 — a package may only be assigned when its vertical matches; the command
  // rejects a mismatch, so the console never offers one.
  const assignablePackages = data.packages.filter((item) => item.vertical === vertical);

  // §6 — the enablement guard rejects any module whose owning vertical differs
  // from the organization's, so only grantable modules are listed.
  const catalogModules = data.modules.filter((module) => {
    const moduleVertical = verticalForModuleKey(module.key);
    return !moduleVertical || moduleVertical === vertical;
  });
  const mandatoryKeys = new Set([
    ...mandatoryModulesForVertical(vertical).map((module) => module.key),
    ...data.modules.filter((module) => module.band === 'BASELINE').map((module) => module.key),
  ]);

  const packageModuleIds = new Set(
    (organization.package?.moduleLinks ?? [])
      .filter((link) => link.module.active)
      .map((link) => link.moduleId)
  );
  const contractModuleIds = new Set(
    data.liveContracts.flatMap((contract) =>
      contract.modules.filter((link) => link.module.active).map((link) => link.moduleId)
    )
  );

  /**
   * The same precedence `resolveOrganizationEntitlements` applies at runtime:
   * package defaults are the baseline, a live contract can add a module, and an
   * organization override is final — including an explicit disable and its
   * start/expiry window. Reported so an operator acts on the effective state
   * rather than on the override row alone.
   */
  function effectiveEntitlement(moduleId: string) {
    const override = assigned.get(moduleId);
    if (override) {
      const inWindow =
        override.startsAt <= now && (!override.expiresAt || override.expiresAt > now);
      return {
        source: 'OVERRIDE' as const,
        enabled: inWindow && (override.status === 'ENABLED' || override.status === 'TRIAL'),
        override,
      };
    }
    if (contractModuleIds.has(moduleId)) return { source: 'CONTRACT' as const, enabled: true };
    if (packageModuleIds.has(moduleId)) return { source: 'PACKAGE' as const, enabled: true };
    return { source: 'NONE' as const, enabled: false };
  }

  // §2.2 — a vertical correction is an early-onboarding-only repair. Lane B
  // requires all four conditions server-side; the affordance mirrors them exactly
  // so the console never shows an action the command would reject.
  const correctionTarget = ALL_VERTICALS.find((option) => option !== vertical);
  const correctionPackages = correctionTarget
    ? data.packages.filter((item) => item.vertical === correctionTarget)
    : [];
  const correctionAllowed =
    organization.status === 'ONBOARDING' &&
    organization.activatedAt === null &&
    data.branchCount === 0 &&
    organization.modules.length === 0;

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow={`Organizations / ${organization.slug}`}
        title={organization.displayName}
        description={`${organization.legalName} · ${verticalDefinition.label} · ${organization.deploymentMode.toLowerCase()} deployment · ${organization._count.users}/${organization.seatLimit} seats`}
        action={<PlatformStatus value={organization.status} />}
      />

      {data.failedProvisioningJob ? (
        <section
          aria-labelledby="provisioning-recovery-title"
          className="mt-5 border border-destructive/30 bg-destructive/10 px-5 py-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <PlatformStatus value="FAILED" />
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  Failed step ·{' '}
                  {data.failedProvisioningJob.type === 'PROVISION_DEDICATED'
                    ? 'Dedicated environment provisioning'
                    : 'Shared environment provisioning'}
                </p>
              </div>
              <h2
                id="provisioning-recovery-title"
                className="mt-3 font-display text-lg font-semibold text-text-strong"
              >
                Provisioning needs operator recovery
              </h2>
              <p className="mt-1 text-sm text-text-body">
                The provisioning worker exhausted {data.failedProvisioningJob.attempts} of{' '}
                {data.failedProvisioningJob.maxAttempts} attempts. Review the deployment inputs and
                provider configuration, then retry the same job. Retrying resets this job safely; it
                does not create a second deployment.
              </p>
              <p className="mt-2 text-xs text-text-muted">
                Owner: Platform Operations
                {data.failedProvisioningJob.finishedAt
                  ? ` · Failed ${data.failedProvisioningJob.finishedAt.toLocaleString()}`
                  : ''}
                . If the retry fails, escalate with the job ID from Job control; do not paste
                credentials or provider secrets into notes.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PlatformCommandButton
                action="job.retry"
                label="Retry provisioning"
                payload={{ id: data.failedProvisioningJob.id }}
              />
              <Link
                href="/platform/jobs"
                className="inline-flex min-h-9 items-center border border-border-default bg-surface-card px-3 text-xs font-semibold text-text-body transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open Job control
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      <nav
        aria-label="Organization sections"
        className="mt-5 flex gap-1 overflow-x-auto border-b border-border-default pb-3 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted"
      >
        {[
          'Lifecycle',
          'Profile',
          'Modules',
          'Limits',
          'People',
          'Brand',
          'Email',
          'Domains',
          'Identity',
          'SCIM',
          'Deployment',
          'Commercial',
          'Audit',
        ].map((item) => (
          <a
            key={item}
            href={`#${item.toLowerCase()}`}
            className="min-w-max px-3 py-2 transition hover:bg-surface-sunken hover:text-text-strong"
          >
            {item}
          </a>
        ))}
      </nav>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-7">
          {vertical !== 'RESTAURANT' &&
          !['TERMINATED', 'PURGING', 'PURGED'].includes(organization.status) ? (
            <section
              className="rounded-2xl border border-border-default bg-surface-card p-5"
              aria-labelledby="vertical-readiness"
            >
              <h2 id="vertical-readiness" className="font-display text-xl font-semibold">
                {verticalDefinition.label} readiness
              </h2>
              <p className="mt-2 text-sm text-text-muted">
                Activation requires the lifecycle checks below
                {vertical === 'PHARMACY' ? ' and all pharmacy onboarding gates.' : '.'}
              </p>
              <Link
                href="#lifecycle"
                className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Review lifecycle requirements
              </Link>
              {data.pharmacyReadiness ? (
                <ul className="mt-4 divide-y divide-border-subtle">
                  {data.pharmacyReadiness.gates.map((gate) => (
                    <li
                      key={gate.gate}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <span className="text-sm text-text-body">
                        {gate.step}. {gate.label}
                      </span>
                      <PlatformStatus value={gate.status} />
                      {gate.downgradeReason ? (
                        <p className="w-full text-xs text-text-muted">
                          {gate.downgradeReason === 'EVIDENCE_ABSENT'
                            ? 'Required evidence is missing.'
                            : 'Recorded attestation needs evidence and an accountable operator.'}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-text-body">
                  {activationGates.length === 0
                    ? 'All agency activation requirements are met.'
                    : `${activationGates.length} agency activation requirements remain.`}
                </p>
              )}
            </section>
          ) : null}
          {vertical === 'RESTAURANT' &&
          !['TERMINATED', 'PURGING', 'PURGED'].includes(organization.status) ? (
            <section
              className="border border-border-default bg-surface-card"
              aria-labelledby="restaurant-readiness"
            >
              <div className="border-b border-border-subtle px-5 py-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                  Restaurant readiness
                </p>
                <h2 id="restaurant-readiness" className="mt-1 font-display text-xl font-semibold">
                  Branch setup and policy acknowledgements
                </h2>
                <p className="mt-1 text-xs text-text-muted">
                  Complete branch operating fields and explicitly acknowledge each policy before
                  activation.
                </p>
              </div>
              {data.restaurantBranches.length === 1 ? (
                <div className="p-5">
                  <PlatformCommandForm
                    compact
                    action="organization.restaurant.setup"
                    submitLabel="Save Restaurant readiness"
                    fields={[
                      {
                        name: 'organizationId',
                        label: 'Organization',
                        type: 'hidden',
                        defaultValue: organization.id,
                      },
                      {
                        name: 'branchName',
                        minLength: 2,
                        maxLength: 120,
                        label: 'Default branch name',
                        required: true,
                        defaultValue: data.restaurantBranches[0]!.name,
                      },
                      {
                        name: 'address',
                        minLength: 1,
                        maxLength: 300,
                        label: 'Branch address',
                        required: true,
                        defaultValue: data.restaurantBranches[0]!.address,
                      },
                      {
                        name: 'timezone',
                        label: 'IANA timezone',
                        type: 'select',
                        required: true,
                        defaultValue: data.restaurantBranches[0]!.timezone,
                        help: 'Type while the list is open to search IANA timezones.',
                        options: timezoneOptions,
                      },
                      {
                        name: 'businessDayCutoff',
                        label: 'Business-day cutoff',
                        required: true,
                        defaultValue: data.restaurantBranches[0]!.businessDayCutoff,
                        format: 'time24',
                        help: 'Use 24-hour time in the organization timezone, e.g. 09:30.',
                      },
                      ...(['TAX', 'PAYMENT', 'DEVICE', 'OPERATOR'] as const).flatMap((kind) => {
                        const existing = organization.restaurantActivationAcknowledgements.find(
                          (row) => row.kind === kind
                        );
                        const title = kind.charAt(0) + kind.slice(1).toLowerCase();
                        return [
                          {
                            name: `${kind.toLowerCase()}PolicyReference`,
                            label: `${title} policy reference`,
                            minLength: 1,
                            maxLength: 300,
                            required: true,
                            defaultValue: existing?.policyReference,
                            help: 'Operator-supplied versioned reference; no provider or device is created.',
                          },
                          {
                            name: `${kind.toLowerCase()}Acknowledged`,
                            label: `${title} acknowledgement`,
                            type: 'checkbox' as const,
                            required: true,
                            defaultValue: Boolean(existing),
                            checkboxText: `I acknowledge the ${title.toLowerCase()} policy reference above.`,
                          },
                        ];
                      }),
                    ]}
                  />
                </div>
              ) : (
                <p className="p-5 text-sm text-destructive">
                  Setup requires exactly one active default branch. Repair branch state before
                  activation.
                </p>
              )}
            </section>
          ) : null}
          <section
            id="lifecycle"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Manual control
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Lifecycle gate</h2>
              <p className="mt-1 text-xs text-text-muted">
                Activation validates package, modules, administrator, and production deployment.
              </p>
            </div>
            {/*
              WHA-1180 — the unmet activation gates, each with the surface that
              satisfies it. Rendered before the operator submits, so a failed
              activation is no longer the only way to learn what is missing.
            */}
            {targets.includes('ACTIVE') && activationGates.length ? (
              <div className="border-b border-border-subtle">
                <p className="px-5 pt-4 font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">
                  Unmet activation gates
                </p>
                <ul className="mt-2 divide-y divide-border-subtle">
                  {activationGates.map((gate) => (
                    <li
                      key={gate.gate}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <span className="flex items-center gap-2 text-xs text-text-body">
                        <CircleDashed
                          className="h-3.5 w-3.5 shrink-0 text-destructive"
                          aria-hidden="true"
                        />
                        {gate.message}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {gate.gate === 'production_deployment' && sharedDeployment ? (
                          <PlatformCommandButton
                            action="organization.deployment.shared"
                            tone="quiet"
                            label="Use shared deployment"
                            payload={{
                              organizationId: organization.id,
                              reason: 'Shared platform host default applied for activation.',
                            }}
                          />
                        ) : null}
                        <Link
                          href={gate.action.href}
                          className="text-xs font-semibold text-accent-brand hover:underline"
                        >
                          {gate.action.label}
                        </Link>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {targets.length ? (
              <div className="p-5">
                <PlatformCommandForm
                  compact
                  action="organization.transition"
                  submitLabel="Apply lifecycle change"
                  fields={[
                    {
                      name: 'id',
                      label: 'Organization',
                      type: 'hidden',
                      defaultValue: organization.id,
                    },
                    {
                      name: 'status',
                      label: 'Move to',
                      type: 'select',
                      required: true,
                      options: targets.map((value) => ({
                        label: value.replaceAll('_', ' '),
                        value,
                      })),
                    },
                    {
                      name: 'reason',
                      label: 'Operator reason',
                      type: 'textarea',
                      required: true,
                      help: 'Required and written to the immutable lifecycle and audit ledgers.',
                    },
                  ]}
                />
              </div>
            ) : (
              <p className="p-5 text-sm text-text-muted">This lifecycle is terminal.</p>
            )}
          </section>

          <section id="profile" className="scroll-mt-24 space-y-7">
            <div className="border border-border-default bg-surface-card">
              <div className="border-b border-border-subtle px-5 py-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                  Immutable
                </p>
                <h2 className="mt-1 font-display text-xl font-semibold">Organization type</h2>
                <p className="mt-1 text-xs text-text-muted">
                  The type is chosen once at onboarding. It governs which packages, modules, and
                  workspace surfaces exist, and it cannot be changed after activation.
                </p>
              </div>
              <div className="grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-start">
                <div>
                  <p className="text-sm font-semibold text-text-strong">
                    {verticalDefinition.label}
                  </p>
                  <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                    {vertical}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    {verticalDefinition.description}
                  </p>
                </div>
                <PlatformStatus value="LOCKED" />
              </div>
              {correctionAllowed && correctionTarget ? (
                <div className="border-t border-border-subtle p-5">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-warning">
                    Early onboarding correction
                  </p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    This organization is still in onboarding, has never been activated, and owns no
                    branches or module overrides, so the type may still be corrected to{' '}
                    {VERTICALS[correctionTarget].label}. The replacement package is required in the
                    same command; the correction disappears as soon as setup starts.
                  </p>
                  {correctionPackages.length ? (
                    <div className="mt-4">
                      <PlatformCommandForm
                        compact
                        action="organization.update"
                        submitLabel={`Correct type to ${VERTICALS[correctionTarget].label}`}
                        fields={[
                          {
                            name: 'id',
                            label: 'Organization',
                            type: 'hidden',
                            defaultValue: organization.id,
                          },
                          {
                            name: 'vertical',
                            label: 'Corrected type',
                            type: 'hidden',
                            defaultValue: correctionTarget,
                          },
                          {
                            name: 'packageId',
                            label: `${VERTICALS[correctionTarget].label} package`,
                            type: 'select',
                            required: true,
                            help: 'A correction must move the organization and its package together.',
                            options: correctionPackages.map((item) => ({
                              label: item.name,
                              value: item.id,
                            })),
                          },
                        ]}
                      />
                    </div>
                  ) : (
                    <p className="mt-4 text-xs text-text-muted">
                      No active {VERTICALS[correctionTarget].label} package is published, so the
                      type cannot be corrected until one exists.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <PlatformCommandForm
              action="organization.update"
              title="Workspace profile"
              description="Commercial assignment, locale, seats, and customer contact."
              fields={[
                {
                  name: 'id',
                  label: 'Organization',
                  type: 'hidden',
                  defaultValue: organization.id,
                },
                {
                  name: 'displayName',
                  minLength: 1,
                  maxLength: 500,
                  label: 'Display name',
                  required: true,
                  defaultValue: organization.displayName,
                },
                {
                  name: 'legalName',
                  minLength: 1,
                  maxLength: 500,
                  label: 'Legal name',
                  required: true,
                  defaultValue: organization.legalName,
                },
                {
                  name: 'packageId',
                  label: 'Commercial package',
                  type: 'select',
                  help: `Only active ${verticalDefinition.label} packages can be assigned.`,
                  options: assignablePackages.map((item) => ({
                    label: item.name,
                    value: item.id,
                  })),
                  defaultValue: organization.packageId,
                },
                {
                  name: 'deploymentMode',
                  label: 'Deployment mode',
                  type: 'select',
                  required: true,
                  defaultValue: organization.deploymentMode,
                  options: [
                    { label: 'Shared platform', value: 'SHARED' },
                    { label: 'Dedicated enterprise', value: 'DEDICATED' },
                  ],
                },
                {
                  name: 'seatLimit',
                  label: 'Seat limit',
                  type: 'number',
                  required: true,
                  defaultValue: organization.seatLimit,
                  min: 1,
                },
                {
                  name: 'gracePeriodDays',
                  label: 'Grace period (days)',
                  type: 'number',
                  defaultValue: organization.gracePeriodDays,
                  min: 0,
                  max: 365,
                },
                {
                  name: 'timezone',
                  label: 'Timezone',
                  type: 'select',
                  defaultValue: organization.timezone,
                  help: 'Type while the list is open to search IANA timezones.',
                  options: timezoneOptions,
                },
                {
                  name: 'locale',
                  minLength: 2,
                  maxLength: 20,
                  label: 'Locale',
                  defaultValue: organization.locale,
                },
                {
                  name: 'currency',
                  minLength: 3,
                  maxLength: 3,
                  label: 'Currency',
                  defaultValue: organization.currency,
                },
                {
                  name: 'dataResidency',
                  maxLength: 5000,
                  label: 'Data residency',
                  defaultValue: organization.dataResidency,
                },
                {
                  name: 'primaryContactName',
                  maxLength: 5000,
                  label: 'Primary contact',
                  defaultValue: organization.primaryContactName,
                },
                {
                  name: 'primaryContactEmail',
                  maxLength: 254,
                  label: 'Primary email',
                  type: 'email',
                  defaultValue: organization.primaryContactEmail,
                },
                {
                  name: 'notes',
                  maxLength: 5000,
                  label: 'Operator notes',
                  type: 'textarea',
                  defaultValue: organization.notes,
                },
              ]}
            />
          </section>

          <section
            id="modules"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Entitlements
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Modules</h2>
              <p className="mt-1 text-xs text-text-muted">
                Only {verticalDefinition.label} modules are listed. Each row shows where the
                effective entitlement comes from: a package default, a live contract, an
                organization override, or nothing at all.
              </p>
            </div>
            <div className="divide-y divide-border-subtle">
              {catalogModules.map((module) => {
                const entitlement = effectiveEntitlement(module.id);
                const isMandatory = mandatoryKeys.has(module.key);
                // An inherited-enabled module needs no "Enable": writing an ENABLED
                // override would duplicate the package/contract grant and then mask
                // any later change to it. Disable stays available because it writes
                // a genuine override — except on a mandatory module, which the
                // command refuses to disable.
                const canDisable = entitlement.enabled && !isMandatory;
                const canEnable = !entitlement.enabled;
                // Resetting a mandatory module could drop it below the vertical's
                // floor, so inherited-only is not offered there.
                const canReset = entitlement.source === 'OVERRIDE' && !isMandatory;
                return (
                  <div
                    key={module.id}
                    className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                  >
                    <div>
                      <p className="text-sm font-semibold">{module.name}</p>
                      <p className="mt-1 text-xs text-text-muted">
                        {module.category} · {module.key}
                      </p>
                      <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-text-faint">
                        Source: {entitlement.source}
                        {isMandatory ? ' · mandatory' : ''}
                      </p>
                    </div>
                    <PlatformStatus value={entitlement.enabled ? 'ACTIVE' : 'INACTIVE'} />
                    <div className="flex flex-wrap justify-end gap-2">
                      {canEnable ? (
                        <PlatformCommandButton
                          action="organization.module"
                          label="Enable"
                          tone="default"
                          payload={{
                            organizationId: organization.id,
                            moduleId: module.id,
                            status: 'ENABLED',
                            seatLimit: null,
                            expiresAt: null,
                            reason: 'Operator enabled module entitlement',
                          }}
                        />
                      ) : null}
                      {canDisable ? (
                        <PlatformCommandButton
                          action="organization.module"
                          label="Disable"
                          tone="quiet"
                          payload={{
                            organizationId: organization.id,
                            moduleId: module.id,
                            status: 'DISABLED',
                            seatLimit: null,
                            expiresAt: null,
                            reason: 'Operator disabled module entitlement',
                          }}
                        />
                      ) : null}
                      {canReset ? (
                        <PlatformCommandButton
                          action="organization.module.reset"
                          label="Use inherited"
                          tone="quiet"
                          payload={{
                            organizationId: organization.id,
                            moduleId: module.id,
                          }}
                        />
                      ) : null}
                      {!canEnable && !canDisable && !canReset ? (
                        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-faint">
                          Always enabled
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!catalogModules.length ? (
                <p className="px-5 py-4 text-xs text-text-muted">
                  No active module is published for the {verticalDefinition.label} vertical yet.
                  Publish one under Modules and plans before granting entitlements.
                </p>
              ) : null}
            </div>
          </section>

          <section
            id="limits"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Limits and usage</h2>
            </div>
            <div
              role={sopLimitDiagnostic.status === 'missing' ? 'alert' : 'status'}
              className={`mx-5 mt-5 border px-4 py-3 text-xs ${
                sopLimitDiagnostic.status === 'missing'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : sopLimitDiagnostic.source === 'bootstrapped'
                    ? 'border-warning/40 bg-warning/10 text-warning-foreground'
                    : 'border-border-default bg-surface-sunken text-text-body'
              }`}
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.14em]">
                SOP entitlement configuration
              </p>
              <p className="mt-1">
                {sopLimitDiagnostic.status === 'missing'
                  ? `Configuration fault: neither ${sopLimitDiagnostic.explicitKey} nor ${sopLimitDiagnostic.bootstrappedKey} is set. Set an explicit non-negative value; zero deliberately disables new templates.`
                  : `${sopLimitDiagnostic.source === 'explicit' ? 'Explicit' : 'Bootstrapped compatibility'} key ${sopLimitDiagnostic.key} resolves to ${sopLimitDiagnostic.value}. ${sopLimitDiagnostic.value === 0 ? 'Zero is a deliberate disable.' : 'SOP template creation is limited to this value.'}`}
              </p>
            </div>
            <div className="grid gap-6 p-5 lg:grid-cols-2">
              <div>
                <p className="mb-3 font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  Contract limits
                </p>
                <div className="space-y-2">
                  {organization.limits.map((limit) => (
                    <div
                      key={limit.id}
                      className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 text-xs"
                    >
                      <span>
                        {limit.key}{' '}
                        <span className="font-mono text-text-muted">
                          {limit.value.toLocaleString()} {limit.period ?? ''}
                        </span>
                      </span>
                      <PlatformCommandButton
                        action="organization.limit.remove"
                        label="Remove"
                        tone="danger"
                        confirm={`Remove the ${limit.key} limit?`}
                        payload={{ id: limit.id }}
                      />
                    </div>
                  ))}
                  {!organization.limits.length ? (
                    <p className="text-xs text-text-muted">No custom limits.</p>
                  ) : null}
                </div>
              </div>
              <PlatformCommandForm
                compact
                action="organization.limit"
                submitLabel="Set limit"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'key',
                    minLength: 2,
                    maxLength: 100,
                    label: 'Limit key',
                    required: true,
                    placeholder: 'storage_gb',
                  },
                  { name: 'value', label: 'Value', type: 'number', required: true, min: 0 },
                  { name: 'period', maxLength: 5000, label: 'Period', placeholder: 'month' },
                  {
                    name: 'source',
                    minLength: 2,
                    maxLength: 100,
                    label: 'Source',
                    defaultValue: 'CONTRACT',
                  },
                ]}
              />
            </div>
          </section>

          <section
            id="people"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Access administration
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">People and roles</h2>
              <p className="mt-1 text-xs text-text-muted">
                Seat state, system role, custom capability bundles, and time-boxed user overrides.
              </p>
            </div>
            <div className="divide-y divide-border-subtle">
              {organization.users.map((user) => (
                <details key={user.id} className="group">
                  <summary className="grid cursor-pointer list-none gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                    <div>
                      <p className="text-sm font-semibold">{user.name}</p>
                      <p className="mt-1 text-[10px] text-text-muted">
                        {user.email} · {user.title}
                      </p>
                    </div>
                    <span className="font-mono text-[9px] text-text-muted">{user.role}</span>
                    <PlatformStatus value={user.status} />
                  </summary>
                  <div className="grid gap-5 border-t border-border-subtle bg-surface-sunken/30 px-5 lg:grid-cols-2">
                    <PlatformCommandForm
                      compact
                      action="organization.user"
                      submitLabel="Update user"
                      fields={[
                        { name: 'id', label: 'User', type: 'hidden', defaultValue: user.id },
                        {
                          name: 'role',
                          label: 'System role',
                          type: 'select',
                          required: true,
                          defaultValue: user.role,
                          options: ['ADMIN', 'HR', 'EMPLOYEE'].map((value) => ({
                            label: value,
                            value,
                          })),
                        },
                        {
                          name: 'status',
                          label: 'Account status',
                          type: 'select',
                          required: true,
                          defaultValue: user.status,
                          options: ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'INVITED'].map((value) => ({
                            label: value,
                            value,
                          })),
                        },
                        {
                          name: 'organizationRoleId',
                          label: 'Custom role',
                          type: 'select',
                          defaultValue: user.organizationRoleId,
                          options: organization.roles.map((role) => ({
                            label: role.name,
                            value: role.id,
                          })),
                        },
                        {
                          name: 'title',
                          minLength: 1,
                          maxLength: 500,
                          label: 'Title',
                          defaultValue: user.title,
                        },
                        {
                          name: 'department',
                          label: 'Department',
                          type: 'select',
                          defaultValue: user.department,
                          options: organization.departments.map((department) => ({
                            label: department.name,
                            value: department.key,
                          })),
                        },
                      ]}
                    />
                    <PlatformCommandForm
                      compact
                      action="organization.user.password"
                      submitLabel="Reset password"
                      fields={[
                        { name: 'id', label: 'User', type: 'hidden', defaultValue: user.id },
                        {
                          name: 'password',
                          minLength: 12,
                          maxLength: 256,
                          label: 'Temporary password',
                          type: 'password',
                          required: true,
                          help: 'Minimum 12 characters. Existing sessions are revoked.',
                        },
                      ]}
                    />
                  </div>
                </details>
              ))}
            </div>
            <div className="grid gap-6 border-t border-border-subtle p-5 lg:grid-cols-2">
              <PlatformCommandForm
                compact
                action="organization.role"
                submitLabel="Create role"
                title="Custom role"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'key',
                    minLength: 2,
                    maxLength: 80,
                    pattern: '[a-z0-9._\\-]+',
                    label: 'Role key',
                    required: true,
                    placeholder: 'delivery-lead',
                  },
                  {
                    name: 'name',
                    minLength: 1,
                    maxLength: 500,
                    label: 'Role name',
                    required: true,
                  },
                  {
                    name: 'description',
                    maxLength: 5000,
                    label: 'Description',
                    type: 'textarea',
                  },
                  {
                    name: 'permissions',
                    label: 'Capability rules',
                    type: 'json',
                    defaultValue: [{ capability: 'projects:write', effect: 'ALLOW' }],
                  },
                ]}
              />
              <PlatformCommandForm
                compact
                action="organization.permission"
                submitLabel="Set override"
                title="User permission override"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'userId',
                    label: 'User',
                    type: 'select',
                    required: true,
                    options: organization.users.map((user) => ({
                      label: `${user.name} · ${user.email}`,
                      value: user.id,
                    })),
                  },
                  {
                    name: 'capability',
                    minLength: 1,
                    maxLength: 150,
                    label: 'Capability',
                    required: true,
                  },
                  {
                    name: 'effect',
                    label: 'Effect',
                    type: 'select',
                    required: true,
                    options: ['ALLOW', 'DENY'].map((value) => ({ label: value, value })),
                  },
                  { name: 'expiresAt', label: 'Expires', type: 'datetime-local' },
                  {
                    name: 'reason',
                    minLength: 5,
                    maxLength: 500,
                    label: 'Reason',
                    type: 'textarea',
                    required: true,
                  },
                ]}
              />
            </div>
            <div className="border-t border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                Role ledger
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {organization.roles.map((role) => (
                  <details key={role.id} className="group border border-border-subtle p-3 text-xs">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold">{role.name}</span>
                        <span className="font-mono text-[9px]">{role._count.users} users</span>
                      </div>
                      <p className="mt-2 text-[10px] text-text-muted">
                        {role.permissions
                          .map((permission) => `${permission.effect} ${permission.capability}`)
                          .join(' · ') || 'No capability rules'}
                      </p>
                    </summary>
                    <div className="mt-3 border-t border-border-subtle pt-2">
                      {!role.isSystem ? (
                        <>
                          <PlatformCommandForm
                            compact
                            action="organization.role"
                            submitLabel="Update role"
                            fields={[
                              { name: 'id', label: 'Role', type: 'hidden', defaultValue: role.id },
                              {
                                name: 'organizationId',
                                label: 'Organization',
                                type: 'hidden',
                                defaultValue: organization.id,
                              },
                              {
                                name: 'key',
                                minLength: 2,
                                maxLength: 80,
                                pattern: '[a-z0-9._\\-]+',
                                label: 'Role key',
                                required: true,
                                defaultValue: role.key,
                              },
                              {
                                name: 'name',
                                minLength: 1,
                                maxLength: 500,
                                label: 'Role name',
                                required: true,
                                defaultValue: role.name,
                              },
                              {
                                name: 'description',
                                maxLength: 5000,
                                label: 'Description',
                                type: 'textarea',
                                defaultValue: role.description,
                              },
                              {
                                name: 'permissions',
                                label: 'Capability rules',
                                type: 'json',
                                defaultValue: role.permissions.map((permission) => ({
                                  capability: permission.capability,
                                  effect: permission.effect,
                                })),
                              },
                            ]}
                          />
                        </>
                      ) : (
                        <p className="py-3 text-[10px] text-text-muted">
                          This bootstrap role is protected. Create a custom role for editable
                          capability rules.
                        </p>
                      )}
                      {!role.isSystem ? (
                        <div className="flex justify-end border-t border-border-subtle pt-3">
                          <PlatformCommandButton
                            action="organization.role.remove"
                            label="Remove role"
                            tone="danger"
                            confirm={`Remove ${role.name}? Assigned users must be reassigned first.`}
                            payload={{ id: role.id }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            </div>
            <div className="border-t border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                User override ledger
              </p>
              <div className="mt-3 space-y-2">
                {organization.permissionOverrides.map((override) => (
                  <div
                    key={override.id}
                    className="flex flex-wrap items-center justify-between gap-3 border border-border-subtle p-3 text-xs"
                  >
                    <div>
                      <p className="font-semibold">
                        {override.user.name} · {override.effect} {override.capability}
                      </p>
                      <p className="mt-1 text-[10px] text-text-muted">
                        {override.reason}
                        {override.expiresAt
                          ? ` · expires ${override.expiresAt.toLocaleString()}`
                          : ' · no expiry'}
                      </p>
                    </div>
                    <PlatformCommandButton
                      action="organization.permission.remove"
                      label="Remove"
                      tone="danger"
                      confirm={`Remove ${override.capability} override for ${override.user.email}?`}
                      payload={{ id: override.id }}
                    />
                  </div>
                ))}
                {!organization.permissionOverrides.length ? (
                  <p className="text-xs text-text-muted">No user-specific overrides.</p>
                ) : null}
              </div>
            </div>
          </section>

          <section id="brand" className="scroll-mt-24">
            <PlatformCommandForm
              action="organization.brand"
              title="Brand and outbound identity"
              description="Controls workspace colors, logo assets, and support sender presentation."
              fields={[
                {
                  name: 'organizationId',
                  label: 'Organization',
                  type: 'hidden',
                  defaultValue: organization.id,
                },
                {
                  name: 'primaryColor',
                  label: 'Primary color',
                  type: 'color',
                  required: true,
                  defaultValue: organization.brand?.primaryColor ?? '#111110',
                },
                {
                  name: 'accentColor',
                  label: 'Accent color',
                  type: 'color',
                  required: true,
                  defaultValue: organization.brand?.accentColor ?? '#FF684F',
                },
                {
                  name: 'logoUrl',
                  maxLength: 2000,
                  label: 'Logo URL',
                  type: 'url',
                  defaultValue: organization.brand?.logoUrl,
                },
                {
                  name: 'markUrl',
                  maxLength: 2000,
                  label: 'Mark URL',
                  type: 'url',
                  defaultValue: organization.brand?.markUrl,
                },
                {
                  name: 'faviconUrl',
                  maxLength: 2000,
                  label: 'Favicon URL',
                  type: 'url',
                  defaultValue: organization.brand?.faviconUrl,
                },
                {
                  name: 'supportEmail',
                  maxLength: 254,
                  label: 'Support email',
                  type: 'email',
                  defaultValue: organization.brand?.supportEmail,
                },
                {
                  name: 'fromName',
                  maxLength: 5000,
                  label: 'From name',
                  defaultValue: organization.brand?.fromName,
                },
              ]}
            />
          </section>

          <section id="email" className="scroll-mt-24">
            <PlatformCommandForm
              action="organization.email"
              title="Organization email delivery"
              description="Sender identity and provider credentials are organization-scoped. API keys are encrypted before storage and never displayed again."
              fields={[
                {
                  name: 'organizationId',
                  label: 'Organization',
                  type: 'hidden',
                  defaultValue: organization.id,
                },
                {
                  name: 'provider',
                  minLength: 2,
                  maxLength: 80,
                  label: 'Provider',
                  required: true,
                  defaultValue: organization.emailSettings?.provider ?? 'PLATFORM',
                },
                {
                  name: 'fromName',
                  maxLength: 5000,
                  label: 'From name',
                  defaultValue: organization.emailSettings?.fromName,
                },
                {
                  name: 'fromAddress',
                  maxLength: 254,
                  label: 'From address',
                  type: 'email',
                  defaultValue: organization.emailSettings?.fromAddress,
                },
                {
                  name: 'replyTo',
                  maxLength: 254,
                  label: 'Reply-to',
                  type: 'email',
                  defaultValue: organization.emailSettings?.replyTo,
                },
                {
                  name: 'apiKey',
                  minLength: 8,
                  maxLength: 2000,
                  label: 'Provider API key',
                  type: 'password',
                  help: organization.emailSettings?.encryptedApiKey
                    ? 'A key is stored. Leave blank to keep it unchanged.'
                    : 'Requires PLATFORM_ENCRYPTION_KEY in the runtime.',
                },
                {
                  name: 'configuration',
                  label: 'Provider configuration',
                  type: 'json',
                  defaultValue:
                    (organization.emailSettings?.configuration as Record<string, unknown>) ?? {},
                },
                {
                  name: 'markVerified',
                  label: 'Sender domain verified',
                  type: 'checkbox',
                  defaultValue: Boolean(organization.emailSettings?.domainVerifiedAt),
                },
              ]}
            />
          </section>

          <section
            id="domains"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Domains</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {organization.domains.map((domain) => (
                <div
                  key={domain.id}
                  className="flex items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{domain.host}</p>
                    <p className="mt-1 font-mono text-[9px] text-text-muted">
                      {domain.kind} {domain.isPrimary ? '· primary' : ''}
                    </p>
                    {domain.verificationStatus !== 'VERIFIED' ? (
                      <p className="mt-2 break-all font-mono text-[9px] text-text-muted">
                        TXT _devfathom-verification.{domain.host} = {domain.verificationToken}
                      </p>
                    ) : null}
                    {domain.failureReason ? (
                      <p className="mt-1 text-[10px] text-destructive">{domain.failureReason}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <PlatformStatus value={domain.verificationStatus} />
                    {domain.verificationStatus !== 'VERIFIED' ? (
                      <>
                        <PlatformCommandButton
                          action="organization.domain.retry"
                          label="Verify DNS"
                          tone="default"
                          payload={{ id: domain.id }}
                        />
                        <PlatformCommandButton
                          action="organization.domain.status"
                          label="Mark verified"
                          tone="quiet"
                          payload={{ id: domain.id, status: 'VERIFIED' }}
                        />
                      </>
                    ) : null}
                    {!domain.isPrimary ? (
                      <PlatformCommandButton
                        action="organization.domain.remove"
                        label="Remove"
                        tone="danger"
                        confirm={`Remove ${domain.host}?`}
                        payload={{ id: domain.id, reason: 'Removed by platform operator' }}
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-border-subtle p-5">
              <PlatformCommandForm
                compact
                action="organization.domain"
                submitLabel="Add domain"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'host',
                    maxLength: 253,
                    // The server trims and lowercases before validating.
                    pattern:
                      '\\s*(?:[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}\\s*',
                    label: 'Hostname',
                    required: true,
                    placeholder: 'hub.client.com',
                  },
                  {
                    name: 'kind',
                    minLength: 2,
                    maxLength: 30,
                    label: 'Kind',
                    defaultValue: 'APP',
                  },
                  { name: 'isPrimary', label: 'Primary domain', type: 'checkbox' },
                ]}
              />
            </div>
          </section>

          <section
            id="identity"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Identity connections</h2>
              <p className="mt-1 text-xs text-text-muted">
                OIDC and SAML enterprise login controls.
              </p>
            </div>
            <div className="divide-y divide-border-subtle">
              {organization.identityConnections.map((connection) => (
                <details key={connection.id} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5">
                    <div>
                      <p className="text-sm font-semibold">{connection.name}</p>
                      <p className="mt-1 font-mono text-[9px] text-text-muted">
                        {connection.protocol} · {connection.domains.join(', ') || 'No domains'} ·{' '}
                        {connection.enforceSso ? 'enforced' : 'optional'}
                      </p>
                    </div>
                    <PlatformStatus value={connection.status} />
                  </summary>
                  <div className="border-t border-border-subtle bg-surface-sunken/30 px-5">
                    <PlatformCommandForm
                      compact
                      action="organization.identity"
                      submitLabel="Update connection"
                      fields={[
                        {
                          name: 'id',
                          label: 'Connection',
                          type: 'hidden',
                          defaultValue: connection.id,
                        },
                        {
                          name: 'organizationId',
                          label: 'Organization',
                          type: 'hidden',
                          defaultValue: organization.id,
                        },
                        {
                          name: 'name',
                          minLength: 1,
                          maxLength: 500,
                          label: 'Name',
                          required: true,
                          defaultValue: connection.name,
                        },
                        {
                          name: 'protocol',
                          label: 'Protocol',
                          type: 'select',
                          required: true,
                          defaultValue: connection.protocol,
                          options: [
                            { label: 'OpenID Connect', value: 'OIDC' },
                            { label: 'SAML 2.0', value: 'SAML' },
                          ],
                        },
                        {
                          name: 'status',
                          label: 'Status',
                          type: 'select',
                          required: true,
                          defaultValue: connection.status,
                          options: ['DRAFT', 'ACTIVE', 'DISABLED', 'ERROR'].map((value) => ({
                            label: value,
                            value,
                          })),
                        },
                        {
                          name: 'issuer',
                          maxLength: 5000,
                          label: 'Issuer',
                          defaultValue: connection.issuer,
                        },
                        {
                          name: 'clientId',
                          maxLength: 5000,
                          label: 'Client ID',
                          defaultValue: connection.clientId,
                        },
                        {
                          name: 'clientSecret',
                          minLength: 8,
                          maxLength: 2000,
                          label: 'Client secret',
                          type: 'password',
                          help: connection.encryptedClientSecret
                            ? 'A secret is stored. Leave blank to keep it.'
                            : 'Encrypted with PLATFORM_ENCRYPTION_KEY.',
                        },
                        {
                          name: 'discoveryUrl',
                          maxLength: 2000,
                          label: 'Discovery URL',
                          type: 'url',
                          defaultValue: connection.discoveryUrl,
                        },
                        {
                          name: 'ssoUrl',
                          maxLength: 2000,
                          label: 'SAML SSO URL',
                          type: 'url',
                          defaultValue: connection.ssoUrl,
                        },
                        {
                          name: 'entityId',
                          maxLength: 5000,
                          label: 'SP entity ID',
                          defaultValue: connection.entityId,
                        },
                        {
                          name: 'certificate',
                          maxLength: 5000,
                          label: 'IdP certificate',
                          type: 'textarea',
                          defaultValue: connection.certificate,
                        },
                        {
                          name: 'domains',
                          label: 'Allowed domains',
                          type: 'json',
                          defaultValue: connection.domains,
                        },
                        {
                          name: 'roleMappings',
                          label: 'Role mappings',
                          type: 'json',
                          defaultValue: (connection.roleMappings as Record<string, unknown>) ?? {},
                        },
                        {
                          name: 'configuration',
                          label: 'Protocol configuration',
                          type: 'json',
                          defaultValue: (connection.configuration as Record<string, unknown>) ?? {},
                        },
                        {
                          name: 'allowJit',
                          label: 'Allow JIT users',
                          type: 'checkbox',
                          defaultValue: connection.allowJit,
                        },
                        {
                          name: 'enforceSso',
                          label: 'Enforce SSO',
                          type: 'checkbox',
                          defaultValue: connection.enforceSso,
                        },
                      ]}
                    />
                    <div className="grid gap-4 border-t border-border-subtle py-4 sm:grid-cols-2">
                      <PlatformCommandForm
                        compact
                        action="organization.identity.test"
                        submitLabel="Queue test"
                        fields={[
                          {
                            name: 'id',
                            label: 'Connection',
                            type: 'hidden',
                            defaultValue: connection.id,
                          },
                        ]}
                      />
                      <PlatformCommandForm
                        compact
                        action="organization.identity.remove"
                        submitLabel="Remove connection"
                        confirm={`Remove ${connection.name}?`}
                        description={`Remove ${connection.name}? This disconnects the identity provider.`}
                        fields={[
                          {
                            name: 'id',
                            label: 'Connection',
                            type: 'hidden',
                            defaultValue: connection.id,
                          },
                        ]}
                      />
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <div className="border-t border-border-subtle p-5">
              <PlatformCommandForm
                compact
                action="organization.identity"
                submitLabel="Add identity connection"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'name',
                    minLength: 1,
                    maxLength: 500,
                    label: 'Connection name',
                    required: true,
                  },
                  {
                    name: 'protocol',
                    label: 'Protocol',
                    type: 'select',
                    required: true,
                    options: [
                      { label: 'OpenID Connect', value: 'OIDC' },
                      { label: 'SAML 2.0', value: 'SAML' },
                    ],
                  },
                  { name: 'issuer', maxLength: 5000, label: 'Issuer' },
                  { name: 'clientId', maxLength: 5000, label: 'Client ID' },
                  { name: 'discoveryUrl', maxLength: 2000, label: 'Discovery URL', type: 'url' },
                  { name: 'ssoUrl', maxLength: 2000, label: 'SSO URL', type: 'url' },
                  { name: 'entityId', maxLength: 5000, label: 'Entity ID' },
                  {
                    name: 'clientSecret',
                    minLength: 8,
                    maxLength: 2000,
                    label: 'Client secret',
                    type: 'password',
                  },
                  {
                    name: 'certificate',
                    maxLength: 5000,
                    label: 'IdP certificate',
                    type: 'textarea',
                  },
                  { name: 'domains', label: 'Domains', type: 'json', defaultValue: [] },
                  {
                    name: 'status',
                    label: 'Status',
                    type: 'select',
                    required: true,
                    defaultValue: 'DRAFT',
                    options: ['DRAFT', 'ACTIVE', 'DISABLED', 'ERROR'].map((value) => ({
                      label: value,
                      value,
                    })),
                  },
                  {
                    name: 'roleMappings',
                    label: 'Role mappings',
                    type: 'json',
                    defaultValue: {},
                  },
                  {
                    name: 'configuration',
                    label: 'Protocol configuration',
                    type: 'json',
                    defaultValue: { roleClaim: 'groups' },
                  },
                  {
                    name: 'allowJit',
                    label: 'Allow just-in-time users',
                    type: 'checkbox',
                    defaultValue: true,
                  },
                  { name: 'enforceSso', label: 'Enforce SSO', type: 'checkbox' },
                ]}
              />
            </div>
          </section>

          <section id="scim" className="scroll-mt-24 border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Enterprise provisioning
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">SCIM 2.0</h2>
              <p className="mt-1 text-xs text-text-muted">
                Endpoint <span className="font-mono">/api/scim/v2</span>. Tokens are shown once,
                stored as hashes, and can be revoked immediately.
              </p>
            </div>
            <div className="grid gap-6 p-5 lg:grid-cols-2">
              <PlatformCommandForm
                compact
                action="organization.scim.token"
                submitLabel="Create token"
                title="Provisioning token"
                revealResultKey="token"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'hidden',
                    defaultValue: organization.id,
                  },
                  {
                    name: 'name',
                    minLength: 1,
                    maxLength: 500,
                    label: 'Token name',
                    required: true,
                  },
                  { name: 'expiresAt', label: 'Expires', type: 'datetime-local' },
                ]}
              />
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  Active and historical tokens
                </p>
                <div className="mt-3 divide-y divide-border-subtle border border-border-subtle">
                  {organization.scimTokens.map((token) => (
                    <div
                      key={token.id}
                      className="flex flex-col items-stretch justify-between gap-3 p-3 sm:flex-row sm:items-center"
                    >
                      <div>
                        <p className="text-xs font-semibold">{token.name}</p>
                        <p className="mt-1 font-mono text-[9px] text-text-muted">
                          {token.prefix}… · last used{' '}
                          {token.lastUsedAt?.toLocaleString() ?? 'never'}
                        </p>
                        <p className="mt-1 text-[10px] text-text-muted">
                          {token.revokedAt
                            ? `Revoked ${token.revokedAt.toLocaleString()}`
                            : token.expiresAt
                              ? `Expires ${token.expiresAt.toLocaleString()}`
                              : 'No expiry'}
                        </p>
                      </div>
                      {token.revokedAt ? (
                        <PlatformStatus value="REVOKED" />
                      ) : (
                        <PlatformCommandForm
                          compact
                          action="organization.scim.revoke"
                          submitLabel="Revoke token"
                          confirm={`Revoke ${token.name}? Connected directories will stop syncing immediately.`}
                          description={`Revoke ${token.name}? Connected directories will stop syncing immediately.`}
                          fields={[
                            { name: 'id', label: 'Token', type: 'hidden', defaultValue: token.id },
                          ]}
                        />
                      )}
                    </div>
                  ))}
                  {!organization.scimTokens.length ? (
                    <p className="p-3 text-xs text-text-muted">No SCIM tokens issued.</p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="border-t border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                Recent provisioning events
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                    <tr>
                      <th className="pb-2 font-medium">Time</th>
                      <th className="pb-2 font-medium">Operation</th>
                      <th className="pb-2 font-medium">Resource</th>
                      <th className="pb-2 font-medium">External ID</th>
                      <th className="pb-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {organization.scimEvents.map((event) => (
                      <tr key={event.id}>
                        <td className="py-2 font-mono text-[9px] text-text-muted">
                          {event.createdAt.toLocaleString()}
                        </td>
                        <td className="py-2">{event.operation}</td>
                        <td className="py-2">{event.resourceType}</td>
                        <td className="max-w-44 truncate py-2 font-mono text-[9px]">
                          {event.externalId ?? '—'}
                        </td>
                        <td className="py-2 text-right">
                          <PlatformStatus value={event.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!organization.scimEvents.length ? (
                  <p className="py-3 text-xs text-text-muted">No provisioning activity yet.</p>
                ) : null}
              </div>
            </div>
          </section>

          <section
            id="deployment"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Deployments</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {organization.deployments.map((deployment) => (
                <div key={deployment.id} className="p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">{deployment.environment}</p>
                      <p className="mt-1 font-mono text-[9px] text-text-muted">
                        {deployment.mode} · {deployment.provider} ·{' '}
                        {deployment.region ?? 'region pending'}
                      </p>
                    </div>
                    <PlatformStatus value={deployment.status} />
                  </div>
                  <PlatformCommandForm
                    compact
                    action="deployment.update"
                    submitLabel="Update deployment"
                    fields={[
                      {
                        name: 'id',
                        label: 'Deployment',
                        type: 'hidden',
                        defaultValue: deployment.id,
                      },
                      {
                        name: 'status',
                        label: 'Status',
                        type: 'select',
                        required: true,
                        defaultValue: deployment.status,
                        options: [
                          'PENDING',
                          'PROVISIONING',
                          'READY',
                          'DEGRADED',
                          'FAILED',
                          'DECOMMISSIONED',
                        ].map((value) => ({ label: value, value })),
                      },
                      {
                        name: 'provider',
                        minLength: 2,
                        maxLength: 80,
                        label: 'Provider',
                        defaultValue: deployment.provider,
                      },
                      {
                        name: 'projectId',
                        maxLength: 5000,
                        label: 'Project ID',
                        defaultValue: deployment.projectId,
                      },
                      {
                        name: 'region',
                        maxLength: 5000,
                        label: 'Region',
                        defaultValue: deployment.region,
                      },
                      {
                        name: 'url',
                        maxLength: 2000,
                        label: 'Deployment URL',
                        type: 'url',
                        defaultValue: deployment.url,
                      },
                      {
                        name: 'databaseRef',
                        maxLength: 5000,
                        label: 'Database reference',
                        defaultValue: deployment.databaseRef,
                      },
                      {
                        name: 'edgeConfigRef',
                        maxLength: 5000,
                        label: 'Edge config reference',
                        defaultValue: deployment.edgeConfigRef,
                      },
                      {
                        name: 'version',
                        maxLength: 5000,
                        label: 'Version',
                        defaultValue: deployment.version,
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
          </section>

          <section
            id="commercial"
            className="scroll-mt-24 border border-border-default bg-surface-card"
          >
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Commercial record</h2>
            </div>
            <div className="grid gap-px bg-border-subtle md:grid-cols-2">
              <div className="bg-surface-card p-5">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  Contracts
                </p>
                {organization.contracts.map((contract) => (
                  <div
                    key={contract.id}
                    className="mt-3 border-b border-border-subtle pb-3 text-xs"
                  >
                    <div className="flex justify-between gap-3">
                      <span className="font-semibold">{contract.number}</span>
                      <PlatformStatus value={contract.status} />
                    </div>
                    <p className="mt-1 text-text-muted">
                      {contract.currency} {Number(contract.value).toLocaleString()} · ends{' '}
                      {contract.endDate.toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
              <div className="bg-surface-card p-5">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  Invoices
                </p>
                {organization.invoices.map((invoice) => (
                  <div key={invoice.id} className="mt-3 border-b border-border-subtle pb-3 text-xs">
                    <div className="flex justify-between gap-3">
                      <span className="font-semibold">{invoice.number}</span>
                      <PlatformStatus value={invoice.status} />
                    </div>
                    <p className="mt-1 text-text-muted">
                      {invoice.currency} {Number(invoice.total).toLocaleString()} · due{' '}
                      {invoice.dueAt.toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="audit" className="scroll-mt-24 border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Lifecycle history</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {organization.lifecycleEvents.map((event) => (
                <div
                  key={event.id}
                  className="grid gap-2 px-5 py-3.5 sm:grid-cols-[160px_1fr_auto]"
                >
                  <span className="font-mono text-[9px] text-text-muted">
                    {event.createdAt.toLocaleString()}
                  </span>
                  <div>
                    <p className="text-xs font-semibold">{event.action.replaceAll('_', ' ')}</p>
                    <p className="mt-1 text-xs text-text-muted">{event.reason}</p>
                  </div>
                  <PlatformStatus value={event.toStatus} />
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-7">
          <section className="border border-border-default bg-abyss-900 p-5 text-paper-50">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-primary-foreground">
              Audited support
            </p>
            <h2 className="mt-2 font-display text-xl font-semibold">Enter workspace</h2>
            <p className="mt-2 text-xs leading-5 text-abyss-200">
              Opens a time-boxed session as the tenant administrator. The reason and every action
              are recorded.
            </p>
            <div className="mt-5 [&_textarea]:border-primary-foreground/15 [&_textarea]:bg-primary-foreground/5 [&_textarea]:text-primary-foreground [&_select]:border-primary-foreground/15 [&_select]:bg-primary [&_select]:text-primary-foreground">
              <SupportAccessForm organizationId={organization.id} />
            </div>
          </section>

          <section className="border border-border-default bg-surface-card p-5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
              Tenant administrators
            </p>
            <div className="mt-3 space-y-3">
              {organization.users
                .filter((user) => user.role === 'ADMIN')
                .map((user) => (
                  <div key={user.id} className="border-b border-border-subtle pb-3">
                    <p className="text-xs font-semibold">{user.name}</p>
                    <p className="mt-1 text-[10px] text-text-muted">{user.email}</p>
                    <div className="mt-2">
                      <PlatformStatus value={user.status} />
                    </div>
                  </div>
                ))}
            </div>
          </section>

          <section className="border border-border-default bg-surface-card p-5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
              Provisioning identifiers
            </p>
            <dl className="mt-4 space-y-3 text-xs">
              <div>
                <dt className="text-text-muted">Organization ID</dt>
                <dd className="mt-1 break-all font-mono text-[10px]">{organization.id}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Organization type</dt>
                <dd className="mt-1">
                  {verticalDefinition.label}{' '}
                  <span className="font-mono text-[9px] text-text-faint">immutable</span>
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Package</dt>
                <dd className="mt-1">{organization.package?.name ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Created</dt>
                <dd className="mt-1">{organization.createdAt.toLocaleString()}</dd>
              </div>
            </dl>
          </section>

          {organization.status === 'TERMINATED' ? (
            <section className="border border-destructive bg-red-100 p-5">
              <h2 className="text-sm font-semibold text-destructive">Destructive lifecycle</h2>
              <p className="mt-2 text-xs leading-5 text-text-body">
                Scheduling purge starts the retention window and queues data destruction.
              </p>
              <div className="mt-4">
                <PlatformCommandForm
                  compact
                  action="organization.transition"
                  submitLabel="Schedule purge"
                  confirm="Schedule this organization for purge? This begins the retention countdown."
                  fields={[
                    {
                      name: 'id',
                      label: 'Organization',
                      type: 'hidden',
                      defaultValue: organization.id,
                    },
                    { name: 'status', label: 'Status', type: 'hidden', defaultValue: 'PURGING' },
                  ]}
                />
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
