'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 mx-auto mb-5">
          <AlertCircle className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="font-display text-xl font-bold text-foreground">Something went wrong</h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-sm">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={reset}
          className="mt-6 flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground mx-auto hover:bg-primary-hover active:scale-[0.98]"
        >
          <RefreshCw className="h-4 w-4" />
          Try Again
        </button>
      </div>
    </div>
  );
}
