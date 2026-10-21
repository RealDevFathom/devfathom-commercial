'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

const controlClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring';

export type BranchAssignmentView = {
  branches: { id: string; code: string; name: string }[];
  members: { id: string; name: string; email: string; roleName: string }[];
  assignments: {
    id: string;
    branchId: string;
    userId: string;
    branchName: string;
    userName: string;
  }[];
};

export function BranchAssignmentsPanel({
  branches,
  members,
  assignments,
  pending,
  notice,
  onAssign,
  onUnassign,
}: BranchAssignmentView & {
  pending: boolean;
  notice: string | null;
  onAssign: (input: { branchId: string; userId: string }) => void;
  onUnassign: (assignmentId: string) => void;
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [userId, setUserId] = useState(members[0]?.id ?? '');
  const branchValue = branches.some((branch) => branch.id === branchId)
    ? branchId
    : (branches[0]?.id ?? '');
  const memberValue = members.some((member) => member.id === userId)
    ? userId
    : (members[0]?.id ?? '');
  const ready = branchValue !== '' && memberValue !== '';

  function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    onAssign({ branchId: branchValue, userId: memberValue });
  }

  return (
    <div className="space-y-6">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={assign}>
        <div>
          <Label htmlFor="pharmacy-assignment-branch">Branch</Label>
          <select
            className={controlClass}
            id="pharmacy-assignment-branch"
            value={branchValue}
            disabled={branches.length === 0}
            onChange={(event) => setBranchId(event.target.value)}
          >
            {branches.length === 0 ? <option value="">No active branch</option> : null}
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="pharmacy-assignment-member">Member</Label>
          <select
            className={controlClass}
            id="pharmacy-assignment-member"
            value={memberValue}
            disabled={members.length === 0}
            onChange={(event) => setUserId(event.target.value)}
          >
            {members.length === 0 ? <option value="">No pharmacy member</option> : null}
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} — {member.roleName}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Button className="min-h-11" type="submit" disabled={!ready || pending}>
            Assign
          </Button>
        </div>
      </form>
      {branches.length === 0 ? (
        <p className="text-sm text-text-body">No active pharmacy branch is available.</p>
      ) : null}
      {members.length === 0 ? (
        <p className="text-sm text-text-body">No active pharmacy member is available to assign.</p>
      ) : null}
      {notice ? (
        <p className="text-sm text-text-body" role="status">
          {notice}
        </p>
      ) : null}
      <ul className="divide-y divide-border-subtle">
        {assignments.length === 0 ? (
          <li className="py-3 text-sm text-text-body">No one is assigned to a branch yet.</li>
        ) : (
          assignments.map((assignment) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              key={assignment.id}
            >
              <p className="text-sm text-text-body">
                {assignment.userName} at {assignment.branchName}
              </p>
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onUnassign(assignment.id)}
              >
                Unassign
              </Button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

export function BranchAssignmentsConsole({ initial }: { initial: BranchAssignmentView }) {
  const [notice, setNotice] = useState<string | null>(null);
  const list = trpc.pharmacyBranchAssignments.list.useQuery(undefined, { initialData: initial });
  const assign = trpc.pharmacyBranchAssignments.assign.useMutation({
    onSuccess: async () => {
      setNotice('Assignment saved.');
      await list.refetch();
    },
    onError: (error) => setNotice(error.message),
  });
  const unassign = trpc.pharmacyBranchAssignments.unassign.useMutation({
    onSuccess: async () => {
      setNotice('Assignment removed.');
      await list.refetch();
    },
    onError: (error) => setNotice(error.message),
  });
  const data = list.data ?? initial;
  return (
    <BranchAssignmentsPanel
      assignments={data.assignments}
      branches={data.branches}
      members={data.members}
      notice={notice}
      pending={assign.isPending || unassign.isPending}
      onAssign={(input) => assign.mutate(input)}
      onUnassign={(assignmentId) => unassign.mutate({ assignmentId })}
    />
  );
}
