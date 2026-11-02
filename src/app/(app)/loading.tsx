import { LogoIcon } from '@/components/brand/logo';

/**
 * Shown right after sign-in and whenever a workspace page has no loading state of its own.
 * It says what is loading, not just that something is: a pulsing mark alone left people
 * unsure whether the sign-in had worked.
 */
export default function AppLoading() {
  return (
    <div className="flex items-center justify-center py-32 animate-fade-in motion-reduce:animate-none">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-4 text-center"
      >
        <span aria-hidden>
          <LogoIcon
            className="h-10 w-10 animate-pulse motion-reduce:animate-none"
            variant="brand"
          />
        </span>
        <div aria-hidden className="flex items-center gap-1.5">
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: '0ms' }}
          />
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: '150ms' }}
          />
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: '300ms' }}
          />
        </div>
        <div className="space-y-1">
          <p className="font-display text-base font-semibold text-text-strong">
            Loading your workspace
          </p>
          <p className="max-w-xs text-sm text-text-muted">
            Checking your access and opening the page you asked for.
          </p>
        </div>
      </div>
    </div>
  );
}
