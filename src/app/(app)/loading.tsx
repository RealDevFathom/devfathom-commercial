import { LogoIcon } from '@/components/brand/logo';

export default function AppLoading() {
  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-32 animate-fade-in motion-reduce:animate-none">
      <div
        role="status"
        className="flex min-w-0 max-w-full flex-col items-center gap-4 text-center whitespace-normal break-words"
      >
        <LogoIcon className="h-10 w-10 animate-pulse motion-reduce:animate-none" variant="brand" />
        <div aria-hidden="true" className="flex items-center gap-1.5">
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
        <div className="w-full max-w-xs space-y-1">
          <p className="font-display text-base font-semibold text-text-strong">
            Loading your workspace
          </p>
          <p className="text-sm text-text-muted">Please wait while the page loads.</p>
        </div>
      </div>
    </div>
  );
}
