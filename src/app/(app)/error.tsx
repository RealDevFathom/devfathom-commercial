'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-32 animate-fade-in">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 mb-5">
        <AlertCircle className="h-8 w-8 text-red-500" />
      </div>
      <h2 className="font-display text-xl font-bold text-foreground">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-sm text-center">
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <button
        onClick={reset}
        className="mt-6 flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
      >
        <RefreshCw className="h-4 w-4" />
        Try Again
      </button>
    </div>
  );
}
