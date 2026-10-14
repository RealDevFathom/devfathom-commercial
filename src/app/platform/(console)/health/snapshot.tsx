'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';

export function HealthSnapshot({ observedAt }: { observedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const update = () => setStale(Date.now() - new Date(observedAt).getTime() > 120_000);
    update();
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [observedAt]);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
      <p>
        Snapshot:{' '}
        <time dateTime={observedAt}>{observedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time>
      </p>
      {stale && <StatusPill status="Stale snapshot — refresh" tone="warning" />}
      <Button
        variant="outline"
        className="min-h-11"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? 'Refreshing…' : 'Refresh snapshot'}
      </Button>
    </div>
  );
}
