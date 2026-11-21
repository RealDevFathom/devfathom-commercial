import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelFunctionSpacesPanel } from '@/components/hotel/function-spaces-panel';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Function spaces' };

const DESCRIPTION =
  'The halls, lawns and boardrooms this property sells, how they can be laid out, how long each takes to turn around, and the claims on their time.';

/**
 * PROP-07 — the function spaces page.
 *
 * Same recipe as the rooms page: an explicit property selection, the reads
 * through the router so the page and the API share one gate — here
 * `hotel:property-admin` plus the `hotel-banquets` module, which the router
 * checks before any read — and an explanation instead of an empty table or a
 * raw error for a caller without access, a workspace without the module, or a
 * selection that no longer resolves.
 */
export default async function HotelFunctionSpacesSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | {
        kind: 'spaces';
        initial: Parameters<typeof HotelFunctionSpacesPanel>[0]['initial'];
        selection: Parameters<typeof HotelFunctionSpacesPanel>[0]['selection'];
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
      const initial = await caller.spaces.list({ branchId });
      view = {
        kind: 'spaces',
        initial,
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
    // The router names the missing module in its refusal; that is a different
    // explanation from a missing role, so the two are told apart by its text.
    const unlicensed =
      code === 'FORBIDDEN' &&
      error instanceof TRPCError &&
      error.message.includes('Banquets and Events');
    const denied = !unlicensed && (code === 'FORBIDDEN' || code === 'UNAUTHORIZED');
    const missingProperty = callerReady && code === 'NOT_FOUND';
    const title = unlicensed
      ? 'Function spaces are not part of this workspace’s package'
      : denied
        ? 'You cannot manage this property’s function spaces'
        : missingProperty
          ? 'Choose another property'
          : 'Could not load the function spaces';
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader eyebrow="Hospitality" heading="Function spaces" description={DESCRIPTION} />
        <SectionCard title={title} titleLevel={2}>
          <p className="text-sm text-text-muted">
            {unlicensed
              ? 'Halls, lawns and boardrooms are sold through the Banquets and Events module, which the Venue package carries. Ask your DevFathom account manager about adding it to this workspace.'
              : denied
                ? 'Sign in with a session that can manage this property, or ask your workspace administrator for property administration access.'
                : missingProperty
                  ? 'The selected property is no longer available. Choose a property you can manage.'
                  : 'The function spaces could not be fetched. Reload to try again; nothing you saved has changed.'}
          </p>
          {!unlicensed && !denied && !missingProperty ? (
            <a
              href={
                branchId
                  ? `/hotel/settings/spaces?branchId=${encodeURIComponent(branchId)}`
                  : '/hotel/settings/spaces'
              }
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Retry loading function spaces
            </a>
          ) : null}
          {denied || missingProperty ? (
            <a
              href="/hotel/settings/spaces"
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Choose another property
            </a>
          ) : null}
          {unlicensed ? (
            <a
              href="/dashboard"
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Back to the dashboard
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
          heading="Function spaces"
          description="Choose the property whose function spaces you want to manage."
        />
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/spaces"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="spaces-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="spaces-property"
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
                Open function spaces
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
      <PageHeader eyebrow="Hospitality" heading="Function spaces" description={DESCRIPTION} />
      <SectionCard title={view.propertyName} titleLevel={2}>
        <a
          href="/hotel/settings/spaces"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
      </SectionCard>
      <HotelFunctionSpacesPanel initial={view.initial} selection={view.selection} />
    </main>
  );
}
