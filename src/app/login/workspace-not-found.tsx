'use client';

import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';

export function WorkspaceNotFound({ signInUrl }: { signInUrl: string | null }) {
  const router = useRouter();
  return (
    <div>
      <p className="font-mono text-xs text-text-muted">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        Workspace not found
      </h1>
      <p className="mt-3 text-sm leading-6 text-text-muted">
        Check the workspace address for a typo, or ask your workspace administrator for the correct
        link.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {signInUrl && (
          <a href={signInUrl} className={buttonVariants({ size: 'touch' })}>
            Find your workspace
          </a>
        )}
        <Button size="touch" variant="outline" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    </div>
  );
}
