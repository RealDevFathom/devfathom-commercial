import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

/**
 * DEV-502: a missing page inside the workspace keeps the app shell, so the
 * user still has the navigation and a clear next step.
 */
export default function WorkspaceNotFound() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Workspace"
        heading="Page not found"
        description="This page doesn't exist or has moved."
      />
      <SectionCard title="Where to next" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Check the address, or use the navigation above to open another part of your workspace.
        </p>
        <Link href="/dashboard" className={buttonVariants({ className: 'mt-4 min-h-11' })}>
          Go to dashboard
        </Link>
      </SectionCard>
    </div>
  );
}
