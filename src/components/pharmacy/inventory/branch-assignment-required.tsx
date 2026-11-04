import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';

/**
 * DEV-660 — the inventory surfaces read stock only for a branch the session
 * actor holds an active assignment to. When the tenant has active branches but
 * none is assigned to this person, say so and point to the next step instead
 * of letting a refused read become an error page.
 *
 * `canAssign` is the session ADMIN role: only an administrator can open the
 * branch-assignment page, so everyone else is told whom to ask.
 */
export function BranchAssignmentRequired({ canAssign }: { canAssign: boolean }) {
  return (
    <SectionCard title="Branch assignment required">
      <p className="text-sm text-text-muted">
        Stock is shown only for branches you are assigned to, and you are not assigned to an active
        branch yet.{' '}
        {canAssign
          ? 'Assign yourself to the branch you work at, then reopen this page.'
          : 'Ask a workspace administrator to assign you to your branch.'}
      </p>
      {canAssign ? (
        <Link
          className={buttonVariants({ className: 'mt-4', variant: 'secondary' })}
          href="/pharmacy/settings/branches"
        >
          Open branch assignments
        </Link>
      ) : null}
    </SectionCard>
  );
}
