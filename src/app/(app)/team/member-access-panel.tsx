'use client';

import { useId, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Skeleton } from '@/components/ui/skeleton';
import { SIGNIN_ALLOWED_STATUSES } from '@/lib/auth/constants';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

type MemberAccess = inferRouterOutputs<AppRouter>['organizationAdmin']['memberAccess'];
type SubRole = MemberAccess['groups'][number]['subRoles'][number];

/**
 * Some pharmacy checks let a workspace administrator through before any permission is
 * read (day close is one), so for an administrator the ticks are not the whole story.
 */
export const MEMBER_ACCESS_ADMIN_NOTE =
  'As a workspace administrator, this person can also do some owner tasks that the ticks do not show yet, such as closing the day.';

/** The one line that says ticks are read-only in this phase (DEV-959A). */
export const MEMBER_ACCESS_READ_ONLY_NOTE =
  'You cannot change these ticks yet. Editing comes in the next update.';

function roleSummary(member: MemberAccess['member']): string {
  const role = member.roleName
    ? `${member.roleName}${member.customRole ? ' (custom role)' : ''}`
    : 'No pharmacy role';
  if (member.exceptionCount === 0) return role;
  const exceptions = `${member.exceptionCount} personal ${
    member.exceptionCount === 1 ? 'exception' : 'exceptions'
  }`;
  return `${role}, plus ${exceptions}`;
}

function SubRoleRow({ subRole }: { subRole: SubRole }) {
  const id = useId();
  const stateLabel =
    subRole.state === 'on' ? 'Allowed' : subRole.state === 'partial' ? 'Partly allowed' : '';
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        className="mt-0.5"
        checked={subRole.state === 'on'}
        indeterminate={subRole.state === 'partial'}
        disabled
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      />
      <div className="min-w-0 space-y-0.5">
        <p id={`${id}-label`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-foreground">{subRole.label}</span>
          {stateLabel ? <span className="sr-only">{stateLabel}</span> : null}
          {subRole.sensitive ? (
            <span className="eyebrow inline-flex items-center gap-1 text-warning">
              <ShieldAlert className="size-3" aria-hidden />
              Extra care
            </span>
          ) : null}
        </p>
        <p id={`${id}-description`} className="text-xs leading-relaxed text-text-muted">
          {subRole.description}
        </p>
      </div>
    </li>
  );
}

/** Read-only "What this person can do": every sub-role, grouped by role, theirs ticked. */
export function MemberAccessPanel({ userId }: { userId: string }) {
  const access = trpc.organizationAdmin.memberAccess.useQuery({ userId }, { retry: false });
  return (
    <MemberAccessView
      isLoading={access.isLoading}
      isError={access.isError}
      data={access.data}
      onRetry={() => void access.refetch()}
    />
  );
}

/** The view itself, without the query, so every state renders from plain props. */
export function MemberAccessView(access: {
  isLoading: boolean;
  isError: boolean;
  data: MemberAccess | undefined;
  onRetry: () => void;
}) {
  if (access.isLoading) {
    return (
      <div className="space-y-3" aria-label="Loading what this person can do">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (access.isError || !access.data) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-text-muted">
          What this person can do could not be loaded. Nothing about their access has changed.
        </p>
        <Button variant="outline" onClick={access.onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { member, groups } = access.data;
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p className="text-foreground">{roleSummary(member)}</p>
        {!SIGNIN_ALLOWED_STATUSES.has(member.status) ? (
          <p className="text-text-muted">
            {member.name} cannot sign in right now, so they cannot use any of this.
          </p>
        ) : null}
        {member.workspaceAdmin ? (
          <p className="text-text-muted">{MEMBER_ACCESS_ADMIN_NOTE}</p>
        ) : null}
        <p className="text-text-muted">{MEMBER_ACCESS_READ_ONLY_NOTE}</p>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {groups.map((group) => (
          <section
            key={group.roleKey}
            aria-labelledby={`access-group-${group.roleKey}`}
            className="min-w-0 border-t border-border-subtle pt-3"
          >
            <Eyebrow id={`access-group-${group.roleKey}`}>{group.roleName}</Eyebrow>
            <ul className="divide-y divide-border-subtle">
              {group.subRoles.map((subRole) => (
                <SubRoleRow key={subRole.key} subRole={subRole} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** A row action that opens the read-only view in a dialog. */
export function MemberAccessButton({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  // Long content: start at the top, not on the footer Close button.
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        What they can do<span className="sr-only">: {name}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
          initialFocus={titleRef}
        >
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
              What {name} can do
            </DialogTitle>
            <DialogDescription>
              Every sub-role in the pharmacy, grouped by the role it usually comes with. Ticked ones
              are what this person can do now.
            </DialogDescription>
          </DialogHeader>
          {open ? <MemberAccessPanel userId={userId} /> : null}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
