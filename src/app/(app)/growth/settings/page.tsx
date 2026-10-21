import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { GrowthDenied, GrowthUnavailable } from '@/components/growth/growth-denied';
import { MessageLog } from '@/components/growth/message-log';
import { SettingsForm } from '@/components/growth/settings-form';
import { TemplateEditor } from '@/components/growth/template-editor';
import { cn } from '@/lib/utils';
import type {
  GrowthConnection,
  GrowthMessage,
  GrowthSettingsView,
  GrowthTemplate,
} from '@/lib/growth/view';

import { saveSettings, sendTestMessage, updateTemplate } from '../actions';
import { loadGrowthAccess } from '../access';
import { GrowthFrame } from '../frame';

export const metadata = { title: 'Settings · Growth' };

const description = 'The monthly cap, quiet hours, and the WhatsApp number this shop sends from.';

type SettingsData = {
  settings: GrowthSettingsView;
  connection: GrowthConnection;
  templates: GrowthTemplate[];
  messages: GrowthMessage[];
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
    const [settings, connection, templates, messages] = await Promise.all([
      access.caller.settings.get(),
      access.caller.connection.status(),
      access.caller.templates.list(),
      access.caller.messages.list(),
    ]);
    data = {
      settings,
      connection,
      templates: templates.templates,
      messages: messages.messages,
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
      <SettingsForm
        settings={data.settings}
        connection={data.connection}
        save={saveSettings}
        sendTest={sendTestMessage}
      />
      <SectionCard title="Templates" titleLevel={2}>
        <TemplateEditor templates={data.templates} save={updateTemplate} />
      </SectionCard>
      <SectionCard title="Message log" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          What went out and what came back. This is a log, not a chat.
        </p>
        <MessageLog messages={data.messages} />
      </SectionCard>
    </GrowthFrame>
  );
}
