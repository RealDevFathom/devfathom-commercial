'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import { RestaurantBranchSelect } from './restaurant-branch-select';

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

type BranchOption = {
  id: string;
  name: string;
  code?: string;
  active: boolean;
  isDefault: boolean;
};

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

/**
 * DEV-253 — invite a brand-new waiter, manager, or other staff member who has no
 * account yet. The server creates the INVITED account with the chosen role,
 * links a new staff profile to it, and emails the set-password link; the link is
 * also shown here so it can be shared by hand. Mount only while open so closing
 * resets the form.
 */
export function RestaurantStaffInviteDialog({
  onOpenChange,
  branches,
  branchesLoading,
  branchesError,
  onInvited,
}: {
  onOpenChange: (open: boolean) => void;
  branches: BranchOption[];
  branchesLoading: boolean;
  branchesError: boolean;
  onInvited: () => void;
}) {
  const rolesQuery = trpc.restaurantStaff.listInviteRoles.useQuery();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const invite = trpc.restaurantStaff.invite.useMutation({
    onSuccess: (result) => {
      setInviteUrl(result.inviteUrl);
      onInvited();
      toast.success('Invitation sent.');
    },
    onError: (error) => toast.error(error.message),
  });
  const roles = rolesQuery.data ?? [];
  const rolesUnavailable = rolesQuery.isLoading || Boolean(rolesQuery.error) || roles.length === 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    invite.mutate({
      displayName: formText(data, 'displayName'),
      email: formText(data, 'email'),
      organizationRoleId: formText(data, 'organizationRoleId'),
      primaryBranchId: formText(data, 'primaryBranchId') || null,
    });
  };

  const copyLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success('Invitation link copied.');
    } catch {
      toast.error('Copy failed. Select the link and copy it manually.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!invite.isPending) onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Invite staff member</DialogTitle>
          <DialogDescription>
            For a new waiter, manager, or other team member without an account. They get an email
            link to set their password.
          </DialogDescription>
        </DialogHeader>
        {inviteUrl ? (
          <div className="space-y-4">
            <p role="status" className="text-sm text-text-strong">
              Invitation sent. If the email does not arrive, share this link. It expires in 7 days
              and works once.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="staff-invite-link" className={labelClass}>
                Invitation link
              </label>
              <Input
                id="staff-invite-link"
                readOnly
                value={inviteUrl}
                className="h-11"
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void copyLink()}
              >
                Copy link
              </Button>
              <Button type="button" className="min-h-11" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            {invite.error ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {invite.error.message}
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Full name</span>
                <Input name="displayName" required maxLength={200} className="h-11" />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Email</span>
                <Input name="email" type="email" required maxLength={254} className="h-11" />
              </label>
              <div className="space-y-1.5">
                <label htmlFor="staff-invite-role" className={labelClass}>
                  Role
                </label>
                <select
                  id="staff-invite-role"
                  name="organizationRoleId"
                  required
                  defaultValue=""
                  disabled={rolesUnavailable}
                  aria-invalid={rolesQuery.error ? true : undefined}
                  aria-describedby="staff-invite-role-help"
                  className={selectClass}
                >
                  <option value="" disabled>
                    {rolesQuery.isLoading
                      ? 'Loading roles…'
                      : rolesQuery.error
                        ? 'Roles unavailable'
                        : roles.length === 0
                          ? 'No roles you can assign'
                          : 'Select a role'}
                  </option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <span id="staff-invite-role-help" className="block text-xs text-text-muted">
                  Only roles within your own access are listed.
                </span>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="staff-invite-branch" className={labelClass}>
                  Primary branch
                </label>
                <RestaurantBranchSelect
                  id="staff-invite-branch"
                  name="primaryBranchId"
                  ariaLabel="Primary branch"
                  defaultValue=""
                  branches={branches}
                  loading={branchesLoading}
                  error={branchesError}
                  allowEmpty
                  emptyLabel="No primary branch"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={invite.isPending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={invite.isPending || rolesUnavailable}
              >
                {invite.isPending ? 'Sending…' : 'Send invitation'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
