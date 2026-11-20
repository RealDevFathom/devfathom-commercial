import { SelectField as StudioSelect } from '@/components/ui/select-field';import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelInventoryPanel } from '@/components/hotel/inventory-panel';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Rooms' };

const DESCRIPTION =
  'The room types this property sells and the rooms, beds and units under them: what can be reserved, cleaned and withheld.';

/**
 * PROP-02 / PROP-03 / HK-03 — the rooms page.
 *
 * Same recipe as the extras catalog: an explicit property selection, the reads
 * through the router so the page and the API share one `hotel:property-admin`
 * gate, and an explanation instead of an empty table or a raw error for a
 * caller without access or a selection that no longer resolves.
 */
export default async function HotelRoomsSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | {
        kind: 'inventory';
        initial: Parameters<typeof HotelInventoryPanel>[0]['initial'];
        selection: Parameters<typeof HotelInventoryPanel>[0]['selection'];
        propertyName: string;
      };
  let branchId: string | undefined;
  let callerReady = false;
  try {
    const query = await searchParams;
    branchId = typeof query?.branchId === 'string' ? query.branchId.trim() : undefined;
    const ctx = await createTRPCContext();
    const caller = hotelPropertyRouter.createCaller(ctx);
    callerReady = true;
    if (!branchId) {
      const available = await caller.extras.properties();
      view = { kind: 'choices', properties: available.properties };
    } else {
      const property = await caller.access.select({ branchId, capability: 'hotel:property-admin' });
      const roomTypes = await caller.inventory.roomTypes.list({ branchId });
      const rooms = await caller.inventory.rooms.list({ branchId });
      view = {
        kind: 'inventory',
        initial: { roomTypes, rooms },
        selection: {
          branchId,
          organizationId: ctx.session!.user.organizationId,
          userId: ctx.session!.user.id,
        },
        propertyName: property.name,
      };
    }
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    const denied = code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
    const missingProperty = callerReady && code === 'NOT_FOUND';
    const title = denied
      ? 'You cannot manage this property’s rooms'
      : missingProperty
        ? 'Choose another property'
        : 'Could not load the rooms';
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader eyebrow="Hospitality" heading="Rooms" description={DESCRIPTION} />
        <SectionCard title={title} titleLevel={2}>
          <p className="text-sm text-text-muted">
            {denied
              ? 'Sign in with a session that can manage this property, or ask your workspace administrator for property administration access.'
              : missingProperty
                ? 'The selected property is no longer available. Choose a property you can manage.'
                : 'The rooms could not be fetched. Reload to try again; nothing you saved has changed.'}
          </p>
          {!denied && !missingProperty ? (
            <a
              href={
                branchId
                  ? `/hotel/settings/rooms?branchId=${encodeURIComponent(branchId)}`
                  : '/hotel/settings/rooms'
              }
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Retry loading rooms
            </a>
          ) : null}
          {denied || missingProperty ? (
            <a
              href="/hotel/settings/rooms"
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
          heading="Rooms"
          description="Choose the property whose rooms you want to manage."
        />
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/rooms"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="rooms-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="rooms-property"
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
                Open rooms
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
      <PageHeader eyebrow="Hospitality" heading="Rooms" description={DESCRIPTION} />
      <SectionCard title={view.propertyName} titleLevel={2}>
        <a
          href="/hotel/settings/rooms"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
      </SectionCard>
      <HotelInventoryPanel initial={view.initial} selection={view.selection} />
    </main>
  );
}
