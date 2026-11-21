'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { SubRoleGroups, type MemberAccessEditor } from './member-access-panel';

function RoleAccess({ roleId }: { roleId: string }) {
  const query = trpc.organizationAdmin.roleAccess.useQuery({ roleId }, { retry: false });
  const mutation = trpc.organizationAdmin.setRoleSubRole.useMutation();
  const utils = trpc.useUtils();
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  if (query.isLoading) return <Skeleton className="h-10 w-full" aria-label="Loading role access" />;
  const data = query.data;
  if (query.isError || !data)
    return (
      <div className="space-y-2">
        <p role="alert">The role could not be loaded.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  const setSubRole: MemberAccessEditor['setSubRole'] = async (input) => {
    try {
      const result = await mutation.mutateAsync({ roleId, ...input });
      await Promise.all([
        utils.organizationAdmin.roleAccess.invalidate({ roleId }),
        utils.organizationAdmin.memberAccess.invalidate(),
        utils.organizationAdmin.overview.invalidate(),
      ]);
      const others = data.groups
        .flatMap((group) => group.subRoles)
        .filter((item) => item.key !== input.subRoleKey && result.changed.includes(item.key));
      return {
        error: null,
        note: others.length
          ? `Saved. Also changed ${others.map((item) => item.label).join(', ')}.`
          : `Saved for the ${data.name} role.`,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'The role change could not be saved.',
        note: null,
      };
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        {data.holderCount} {data.holderCount === 1 ? 'person holds' : 'people hold'} this role.
        Changes apply to everyone who holds it now or receives it later. Individual exceptions and
        other access checks still apply.
      </p>
      {data.refusal && <p className="text-sm text-text-muted">{data.refusal}</p>}
      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-destructive' : 'text-sm text-foreground'}
        >
          {notice.text}
        </p>
      )}
      <SubRoleGroups
        groups={data.groups}
        weighty={data.weighty}
        lockedNoteFor={(item) => data.locked[item.key]}
        editor={data.refusal ? undefined : { pending: mutation.isPending, setSubRole }}
        onChanged={setNotice}
      />
    </div>
  );
}

function RolePicker() {
  const roles = trpc.organizationAdmin.roles.useQuery(undefined, { retry: false });
  const [roleId, setRoleId] = useState('');
  if (roles.isLoading)
    return <Skeleton className="h-10 w-full" aria-label="Loading pharmacy roles" />;
  if (roles.isError)
    return (
      <div className="space-y-2">
        <p role="alert">Pharmacy roles could not be loaded.</p>
        <Button variant="outline" onClick={() => void roles.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!roles.data?.length)
    return <p className="text-sm text-text-muted">This pharmacy has no roles to edit.</p>;
  return (
    <>
      <label className="grid gap-1.5 text-sm">
        Pharmacy role
        <select
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          className="min-h-11 w-full rounded-control border border-border-default bg-surface-card px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="">Choose a role</option>
          {roles.data.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>
      {roleId && <RoleAccess key={roleId} roleId={roleId} />}
    </>
  );
}

export function RoleAccessButton() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <Button ref={trigger} variant="outline" size="lg" onClick={() => setOpen(true)}>
        Role access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          initialFocus={title}
          finalFocus={trigger}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle ref={title} tabIndex={-1}>
              Role access
            </DialogTitle>
            <DialogDescription>
              Choose a pharmacy role to see or change the sub-roles it gives.
            </DialogDescription>
          </DialogHeader>
          {open && <RolePicker />}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
