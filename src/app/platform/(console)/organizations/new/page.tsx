import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export default async function NewOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string }>;
}) {
  const query = await searchParams;
  const packages = await withPlatformDb((db) =>
    db.platformPackage.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, defaultSeats: true },
    })
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PlatformPageHeading
        eyebrow="Organizations / onboarding"
        title="Onboard an organization"
        description="Creates the tenant boundary, first administrator, package entitlements, default brand and email records, production deployment, and provisioning job. Activation remains manual."
      />
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
    </div>
  );
}
