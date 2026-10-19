'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';

export function SopLoadRecovery() {
  const router = useRouter();
  const retryButton = useRef<HTMLButtonElement>(null);
  const attempted = useRef(false);
  const [isRetrying, startRetry] = useTransition();

  useEffect(() => {
    if (attempted.current && !isRetrying) retryButton.current?.focus();
  }, [isRetrying]);

  function retry() {
    if (isRetrying) return;
    attempted.current = true;
    startRetry(() => router.refresh());
  }

  return (
    <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3" aria-busy={isRetrying}>
      <Button
        ref={retryButton}
        type="button"
        variant="secondary"
        className="min-h-11 max-w-full whitespace-normal"
        disabled={isRetrying}
        onClick={retry}
      >
        {isRetrying ? 'Retrying SOP board…' : 'Retry SOP board'}
      </Button>
      <p className="min-w-0 text-sm text-text-muted" aria-live="polite" aria-atomic="true">
        {isRetrying ? 'Retrying the SOP board. Existing information remains unchanged.' : ''}
      </p>
    </div>
  );
}
