import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelJourneyTemplatesEditor } from '@/components/hotel/journey-templates-editor';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Guest messages' };

const DESCRIPTION =
  'What this property sends a guest at each step of a stay — booking confirmed, before arrival, welcome, departure, invoice, review — in English and Urdu, with the approval that lets a version be sent. Nothing sends from this page.';

/** The two capabilities this surface shares: either one opens it; only the first approves. */
const CAPABILITIES = ['hotel:property-admin', 'hotel:marketing'] as const;

/**
 * UPS-04 — the guest messages page.
 *
 * Same recipe as the other hotel settings pages: an explicit property
 * selection, the reads through the router so the page and the API share one
 * gate, and an explanation instead of an empty board or a raw error. The gate
 * here is property administration OR marketing, so the chooser lists the
 * properties this identity holds either capability at, and the access check
 * tries property administration first and marketing second — the same order
 * the router's own resolver uses. A workspace without the Guest Journey and
 * Upsell module is told so, apart from a member without access.
 */
export default async function HotelJourneyTemplatesPage({
  searchParams,
}: {
  searchParams?: Promise<{ branchId?: string | string[] }>;
}) {
  let view:
    | { kind: 'choices'; properties: { branchId: string; name: string }[] }
    | {
        kind: 'messages';
        initial: Parameters<typeof HotelJourneyTemplatesEditor>[0]['initial'];
        selection: Parameters<typeof HotelJourneyTemplatesEditor>[0]['selection'];
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
      const available = await caller.access.propertiesByCapability({
        capabilities: [...CAPABILITIES],
      });
      view = {
        kind: 'choices',
        properties: available.properties.map(({ branchId, name }) => ({ branchId, name })),
      };
    } else {
      let property: { name: string };
      try {
        property = await caller.access.select({ branchId, capability: CAPABILITIES[0] });
      } catch (error) {
        if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
        property = await caller.access.select({ branchId, capability: CAPABILITIES[1] });
      }
      const initial = await caller.journeyTemplates.list({ branchId });
      view = {
        kind: 'messages',
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
      error.message.includes('Guest Journey and Upsell');
    const denied = !unlicensed && (code === 'FORBIDDEN' || code === 'UNAUTHORIZED');
    const missingProperty = callerReady && code === 'NOT_FOUND';
    const title = unlicensed
      ? 'Guest messages are not part of this workspace’s package'
      : denied
        ? 'You cannot work on this property’s guest messages'
        : missingProperty
          ? 'Choose another property'
          : 'Could not load the guest messages';
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader eyebrow="Hospitality" heading="Guest messages" description={DESCRIPTION} />
        <SectionCard title={title} titleLevel={2}>
          <p className="text-sm text-text-muted">
            {unlicensed
              ? 'Guest messages are drafted and approved through the Guest Journey and Upsell module, which the Hotel Pro and Chain packages carry. Ask your DevFathom account manager about adding it to this workspace.'
              : denied
                ? 'Sign in with a session that administers this property or holds marketing at it, or ask your workspace administrator for a Hotel role with property administration or marketing.'
                : missingProperty
                  ? 'The selected property is no longer available. Choose a property whose guest messages you may work on.'
                  : 'The guest messages could not be fetched. Reload to try again; nothing you saved has changed.'}
          </p>
          {!unlicensed && !denied && !missingProperty ? (
            <a
              href={
                branchId
                  ? `/hotel/settings/journey?branchId=${encodeURIComponent(branchId)}`
                  : '/hotel/settings/journey'
              }
              className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
            >
              Retry loading guest messages
            </a>
          ) : null}
          {denied || missingProperty ? (
            <a
              href="/hotel/settings/journey"
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
          heading="Guest messages"
          description="Choose the property whose guest messages you want to work on."
        />
        <SectionCard title="Choose a property" titleLevel={2}>
          {view.properties.length ? (
            <form
              action="/hotel/settings/journey"
              method="get"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="journey-property" className="block text-sm font-semibold">
                  Property
                </label>
                <StudioSelect
                  id="journey-property"
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
                Open guest messages
              </button>
            </form>
          ) : (
            <p className="text-sm text-text-muted">
              No properties are available for you to work on. Ask your workspace administrator for a
              property assignment with a Hotel role that administers the property or holds
              marketing.
            </p>
          )}
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader eyebrow="Hospitality" heading="Guest messages" description={DESCRIPTION} />
      <SectionCard title={view.propertyName} titleLevel={2}>
        <a
          href="/hotel/settings/journey"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
      </SectionCard>
      <HotelJourneyTemplatesEditor initial={view.initial} selection={view.selection} />
    </main>
  );
}
