import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { GrowthDenied, GrowthUnavailable } from '@/components/growth/growth-denied';
import { SettingsForm } from '@/components/growth/settings-form';
import { TemplateEditor } from '@/components/growth/template-editor';
import { cn } from '@/lib/utils';
import type { GrowthConnection, GrowthSettingsView, GrowthTemplate } from '@/lib/growth/view';

import { saveSettings, updateTemplate } from '../actions';
import { loadGrowthAccess } from '../access';
import { GrowthFrame } from '../frame';

export const metadata = { title: 'Settings · Growth' };

const description = 'The monthly cap, quiet hours, and the WhatsApp number this shop sends from.';

type SettingsData = {
  settings: GrowthSettingsView;
  connection: GrowthConnection;
  templates: GrowthTemplate[];
};

export default async function GrowthSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const query = await searchParams;
  const access = await loadGrowthAccess();
  if (!access.ok) return <GrowthDenied reason={access.reason} />;

  let data: SettingsData | null = null;
  let denied: 'flag' | 'permission' | null = null;
  let failed = false;
  try {
    const [settings, connection, templates] = await Promise.all([
      access.caller.settings.get(),
      access.caller.connection.status(),
      access.caller.templates.list(),
    ]);
    data = {
      settings,
      connection,
      templates: templates.templates,
    };
  } catch (error) {
    unstable_rethrow(error);
    failed = true;
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      denied = error.message.includes('off') ? 'flag' : 'permission';
    }
  }

  if (denied) return <GrowthDenied reason={denied} />;
  if (failed || !data) {
    return (
      <GrowthFrame current="settings" heading="Settings" description={description}>
        <GrowthUnavailable />
      </GrowthFrame>
    );
  }

  return (
    <GrowthFrame
      current="settings"
      heading="Settings"
      description={description}
      notice={query.notice}
      error={query.error}
      actions={
        <Link href="/growth" className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11')}>
          Inbox
        </Link>
      }
    >
      <SettingsForm settings={data.settings} connection={data.connection} save={saveSettings} />
      <SectionCard title="Templates" titleLevel={2}>
        <TemplateEditor templates={data.templates} save={updateTemplate} />
      </SectionCard>
    </GrowthFrame>
  );
}
