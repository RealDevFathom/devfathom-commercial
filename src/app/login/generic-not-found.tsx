'use client';

import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';

/**
 * SEC-G: an unknown tenant host renders this page. It must read exactly like any
 * other missing page — never "workspace not found", never the host or slug — so
 * it cannot be used to probe which workspaces exist or what they are called.
 */
export function GenericNotFound({ signInUrl }: { signInUrl: string | null }) {
  const router = useRouter();
  return (
    <div>
      <p className="font-mono text-xs text-text-muted">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">Page not found</h1>
      <p className="mt-3 text-sm leading-6 text-text-muted">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {signInUrl && (
          <a href={signInUrl} className={buttonVariants({ size: 'touch' })}>
            Go to sign in
          </a>
        )}
        <Button size="touch" variant="outline" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    </div>
  );
}
