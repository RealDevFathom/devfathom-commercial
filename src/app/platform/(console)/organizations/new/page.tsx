import Link from 'next/link';
import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { isDedicatedProvisioningConfigured } from '@/lib/platform/provisioning-config';
import { ianaTimezoneOptions } from '@/lib/platform/timezones';
import { PAKISTAN_PROVINCES } from '@/lib/pharmacy/regulatory-profile-form';
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
  const actor = await requirePlatformRead('/platform/organizations');
  const query = await searchParams;
  const dedicatedProvisioningConfigured = isDedicatedProvisioningConfigured();
  const vertical = chosenVertical(query.vertical);
  const timezoneOptions = ianaTimezoneOptions();

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
        <div className="mt-7 space-y-5">
          {vertical === 'RESTAURANT' ? (
            <section
              aria-labelledby="restaurant-activation-preview"
              className="border border-border-default bg-surface-sunken p-4"
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                After this form
              </p>
              <h2
                id="restaurant-activation-preview"
                className="mt-1 font-display text-base font-semibold text-text-strong"
              >
                This creates an onboarding record, not an active restaurant
              </h2>
              <p className="mt-2 text-xs leading-5 text-text-body">
                The organization will open in <strong>ONBOARDING</strong> with its first branch,
                administrator, package entitlements, and a pending production deployment.
              </p>
              <ol className="mt-3 grid gap-2 text-xs leading-5 text-text-body sm:grid-cols-2">
                <li className="border-l-2 border-border-strong pl-3">
                  <strong className="block text-text-strong">1. Confirm readiness</strong>
                  Review branch details and acknowledge the tax, payment, device, and operator
                  policies.
                </li>
                <li className="border-l-2 border-border-strong pl-3">
                  <strong className="block text-text-strong">2. Finish deployment</strong>
                  Wait for or complete the production deployment until it is ready.
                </li>
                <li className="border-l-2 border-border-strong pl-3 sm:col-span-2">
                  <strong className="block text-text-strong">3. Activate manually</strong>
                  Verify the lifecycle gate, then apply the change to ACTIVE from the organization
                  detail page.
                </li>
              </ol>
            </section>
          ) : null}
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
              {
                name: 'displayName',
                minLength: 1,
                maxLength: 500,
                label: 'Display name',
                required: true,
              },
              {
                name: 'legalName',
                minLength: 1,
                maxLength: 500,
                label: 'Legal name',
                required: true,
              },
              {
                name: 'slug',
                minLength: 3,
                maxLength: 63,
                // The server trims and lowercases before validating.
                pattern: '\\s*[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\\s*',
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
                help: dedicatedProvisioningConfigured
                  ? 'Dedicated enterprise creates an isolated Vercel deployment.'
                  : 'Dedicated enterprise is unavailable until Vercel provisioning is configured for this environment.',
                options: [
                  { label: 'Shared platform', value: 'SHARED' },
                  ...(dedicatedProvisioningConfigured
                    ? [{ label: 'Dedicated enterprise', value: 'DEDICATED' }]
                    : []),
                ],
              },
              {
                name: 'packageId',
                label: 'Commercial package',
                type: 'select',
                required: true,
                help: `Only active ${definition.label} packages are listed.`,
                options: packages.map((item) => ({
                  label: `${item.name} · ${item.defaultSeats} default seat${
                    item.defaultSeats === 1 ? '' : 's'
                  }`,
                  value: item.id,
                })),
              },
              {
                name: 'seatLimit',
                label: 'Seat limit',
                type: 'number',
                required: true,
                defaultValue: packages[0]?.defaultSeats ?? 5,
                disabled: actor.role !== 'SUPER_ADMIN',
                help: 'Only a platform super admin can override seats, up to the package limit.',
                defaultFrom: {
                  field: 'packageId',
                  values: Object.fromEntries(packages.map((item) => [item.id, item.defaultSeats])),
                },
                min: 1,
                max: 100000,
              },
              {
                name: 'currency',
                minLength: 3,
                maxLength: 3,
                label: 'Currency',
                required: true,
                // A pharmacy launches in the Pakistan market (its province list is
                // Pakistan), so it starts on PKR rather than the commercial USD
                // default the operator would otherwise have to override by hand.
                defaultValue: vertical === 'PHARMACY' ? 'PKR' : 'USD',
              },
              {
                name: 'timezone',
                label: 'Timezone',
                type: 'searchable-select',
                required: true,
                // A hospitality property dates its business days, audit and
                // cut-offs in this zone, so it starts on the launch market's
                // rather than on UTC. A pharmacy launches in the same Pakistan
                // market, so it defaults to Asia/Karachi too.
                defaultValue:
                  vertical === 'RESTAURANT' || vertical === 'HOSPITALITY' || vertical === 'PHARMACY'
                    ? 'Asia/Karachi'
                    : 'UTC',
                help: 'Search by city or IANA name. Timezones are grouped by region.',
                options: timezoneOptions,
              },
              ...(vertical === 'RESTAURANT'
                ? [
                    {
                      name: 'firstBranchName',
                      minLength: 2,
                      maxLength: 120,
                      label: 'First branch name',
                      required: true,
                      placeholder: 'Downtown',
                      help: '2–120 characters. The stable branch code remains MAIN.',
                    },
                    {
                      name: 'firstBranchAddress',
                      minLength: 1,
                      maxLength: 300,
                      label: 'First branch address',
                      required: true,
                      placeholder: 'Street, city, region',
                    },
                    {
                      name: 'businessDayCutoff',
                      label: 'Business day cutoff',
                      required: true,
                      format: 'time24' as const,
                      help: 'Use 24-hour time in the organization timezone, e.g. 09:30.',
                    },
                  ]
                : []),
              // WHA-1206 — a pharmacy is provisioned with its first branch too,
              // and the premises columns it needs are not the restaurant's. The
              // province is asked for here because it selects the jurisdiction
              // whose published rules the branch's licence is later validated
              // against, on the regulatory profile page.
              ...(vertical === 'PHARMACY'
                ? [
                    {
                      name: 'firstBranchName',
                      minLength: 2,
                      maxLength: 120,
                      label: 'First branch name',
                      required: true,
                      placeholder: 'Clifton Chemist',
                      help: '2–120 characters. The stable branch code remains MAIN.',
                    },
                    {
                      name: 'firstBranchAddress',
                      minLength: 1,
                      maxLength: 300,
                      label: 'First branch address',
                      required: true,
                      placeholder: 'Street and building',
                    },
                    {
                      name: 'firstBranchCity',
                      minLength: 1,
                      maxLength: 120,
                      label: 'First branch city',
                      required: true,
                    },
                    {
                      name: 'firstBranchProvinceCode',
                      label: 'First branch province',
                      type: 'select' as const,
                      required: true,
                      help: 'Sets the jurisdiction the branch licence is recorded under.',
                      options: Object.entries(PAKISTAN_PROVINCES).map(([value, label]) => ({
                        label,
                        value,
                      })),
                    },
                  ]
                : []),
              // H1-01 — a hospitality organization is provisioned with its first
              // property, and the property row IS its branch. It needs the same
              // premises facts as a pharmacy minus the province: a property is
              // not licensed per jurisdiction, so there is nothing for a province
              // to select here.
              ...(vertical === 'HOSPITALITY'
                ? [
                    {
                      name: 'firstBranchName',
                      minLength: 2,
                      maxLength: 120,
                      label: 'First property name',
                      required: true,
                      placeholder: 'Serena Gulberg',
                      help: '2–120 characters. Also names the property’s direct booking page.',
                    },
                    {
                      name: 'firstBranchAddress',
                      minLength: 1,
                      maxLength: 300,
                      label: 'First property address',
                      required: true,
                      placeholder: 'Street and building',
                    },
                    {
                      name: 'firstBranchCity',
                      minLength: 1,
                      maxLength: 120,
                      label: 'First property city',
                      required: true,
                    },
                  ]
                : []),
              {
                name: 'locale',
                minLength: 2,
                maxLength: 20,
                label: 'Locale',
                required: true,
                defaultValue: 'en',
              },
              {
                name: 'gracePeriodDays',
                label: 'Grace period (days)',
                type: 'number',
                defaultValue: 0,
                min: 0,
                max: 365,
              },
              {
                name: 'dataResidency',
                maxLength: 5000,
                label: 'Data residency',
                placeholder: 'EU, US, PK…',
              },
              {
                name: 'primaryContactName',
                minLength: 1,
                maxLength: 500,
                label: 'Primary contact',
                required: true,
              },
              {
                name: 'primaryContactEmail',
                maxLength: 254,
                label: 'Primary contact email',
                type: 'email',
                required: true,
              },
              {
                name: 'adminName',
                minLength: 1,
                maxLength: 500,
                label: 'Tenant administrator',
                required: true,
              },
              {
                name: 'adminEmail',
                maxLength: 254,
                label: 'Administrator email',
                type: 'email',
                required: true,
              },
              {
                name: 'adminPassword',
                minLength: 12,
                maxLength: 256,
                label: 'Temporary administrator password',
                type: 'password',
                required: true,
                help: 'At least 12 characters. Share through an approved secure channel.',
              },
              { name: 'notes', maxLength: 5000, label: 'Operator notes', type: 'textarea' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
