import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelPropertySettingsForm } from '@/components/hotel/property-settings-form';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Property settings' };

/**
 * PROP-01 — the property settings page.
 *
 * The read runs through the router rather than a direct query, so the page and
 * the API cannot disagree about who may see a property: the same
 * `hotel:property-admin` gate answers both. A caller without it lands on the
 * explanation below instead of an empty form or a raw error.
 */
export default async function HotelPropertySettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | { kind: 'settings'; props: Parameters<typeof HotelPropertySettingsForm>[0] }
    | { kind: 'error'; denied: boolean };
  let branchId: string | undefined;
  try {
    const query = await searchParams;
    branchId = typeof query?.branchId === 'string' ? query.branchId.trim() : undefined;
    const ctx = await createTRPCContext();
    const caller = hotelPropertyRouter.createCaller(ctx);
    if (!branchId) {
      // Reuse the accepted property-admin choices; listing never selects a default.
      const available = await caller.extras.properties();
      view = { kind: 'choices', properties: available.properties };
    } else {
      await caller.access.select({ branchId, capability: 'hotel:property-admin' });
      const initial = await caller.get({ branchId });
      view = {
        kind: 'settings',
        props: {
          initial,
          selection: {
            branchId,
            organizationId: ctx.session!.user.organizationId,
            userId: ctx.session!.user.id,
          },
        },
      };
    }
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    view = {
      kind: 'error',
      denied: code === 'FORBIDDEN' || code === 'UNAUTHORIZED' || code === 'NOT_FOUND',
    };
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Hospitality"
        heading="Property settings"
        description="How this property operates, and the facts every reservation, folio and audit is dated and taxed against."
      />
      {view.kind === 'settings' ? (
        <HotelPropertySettingsForm {...view.props} />
      ) : view.kind === 'choices' ? (
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/property"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="settings-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="settings-property"
                  name="branchId"
                  defaultValue=""
                  required
                  className="mt-2 h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="" disabled>
                    Select a property
                  </option>
                  {view.properties.map((property) => (
                    <option key={property.branchId} value={property.branchId}>
                      {property.name}
                    </option>
                  ))}
                </StudioSelect>
              </div>
              <button type="submit" className={buttonVariants({ className: 'min-h-11' })}>
                Open property settings
              </button>
            </form>
          ) : (
            <p className="text-sm text-text-muted">
              No properties are available for you to manage. Ask your workspace administrator for a
              property assignment and property administration access.
            </p>
          )}
        </SectionCard>
      ) : (
        <SectionCard
          title={
            view.denied ? 'This page is not available to you' : 'Could not load property settings'
          }
          titleLevel={2}
        >
          <p className="text-sm text-text-muted">
            {view.denied
              ? 'Choose a property you can manage, or ask your workspace administrator for property administration access.'
              : 'Property settings could not be fetched. Reload to try again.'}
          </p>
          <a
            href={
              !view.denied && branchId
                ? `/hotel/settings/property?branchId=${encodeURIComponent(branchId)}`
                : '/hotel/settings/property'
            }
            className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
          >
            {view.denied ? 'Choose another property' : 'Retry loading settings'}
          </a>
        </SectionCard>
      )}
    </main>
  );
}
