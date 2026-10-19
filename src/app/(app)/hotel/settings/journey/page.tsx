import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import type { ComponentProps } from 'react';

import { HotelJourneyTemplatesEditor } from '@/components/hotel/journey-templates-editor';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Guest messages' };

/**
 * UPS-04 — the guest journey templates page.
 *
 * The read runs through the router rather than a direct query, so the page and
 * the API cannot disagree about who may see these messages: the same two
 * capabilities answer both, and a caller holding neither lands on the
 * explanation below rather than an empty list.
 */
export default async function HotelJourneyTemplatesPage() {
  let initial: ComponentProps<typeof HotelJourneyTemplatesEditor>['initial'] | null = null;
  let content;
  try {
    const ctx = await createTRPCContext();
    const caller = hotelPropertyRouter.createCaller(ctx);
    initial = await caller.journeyTemplates.list();
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    // Preserve Next.js redirects and other framework control-flow exceptions.
    if (!(error instanceof TRPCError)) throw error;
    const state =
      code === 'UNAUTHORIZED'
        ? {
            title: 'Sign in to view guest messages',
            message:
              'Your session is no longer available. Sign in again, then return to guest messages.',
          }
        : code === 'FORBIDDEN'
          ? {
              title: 'This page is not available to you',
              message:
                'Guest messages are available to marketing and property administrators. Ask your workspace administrator to check your access.',
            }
          : code === 'NOT_FOUND'
            ? {
                title: 'No hospitality property is available',
                message:
                  'Guest messages need an active property. Ask your workspace administrator to check property setup.',
              }
            : {
                title: 'Guest messages could not be loaded',
                message: 'The message list is temporarily unavailable. Try loading it again.',
              };
    content = (
      <SectionCard title={state.title} titleLevel={2}>
        <p className="text-sm text-text-muted" role="alert">
          {state.message}
        </p>
        {code !== 'FORBIDDEN' && code !== 'NOT_FOUND' ? (
          <Button
            nativeButton={false}
            role="link"
            render={<a href="/hotel/settings/journey" />}
            variant="secondary"
            className="mt-3 min-h-11"
          >
            Reload guest messages
          </Button>
        ) : null}
      </SectionCard>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Hospitality"
        heading="Guest messages"
        description="Draft and review guest messages for each step of a stay, in English and Urdu. Nothing sends from this page."
      />
      {initial ? <HotelJourneyTemplatesEditor initial={initial} /> : content}
    </main>
  );
}
