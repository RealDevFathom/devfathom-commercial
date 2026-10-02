import { TRPCError } from '@trpc/server';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { cameraPrivacyRouter, type CameraPrivacyVertical } from '@/lib/cameras/privacy';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { CameraPrivacyPanel } from './camera-privacy-panel';

async function privacyCaller() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  return cameraPrivacyRouter.createCaller(ctx);
}

function message(error: unknown) {
  return error instanceof TRPCError ? error.message : 'The camera setting could not be saved.';
}

/** CAM-3: /pharmacy and /restaurant settings/cameras/privacy share this page. */
export async function CameraPrivacyPage({
  vertical,
  notice,
}: {
  vertical: CameraPrivacyVertical;
  notice?: { text: string; kind: 'success' | 'error' };
}) {
  const route = `/${vertical}/settings/cameras/privacy`;
  const header = (
    <PageHeader
      eyebrow="Camera settings"
      heading="Camera privacy"
      description="Customer signage, how long stills are kept, and who can open a live view."
    />
  );
  const caller = await privacyCaller();
  let view;
  try {
    view = caller ? await caller.view({ vertical }) : null;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    view = null;
  }
  if (!view) {
    return (
      <main className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Permission required">
          <p className="text-sm text-text-muted">
            Camera privacy settings are available to workspace administrators with camera settings
            enabled.
          </p>
        </SectionCard>
      </main>
    );
  }

  const done = (text: string, kind: 'success' | 'error' = 'success') =>
    `${route}?${new URLSearchParams({ notice: text, kind })}`;

  async function setRetentionAction(data: FormData) {
    'use server';
    let destination: string;
    try {
      const writer = await privacyCaller();
      if (!writer) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in again.' });
      await writer.setRetention({
        vertical,
        gatewayId: String(data.get('gatewayId') ?? ''),
        days: Number(data.get('days')),
      });
      destination = done('Retention updated.');
    } catch (error) {
      destination = done(message(error), 'error');
    }
    redirect(destination);
  }

  async function revokeGrantAction(data: FormData) {
    'use server';
    let destination: string;
    try {
      const writer = await privacyCaller();
      if (!writer) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in again.' });
      await writer.revokeGrant({ vertical, grantId: String(data.get('grantId') ?? '') });
      destination = done('Live-view access revoked.');
    } catch (error) {
      destination = done(message(error), 'error');
    }
    redirect(destination);
  }

  return (
    <main className="min-w-0 space-y-6">
      {header}
      {notice && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className="rounded-[var(--radius-sm)] bg-surface-sunken p-3 text-sm"
        >
          {notice.text}
        </p>
      )}
      <CameraPrivacyPanel
        vertical={vertical}
        view={view}
        setRetentionAction={setRetentionAction}
        revokeGrantAction={revokeGrantAction}
      />
    </main>
  );
}

export function privacyNotice(query: { notice?: string; kind?: string }) {
  return query.notice
    ? {
        text: query.notice,
        kind: query.kind === 'error' ? ('error' as const) : ('success' as const),
      }
    : undefined;
}
