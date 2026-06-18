import { LogoIcon } from '@/components/brand/logo';

export default function AppLoading() {
  return (
    <div className="flex items-center justify-center py-32 animate-fade-in">
      <div className="flex flex-col items-center gap-4">
        <LogoIcon className="h-10 w-10 animate-pulse" variant="brand" />
        <div className="flex items-center gap-1.5">
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <div
            className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </div>
      </div>
    </div>
  );
}
