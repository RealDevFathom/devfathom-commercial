import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelMealPlansPanel } from '@/components/hotel/meal-plans-panel';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { hotelRatesRouter } from '@/server/routers/hotel-rates';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Meal plans' };

const DESCRIPTION =
  'The board bases this property sells — room only, bed & breakfast, half board, full board or its own — what each one covers, and which are on sale.';

/**
 * MEAL-01 — the meal plans page.
 *
 * Same recipe as the rooms and extras pages: an explicit property selection,
 * the reads through the routers so the page and the API share one gate, and an
 * explanation instead of an empty table or a raw error for a caller without
 * access or a selection that no longer resolves. The gate here is
 * `hotel:rates`, not property administration — a front-office manager who sets
 * rates sets the plans those rates sell — so the chooser lists the properties
 * this identity holds that capability at.
 */
export default async function HotelMealPlansSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | {
        kind: 'plans';
        initial: Parameters<typeof HotelMealPlansPanel>[0]['initial'];
        selection: Parameters<typeof HotelMealPlansPanel>[0]['selection'];
        propertyName: string;
      };
  let branchId: string | undefined;
  let callerReady = false;
  try {
    const query = await searchParams;
    branchId = typeof query?.branchId === 'string' ? query.branchId.trim() : undefined;
    const ctx = await createTRPCContext();
    const caller = hotelPropertyRouter.createCaller(ctx);
    const rates = hotelRatesRouter.createCaller(ctx);
    callerReady = true;
    if (!branchId) {
      const available = await caller.access.properties({ capability: 'hotel:rates' });
      view = { kind: 'choices', properties: available.properties };
    } else {
      const property = await caller.access.select({ branchId, capability: 'hotel:rates' });
      const initial = await rates.mealPlans.list({ branchId });
      view = {
        kind: 'plans',
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
    const denied = code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
    const missingProperty = callerReady && code === 'NOT_FOUND';
    const title = denied
      ? 'You cannot manage this property’s meal plans'
      : missingProperty
        ? 'Choose another property'
        : 'Could not load the meal plans';
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader eyebrow="Hospitality" heading="Meal plans" description={DESCRIPTION} />
        <SectionCard title={title} titleLevel={2}>
          <p className="text-sm text-text-muted">
            {denied
              ? 'Sign in with a session that sets rates at this property, or ask your workspace administrator for a Hotel role with rate administration.'
              : missingProperty
                ? 'The selected property is no longer available. Choose a property whose rates you manage.'
                : 'The meal plans could not be fetched. Reload to try again; nothing you saved has changed.'}
          </p>
          {!denied && !missingProperty ? (
            <a
              href={
                branchId
                  ? `/hotel/settings/meal-plans?branchId=${encodeURIComponent(branchId)}`
                  : '/hotel/settings/meal-plans'
              }
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Retry loading meal plans
            </a>
          ) : null}
          {denied || missingProperty ? (
            <a
              href="/hotel/settings/meal-plans"
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
          heading="Meal plans"
          description="Choose the property whose meal plans you want to manage."
        />
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/meal-plans"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="meal-plans-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="meal-plans-property"
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
                Open meal plans
              </button>
            </form>
          ) : (
            <p className="text-sm text-text-muted">
              No properties are available for you to manage. Ask your workspace administrator for a
              property assignment with a Hotel role that sets rates.
            </p>
          )}
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader eyebrow="Hospitality" heading="Meal plans" description={DESCRIPTION} />
      <SectionCard title={view.propertyName} titleLevel={2}>
        <a
          href="/hotel/settings/meal-plans"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
      </SectionCard>
      <HotelMealPlansPanel initial={view.initial} selection={view.selection} />
    </main>
  );
}
