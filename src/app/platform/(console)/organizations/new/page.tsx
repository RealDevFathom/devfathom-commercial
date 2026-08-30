import Link from 'next/link';
import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import {
  ALL_VERTICALS,
  VERTICALS,
  mandatoryModulesForVertical,
  type OrganizationVertical,
} from '@/lib/vertical-catalog';

/**
 * §2 — onboarding is type-first. The operator picks the organization type before
 * any commercial choice exists, and nothing is preselected: `vertical` is read
 * from the query string and only an exact catalog match counts as a decision, so
 * a missing, empty, or crafted value falls back to the chooser rather than
 * silently onboarding an AGENCY (the server-side default in `organizationInput`).
 */
function chosenVertical(raw: string | undefined): OrganizationVertical | null {
  return ALL_VERTICALS.find((vertical) => vertical === raw) ?? null;
}

function stepUrl(vertical: OrganizationVertical | null, opportunityId: string | undefined) {
  const query = new URLSearchParams();
  if (vertical) query.set('vertical', vertical);
  if (opportunityId) query.set('opportunityId', opportunityId);
  const search = query.toString();
  return search ? `/platform/organizations/new?${search}` : '/platform/organizations/new';
}

export default async function NewOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string; vertical?: string }>;
}) {
  await requirePlatformRead('/platform/organizations');
  const query = await searchParams;
  const vertical = chosenVertical(query.vertical);

  // §2 — the package query is deferred until a type exists and is filtered
  // server-side by that type. The operator is never shown, and can never submit,
  // a package belonging to the other vertical (the command re-checks this).
  const packages = vertical
    ? await withPlatformDb((db) =>
        db.platformPackage.findMany({
          where: { active: true, vertical },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, defaultSeats: true },
        })
      )
    : [];

  if (!vertical) {
    return (
      <div className="mx-auto max-w-5xl [&_.text-text-faint]:text-text-body [&_.text-text-muted]:text-text-body [&_[data-slot=eyebrow]]:text-text-body dark:[&_[data-slot=eyebrow]]:text-accent-brand">
        <PlatformPageHeading
          eyebrow="Organizations / onboarding"
          title="Onboard an organization"
          description="Choose the organization type first. The type determines the commercial packages, modules, and workspace surfaces available, and it cannot be changed once the organization is activated."
        />
        <section
          aria-labelledby="organization-type"
          className="mt-7 border border-border-default bg-surface-card"
        >
          <div className="border-b border-border-subtle px-5 py-4">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
              Step 1 of 2
            </p>
            <h2 id="organization-type" className="mt-1 font-display text-xl font-semibold">
              Organization type
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              No type is preselected. Nothing is created until the onboarding form is submitted.
            </p>
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {ALL_VERTICALS.map((option) => (
              <Link
                key={option}
                href={stepUrl(option, query.opportunityId)}
                className="group block border border-border-default bg-surface-card p-5 transition hover:border-accent-brand hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                  {option}
                </p>
                <p className="mt-2 text-sm font-semibold text-text-strong">
                  {VERTICALS[option].label}
                </p>
                <p className="mt-2 text-xs leading-5 text-text-muted">
                  {VERTICALS[option].description}
                </p>
                <span className="mt-4 inline-block text-xs font-semibold text-accent-brand">
                  Continue as {VERTICALS[option].label} →
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    );
  }

  const definition = VERTICALS[vertical];
  const mandatory = mandatoryModulesForVertical(vertical);

  return (
    <div className="mx-auto max-w-5xl [&_.text-text-faint]:text-text-body [&_.text-text-muted]:text-text-body [&_[data-slot=eyebrow]]:text-text-body dark:[&_[data-slot=eyebrow]]:text-accent-brand">
      <PlatformPageHeading
        eyebrow="Organizations / onboarding"
        title="Onboard an organization"
        description="Creates the tenant boundary, first administrator, package entitlements, default brand and email records, production deployment, and provisioning job. Activation remains manual."
      />

      <section
        aria-labelledby="chosen-type"
        className="mt-7 flex flex-wrap items-center justify-between gap-3 border border-border-default bg-surface-sunken px-5 py-4"
      >
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">
            Step 2 of 2 · organization type
          </p>
          <h2 id="chosen-type" className="mt-1 text-sm font-semibold text-text-strong">
            {definition.label}
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            {definition.description}
            {mandatory.length
              ? ` ${mandatory.map((module) => module.name).join(', ')} is always enabled.`
              : ''}
          </p>
        </div>
        <Link
          href={stepUrl(null, query.opportunityId)}
          className="inline-flex min-h-10 items-center border border-border-default bg-surface-card px-3 text-xs font-semibold text-text-body transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Change type
        </Link>
      </section>

      {!packages.length ? (
        <section className="mt-7 border border-border-default bg-surface-card p-5">
          <h2 className="font-display text-xl font-semibold">No commercial package available</h2>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            No active package is published for the {definition.label} vertical, so an organization
            of this type cannot be onboarded yet. Publish a {definition.label} package first, or
            change the organization type. Nothing has been created.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/platform/catalog"
              className="inline-flex min-h-10 items-center border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Modules and plans
            </Link>
            <Link
              href={stepUrl(null, query.opportunityId)}
              className="inline-flex min-h-10 items-center border border-border-default bg-surface-card px-3 text-xs font-semibold text-text-body transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Change type
            </Link>
          </div>
        </section>
      ) : (
        <div className="mt-7">
          <PlatformCommandForm
            action="organization.create"
            submitLabel="Create onboarding record"
            onSuccessPath="/platform/organizations/[id]"
            title="Organization and tenant owner"
            description="The workspace stays in onboarding until an operator completes activation preflight."
            fields={[
              {
                name: 'opportunityId',
                label: 'Opportunity',
                type: 'hidden',
                defaultValue: query.opportunityId,
              },
              // §2 — the chosen type is submitted explicitly rather than relying on
              // the command's AGENCY default, so the stamped vertical is always the
              // one the operator saw when choosing a package.
              {
                name: 'vertical',
                label: 'Organization type',
                type: 'hidden',
                defaultValue: vertical,
              },
              { name: 'displayName', label: 'Display name', required: true },
              { name: 'legalName', label: 'Legal name', required: true },
              {
                name: 'slug',
                label: 'Workspace slug',
                required: true,
                placeholder: 'northwind-agency',
                help: 'Lowercase letters, numbers, and hyphens.',
              },
              {
                name: 'deploymentMode',
                label: 'Deployment mode',
                type: 'select',
                required: true,
                defaultValue: 'SHARED',
                options: [
                  { label: 'Shared platform', value: 'SHARED' },
                  { label: 'Dedicated enterprise', value: 'DEDICATED' },
                ],
              },
              {
                name: 'packageId',
                label: 'Commercial package',
                type: 'select',
                required: true,
                help: `Only active ${definition.label} packages are listed.`,
                options: packages.map((item) => ({
                  label: `${item.name} · ${item.defaultSeats} default seats`,
                  value: item.id,
                })),
              },
              {
                name: 'seatLimit',
                label: 'Seat limit',
                type: 'number',
                required: true,
                defaultValue: packages[0]?.defaultSeats ?? 5,
                min: 1,
                max: 100000,
              },
              { name: 'currency', label: 'Currency', required: true, defaultValue: 'USD' },
              { name: 'timezone', label: 'Timezone', required: true, defaultValue: 'UTC' },
              { name: 'locale', label: 'Locale', required: true, defaultValue: 'en' },
              {
                name: 'gracePeriodDays',
                label: 'Grace period (days)',
                type: 'number',
                defaultValue: 0,
                min: 0,
                max: 365,
              },
              { name: 'dataResidency', label: 'Data residency', placeholder: 'EU, US, PK…' },
              { name: 'primaryContactName', label: 'Primary contact', required: true },
              {
                name: 'primaryContactEmail',
                label: 'Primary contact email',
                type: 'email',
                required: true,
              },
              { name: 'adminName', label: 'Tenant administrator', required: true },
              { name: 'adminEmail', label: 'Administrator email', type: 'email', required: true },
              {
                name: 'adminPassword',
                label: 'Temporary administrator password',
                type: 'password',
                required: true,
                help: 'At least 12 characters. Share through an approved secure channel.',
              },
              { name: 'notes', label: 'Operator notes', type: 'textarea' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
