'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';

/**
 * The plaintext secret exists only in this component after a successful rotate.
 * Reloading the page drops it. Nothing reads it back from the server.
 */
export function WhatsAppWebhookSettings() {
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = trpc.growth.whatsapp.rotateWebhookSecret.useMutation({
    retry: false,
    onSuccess: (result) => setSecret(result.secret),
  });

  return (
    <SectionCard title="WhatsApp webhook secret" titleLevel={2}>
      <p className="text-sm text-text-body">
        Evolution checks inbound events with this organization secret. Setting or rotating it
        replaces the previous value. Copy the new secret now. It is not shown again.
      </p>
      <Button
        type="button"
        className="mt-4 min-h-11"
        disabled={rotate.isPending}
        onClick={() => rotate.mutate()}
      >
        {rotate.isPending ? 'Saving…' : secret ? 'Rotate secret' : 'Set webhook secret'}
      </Button>
      {rotate.error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {rotate.error.message}
        </p>
      ) : null}
      {secret ? (
        <div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 p-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-strong">
            Copy now · shown once
          </p>
          <code className="mt-2 block break-all text-sm text-text-strong">{secret}</code>
          <Button
            type="button"
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            Copy secret
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}
