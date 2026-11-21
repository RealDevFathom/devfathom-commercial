import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelExtrasCatalog } from '@/components/hotel/extras-catalog';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Extras and services' };

/**
 * PROP-05 — the extras and services catalog page.
 *
 * The read runs through the router rather than a direct query, for the same
 * reason the property settings page does: one `hotel:property-admin` gate answers
 * both the page and the API, so they cannot disagree about who may see a catalog.
 * A caller without it — or a workspace with no property yet — lands on an
 * explanation instead of an empty table or a raw error.
 */
export default async function HotelExtrasSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | {
        kind: 'catalog';
        initial: Parameters<typeof HotelExtrasCatalog>[0]['initial'];
        selection: Parameters<typeof HotelExtrasCatalog>[0]['selection'];
        propertyName: string;
      };
  let branchId: string | undefined;
  let catalogCallerReady = false;
  try {
    const query = await searchParams;
    branchId = typeof query?.branchId === 'string' ? query.branchId.trim() : undefined;
    const ctx = await createTRPCContext();
    const caller = hotelPropertyRouter.createCaller(ctx);
    catalogCallerReady = true;
    if (!branchId) {
      const available = await caller.extras.properties();
      view = { kind: 'choices', properties: available.properties };
    } else {
      const property = await caller.access.select({ branchId, capability: 'hotel:property-admin' });
      const initial = await caller.extras.list({
        branchId,
        includeInactive: false,
        upsellableOnly: false,
      });
      const selection = {
        branchId,
        organizationId: ctx.session!.user.organizationId,
        userId: ctx.session!.user.id,
      };
      view = { kind: 'catalog', initial, selection, propertyName: property.name };
    }
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    const denied = code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
    const missingProperty = catalogCallerReady && code === 'NOT_FOUND';
    const title = denied
      ? 'You cannot manage this catalog'
      : missingProperty
        ? 'Choose another property'
        : 'Could not load the extras catalog';
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Hospitality"
          heading="Extras and services"
          description="What this property charges for beyond the room, and how each charge is taxed and reported."
        />
        <SectionCard title={title} titleLevel={2}>
          <p className="text-sm text-text-muted">
            {denied
              ? 'Sign in with a session that can manage this property, or ask your workspace administrator for property administration access.'
              : missingProperty
                ? 'The selected property is no longer available. Choose a property you can manage.'
                : 'The catalog could not be fetched. Reload to try again; your saved charges have not changed.'}
          </p>
          {!denied && !missingProperty ? (
            <a
              href={
                branchId
                  ? `/hotel/settings/extras?branchId=${encodeURIComponent(branchId)}`
                  : '/hotel/settings/extras'
              }
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Retry loading catalog
            </a>
          ) : null}
          {denied || missingProperty ? (
            <a
              href="/hotel/settings/extras"
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Choose another property
            </a>
          ) : null}
        </SectionCard>
      </main>
    );
  }

  if (view.kind === 'choices') {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Hospitality"
          heading="Extras and services"
          description="Choose the property whose extras catalog you want to manage."
        />
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/extras"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="extras-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="extras-property"
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
                Open catalog
              </button>
            </form>
          ) : (
            <p className="text-sm text-text-muted">
              No properties are available for you to manage. Ask your workspace administrator for a
              property assignment and property administration access.
            </p>
          )}
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Hospitality"
        heading="Extras and services"
        description="What this property charges for beyond the room, and how each charge is taxed and reported. Every folio charge names an item from this list."
      />
      <SectionCard title={view.propertyName} titleLevel={2}>
        <a
          href="/hotel/settings/extras"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
      </SectionCard>
      <HotelExtrasCatalog initial={view.initial} selection={view.selection} />
    </main>
  );
}
