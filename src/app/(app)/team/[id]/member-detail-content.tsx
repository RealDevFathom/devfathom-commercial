'use client';

import { useState, memo } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  ArrowLeft,
  Mail,
  Phone,
  Calendar,
  FolderKanban,
  CheckSquare,
  Circle,
  Users,
  Pencil,
  Save,
  X,
  Loader2,
  Lock,
  UserX,
  Eye,
  EyeOff,
  CheckCircle2,
  Clock as ClockIcon,
  Timer,
  MessageSquare,
  Flame,
  Sparkles,
  Activity,
  TrendingUp,
  TrendingDown,
  ClipboardList,
  Trash2,
  Send,
  Gauge,
  ScrollText,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Textarea } from '@/components/ui/textarea';
import { useEntitlements } from '@/components/entitlements-provider';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';
import { inviteCopyForVertical } from '@/lib/team/invite-copy';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

const priorityConfig: Record<string, { color: string }> = {
  URGENT: { color: 'text-red-500' },
  HIGH: { color: 'text-primary' },
  MEDIUM: { color: 'text-amber-500' },
  LOW: { color: 'text-muted-foreground' },
};

const leaveStatusConfig: Record<string, { bg: string; label: string }> = {
  PENDING: { bg: 'bg-amber-500/10 text-amber-500', label: 'Pending' },
  APPROVED: { bg: 'bg-emerald-500/10 text-emerald-500', label: 'Approved' },
  REJECTED: { bg: 'bg-red-500/10 text-red-500', label: 'Rejected' },
};

// IMP-HR-01: per-type styling for the read-only leave-balances block.
const leaveTypeBalanceConfig: Record<string, { label: string; tint: string; bar: string }> = {
  VACATION: { label: 'Vacation', tint: 'bg-blue-500/10 text-blue-500', bar: 'bg-blue-500' },
  SICK: { label: 'Sick', tint: 'bg-red-500/10 text-red-500', bar: 'bg-red-500' },
  REMOTE: { label: 'Remote', tint: 'bg-violet-500/10 text-violet-500', bar: 'bg-violet-500' },
};

const roleBadge: Record<string, { bg: string; label: string }> = {
  ADMIN: { bg: 'bg-primary/10 text-primary', label: 'Admin' },
  HR: { bg: 'bg-indigo-500/10 text-indigo-500', label: 'HR' },
  EMPLOYEE: { bg: 'bg-secondary text-foreground', label: 'Employee' },
};

const projectStatusColors: Record<string, string> = {
  ACTIVE: 'text-emerald-500',
  IN_DEVELOPMENT: 'text-blue-500',
  ON_HOLD: 'text-amber-500',
  COMPLETED: 'text-muted-foreground',
};

type RouterOutput = inferRouterOutputs<AppRouter>;
type Member = NonNullable<RouterOutput['team']['getById']>;
type PersonalStats = RouterOutput['teamStats']['getForUser'];
type PerformanceNotes = RouterOutput['team']['listPerformanceNotes'];
type LeaveBalances = RouterOutput['team']['getLeaveBalances'];

export function MemberDetailContent({ memberId }: { memberId: string }) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const { data: member, isLoading } = trpc.team.getById.useQuery({ id: memberId });

  // Hoisted so they batch with getById on mount instead of waterfalling behind
  // it. Gated to the same self-or-admin visibility the blocks render under, so
  // no extra requests are issued for users who can't see these sections.
  const canViewPersonal = session?.user?.id === memberId || isAdmin;
  const statsQuery = trpc.teamStats.getForUser.useQuery(
    { userId: memberId },
    { staleTime: 60_000, enabled: canViewPersonal }
  );
  const notesQuery = trpc.team.listPerformanceNotes.useQuery(
    { userId: memberId },
    { enabled: canViewPersonal }
  );
  // IMP-HR-01: read-only leave balances for the current year. The server forces
  // a normal employee to their own record, so this is safe under canViewPersonal.
  const balancesQuery = trpc.team.getLeaveBalances.useQuery(
    { userId: memberId },
    { enabled: canViewPersonal }
  );

  const [isEditing, setIsEditing] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [showLayOff, setShowLayOff] = useState(false);

  // Show the member's name in the topbar breadcrumb instead of the raw id.
  useBreadcrumbLabel(memberId, member?.name);

  if (isLoading)
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-28 mb-4" />
        <Skeleton className="h-9 w-48" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2 border-border/60">
            <CardContent className="p-6">
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="p-6">
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  if (!member)
    return (
      <div className="flex flex-col items-center py-32">
        <Users className="h-16 w-16 text-muted-foreground/20" />
        <h2 className="mt-4 font-display text-xl font-semibold text-foreground">
          Member not found
        </h2>
        <Link href="/team" className="mt-6 text-sm font-medium text-primary hover:underline">
          Back to Team
        </Link>
      </div>
    );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/team"
          className="mb-5 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Team
        </Link>

        <PageHeader
          eyebrow="FIRM"
          className="mb-0"
          media={
            <Avatar className="h-16 w-16 sm:h-20 sm:w-20">
              <AvatarImage src={member.avatar ?? undefined} />
              <AvatarFallback className="bg-secondary text-xl font-bold text-foreground sm:text-2xl">
                {member.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')}
              </AvatarFallback>
            </Avatar>
          }
          heading={<span className="min-w-0 break-words">{member.name}</span>}
          description={
            <span className="block space-y-2">
              <span className="block text-[0.9375rem] font-medium text-text-strong">
                {member.title}
              </span>
              {(member.email || member.phone) && (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {member.email && (
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" />
                      {member.email}
                    </span>
                  )}
                  {member.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {member.phone}
                    </span>
                  )}
                </span>
              )}
              {member.bio && <span className="block max-w-xl leading-relaxed">{member.bio}</span>}
              {member.skills.length > 0 && (
                <span className="flex flex-wrap gap-1.5 pt-1">
                  {member.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {skill}
                    </span>
                  ))}
                </span>
              )}
            </span>
          }
          actions={
            isAdmin ? (
              <>
                <MemberAuditLink memberId={memberId} />
                {memberId !== session?.user?.id && (
                  <>
                    <Button variant="outline" size="lg" onClick={() => setIsEditing(true)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => setShowResetPw(!showResetPw)}
                    >
                      <Lock className="h-3.5 w-3.5" /> Reset Password
                    </Button>
                    <Button variant="destructive" size="lg" onClick={() => setShowLayOff(true)}>
                      <UserX className="h-3.5 w-3.5" /> Lay off
                    </Button>
                  </>
                )}
              </>
            ) : undefined
          }
        />
      </div>

      {/* Reset password form */}
      {showResetPw && isAdmin && (
        <ResetPasswordForm
          memberId={memberId}
          memberName={member.name}
          onClose={() => setShowResetPw(false)}
          onSuccess={() => {
            setShowResetPw(false);
            setPwSuccess(true);
            setTimeout(() => setPwSuccess(false), 3000);
          }}
        />
      )}
      {pwSuccess && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-500">
          Password has been reset successfully.
        </div>
      )}

      {/* Edit form */}
      {isEditing && isAdmin && (
        <EditMemberForm memberId={memberId} member={member} onClose={() => setIsEditing(false)} />
      )}

      {/* Lay off (termination) modal */}
      {isAdmin && (
        <LayOffDialog
          memberId={memberId}
          memberName={member.name}
          open={showLayOff}
          onOpenChange={setShowLayOff}
        />
      )}

      {/* Personal stats — visible to self or admin */}
      {canViewPersonal && (
        <PersonalStatsBlock
          data={statsQuery.data}
          isLoading={statsQuery.isLoading}
          isError={statsQuery.isError}
        />
      )}

      {/* Leave balances — IMP-HR-01; visible to self or admin */}
      {canViewPersonal && (
        <LeaveBalancesBlock data={balancesQuery.data} isLoading={balancesQuery.isLoading} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Projects */}
        <Card className="lg:col-span-2 border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
                <FolderKanban className="h-3.5 w-3.5 text-blue-500" />
              </div>
              {/* A colleague's list holds only what this viewer could see anyway. */}
              {member.workScope.projects === 'SHARED' ? 'Shared projects' : 'Projects'} (
              {member.projectMembers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {member.projectMembers.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {member.workScope.projects === 'SHARED'
                  ? 'No projects you share'
                  : 'No projects assigned'}
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {member.projectMembers.map((pm) => {
                  return (
                    <Link
                      key={pm.project.id}
                      href={`/projects/${pm.project.id}`}
                      className="flex items-center justify-between py-3 group hover:bg-secondary/30 -mx-6 px-6 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                          {pm.project.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {pm.project.type === 'CLIENT' ? 'Client' : 'Internal'} &middot; {pm.role}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'text-xs font-medium',
                          projectStatusColors[pm.project.status]
                        )}
                      >
                        {pm.project.status.replace('_', ' ')}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Info + Tasks */}
        <div className="space-y-5">
          <Card className="border-border/60">
            <CardContent className="p-5 space-y-3">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Department
                </p>
                <p className="text-sm font-medium text-foreground">
                  {member.department.charAt(0) + member.department.slice(1).toLowerCase()}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Role
                </p>
                <span
                  className={cn(
                    'inline-flex rounded-md px-2 py-0.5 text-xs font-medium',
                    roleBadge[member.role]?.bg ?? 'bg-secondary text-foreground'
                  )}
                >
                  {roleBadge[member.role]?.label ?? member.role}
                </span>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Start Date
                </p>
                <p className="text-sm font-medium text-foreground">
                  {format(new Date(member.startDate), 'MMM d, yyyy')}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Status
                </p>
                <p
                  className={cn(
                    'text-sm font-medium',
                    member.status === 'ACTIVE'
                      ? 'text-emerald-500'
                      : member.status === 'ON_LEAVE'
                        ? 'text-amber-500'
                        : 'text-muted-foreground'
                  )}
                >
                  {member.status}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
                  <CheckSquare className="h-3.5 w-3.5 text-primary" />
                </div>
                {member.workScope.tasks === 'VISIBLE' ? 'Tasks you can see' : 'Tasks'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {member.assignedTasks.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {member.workScope.tasks === 'VISIBLE'
                    ? 'No tasks you can see'
                    : 'No tasks assigned'}
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {member.assignedTasks.map((at) => (
                    <div key={at.task.id} className="flex items-center gap-2 py-2.5">
                      <Circle
                        className={cn('h-3 w-3 shrink-0', priorityConfig[at.task.priority]?.color)}
                        fill="currentColor"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{at.task.title}</p>
                        <p className="text-[11px] text-muted-foreground">{at.task.column.name}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Leave requests */}
      {member.leaveRequests &&
        (
          member.leaveRequests as Array<{
            id: string;
            type: string;
            startDate: Date;
            endDate: Date;
            status: string;
            reason: string | null;
          }>
        ).length > 0 && (
          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10">
                  <Calendar className="h-3.5 w-3.5 text-amber-500" />
                </div>
                Leave History
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border/60">
                {(
                  member.leaveRequests as Array<{
                    id: string;
                    type: string;
                    startDate: Date;
                    endDate: Date;
                    status: string;
                    reason: string | null;
                  }>
                ).map((lr) => {
                  const lc = leaveStatusConfig[lr.status] || leaveStatusConfig.PENDING;
                  return (
                    <div key={lr.id} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {lr.type.charAt(0) + lr.type.slice(1).toLowerCase()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(lr.startDate), 'MMM d')} –{' '}
                          {format(new Date(lr.endDate), 'MMM d, yyyy')}
                          {lr.reason ? ` · ${lr.reason}` : ''}
                        </p>
                      </div>
                      <span
                        className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', lc.bg)}
                      >
                        {lc.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

      {/* Performance notes — visible to self or admins; admins can write */}
      {canViewPersonal && (
        <PerformanceNotesBlock
          userId={memberId}
          canWrite={isAdmin}
          currentUserId={session?.user?.id ?? ''}
          notes={notesQuery.data}
          isLoading={notesQuery.isLoading}
        />
      )}
    </div>
  );
}

/* ============================================
   Admin-only forms — own their local input state so typing doesn't re-render
   the whole profile page.
   ============================================ */

// Lay off (terminate) a team member. Captures a mandatory reason, then soft-
// terminates them (status → INACTIVE) and emails them a notice via the server.
function LayOffDialog({
  memberId,
  memberName,
  open,
  onOpenChange,
}: {
  memberId: string;
  memberName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState('');

  const layOff = trpc.team.layOffMember.useMutation({
    onSuccess: () => {
      utils.team.getById.invalidate({ id: memberId });
      utils.team.getAll.invalidate();
      setReason('');
      onOpenChange(false);
    },
  });

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !layOff.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (layOff.isPending) return;
        if (!v) {
          setReason('');
          layOff.reset();
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-red-500">
            <UserX className="h-4 w-4" /> Lay off {memberName}
          </DialogTitle>
          <DialogDescription>
            This deactivates {memberName}&apos;s access and emails them a termination notice. Their
            record is kept for audit history. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label className="mb-1 block text-xs font-medium text-foreground">
            Reason <span className="text-destructive">*</span>
          </label>
          <Textarea
            autoFocus
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this person being laid off? (required)"
            disabled={layOff.isPending}
          />
          {layOff.error && <p className="mt-2 text-xs text-destructive">{layOff.error.message}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button
            variant="destructive"
            onClick={() => {
              if (!canSubmit) return;
              layOff.mutate({ id: memberId, reason: trimmed });
            }}
            disabled={!canSubmit}
          >
            {layOff.isPending && <Loader2 className="animate-spin" />}
            {layOff.isPending ? 'Laying off...' : 'Lay off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordForm({
  memberId,
  memberName,
  onClose,
  onSuccess,
}: {
  memberId: string;
  memberName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [showPw, setShowPw] = useState(false);

  const resetPassword = trpc.team.adminResetPassword.useMutation({
    onSuccess: () => {
      setNewPassword('');
      onSuccess();
    },
  });

  return (
    <Card className="border-amber-500/20">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-amber-500" /> Reset Password for {memberName}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <input
              type={showPw ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newPassword.length >= 8)
                  resetPassword.mutate({ id: memberId, newPassword });
              }}
              placeholder="New password (min 8 chars)"
              className="w-full rounded-xl border border-border bg-background px-4 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              aria-pressed={showPw}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            onClick={() => resetPassword.mutate({ id: memberId, newPassword })}
            disabled={newPassword.length < 8 || resetPassword.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {resetPassword.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Reset
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function EditMemberForm({
  memberId,
  member,
  onClose,
}: {
  memberId: string;
  member: Member;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const copy = inviteCopyForVertical(useEntitlements().vertical);
  const departmentQuery = trpc.organizationAdmin.departments.useQuery(undefined, { retry: false });
  const [editName, setEditName] = useState(member.name);
  const [editTitle, setEditTitle] = useState(member.title);
  const [editDept, setEditDept] = useState<string>(member.department);
  const [editRole, setEditRole] = useState<string>(member.role);
  const [editPhone, setEditPhone] = useState(member.phone || '');
  const [editBio, setEditBio] = useState(member.bio || '');
  const [editSkillInput, setEditSkillInput] = useState('');
  const [editSkills, setEditSkills] = useState<string[]>(member.skills);
  // Tenant department catalog: active entries, plus the member's current
  // department so an inactive or legacy value is still shown and kept.
  const departmentOptions = (departmentQuery.data ?? [])
    .filter((item) => item.active || item.key === member.department)
    .map((item) => ({ key: item.key, name: item.name }));
  if (!departmentOptions.some((item) => item.key === member.department))
    departmentOptions.unshift({
      key: member.department,
      name: member.department.charAt(0) + member.department.slice(1).toLowerCase(),
    });

  const updateMember = trpc.team.adminUpdateMember.useMutation({
    onSuccess: () => {
      utils.team.getById.invalidate({ id: memberId });
      utils.team.getAll.invalidate();
      onClose();
    },
  });

  return (
    <Card className="border-primary/20">
      <CardContent className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Edit Member</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Name</label>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Title</label>
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Department</label>
            <select
              value={editDept}
              onChange={(e) => setEditDept(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {departmentOptions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Role</label>
            <div className="flex rounded-xl border border-border overflow-hidden">
              {(['EMPLOYEE', 'HR', 'ADMIN'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setEditRole(r)}
                  className={cn(
                    'flex-1 py-2 text-xs font-medium transition-colors',
                    editRole === r
                      ? 'bg-foreground text-background'
                      : 'bg-card text-muted-foreground hover:text-foreground'
                  )}
                >
                  {copy.baseRoleLabels[r]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Phone</label>
            <input
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Status</label>
            <select
              defaultValue={member.status}
              onChange={(e) =>
                updateMember.mutate({
                  id: memberId,
                  status: e.target.value as 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE',
                })
              }
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="ACTIVE">Active</option>
              <option value="ON_LEAVE">On Leave</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Bio</label>
          <textarea
            value={editBio}
            onChange={(e) => setEditBio(e.target.value)}
            rows={2}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Skills</label>
          <div className="flex gap-2">
            <input
              value={editSkillInput}
              onChange={(e) => setEditSkillInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const v = editSkillInput.trim();
                  if (v && !editSkills.includes(v)) {
                    setEditSkills([...editSkills, v]);
                    setEditSkillInput('');
                  }
                }
              }}
              placeholder="Add skill..."
              className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
          {editSkills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {editSkills.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {s}{' '}
                  <button
                    onClick={() => setEditSkills(editSkills.filter((sk) => sk !== s))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              updateMember.mutate({
                id: memberId,
                name: editName.trim() || undefined,
                title: editTitle.trim() || undefined,
                department: editDept,
                role: editRole as 'ADMIN' | 'HR' | 'EMPLOYEE',
                phone: editPhone || null,
                bio: editBio || null,
                skills: editSkills,
              })
            }
            disabled={updateMember.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {updateMember.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save Changes
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================
   Leave balances block — IMP-HR-01. Read-only entitled / used / remaining
   per leave type for the current year. Visible to the member or an admin.
   ============================================ */
const LeaveBalancesBlock = memo(function LeaveBalancesBlock({
  data,
  isLoading,
}: {
  data: LeaveBalances | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card className="border-border/60">
        <CardContent className="p-5">
          <Skeleton className="mb-4 h-4 w-32" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
            <Gauge className="h-3.5 w-3.5 text-blue-500" />
          </div>
          Leave balances · {data.year}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {data.types.map((t) => {
            const cfg = leaveTypeBalanceConfig[t.type] ?? leaveTypeBalanceConfig.VACATION;
            const pct =
              t.entitledDays > 0
                ? Math.min(100, Math.round((t.usedDays / t.entitledDays) * 100))
                : 0;
            const over = t.remaining < 0;
            return (
              <div key={t.type} className="rounded-xl border border-border/60 bg-background/50 p-4">
                <div className="flex items-center justify-between">
                  <span
                    className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', cfg.tint)}
                  >
                    {cfg.label}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t.usedDays} / {t.entitledDays}
                  </span>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      over ? 'bg-red-500' : cfg.bar
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p
                  className={cn(
                    'mt-2 text-sm font-semibold tabular-nums',
                    over ? 'text-red-500' : 'text-foreground'
                  )}
                >
                  {t.remaining} day{Math.abs(t.remaining) === 1 ? '' : 's'} {over ? 'over' : 'left'}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
});

/* ============================================
   Personal stats block — rendered on a member's profile page.
   Visible only to the member themselves or an admin.
   ============================================ */
const PersonalStatsBlock = memo(function PersonalStatsBlock({
  data,
  isLoading,
  isError,
}: {
  data: PersonalStats | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Card className="border-border/60">
        <CardContent className="p-5">
          <Skeleton className="h-4 w-32 mb-4" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) return null;
  const s = data;

  const delta = s.completedThisWeek - s.completedLastWeek;
  const maxSpark = Math.max(1, ...s.tasksDoneSparkline);

  const health =
    s.openTasks === 0
      ? {
          label: 'idle',
          bg: 'bg-red-500/10',
          dot: 'bg-red-500',
          text: 'text-red-500',
          icon: null as React.ReactNode,
        }
      : s.completedThisWeek === 0
        ? {
            label: 'stalled',
            bg: 'bg-amber-500/10',
            dot: 'bg-amber-500',
            text: 'text-amber-500',
            icon: null as React.ReactNode,
          }
        : s.completedThisWeek >= 5
          ? {
              label: 'on fire',
              bg: 'bg-orange-500/10',
              dot: 'bg-orange-500',
              text: 'text-orange-500',
              icon: <Flame className="h-3 w-3" />,
            }
          : {
              label: 'active',
              bg: 'bg-emerald-500/10',
              dot: 'bg-emerald-500',
              text: 'text-emerald-500',
              icon: <Sparkles className="h-3 w-3" />,
            };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              <Activity className="h-3.5 w-3.5 text-primary" />
            </div>
            Personal stats · this week
          </CardTitle>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
              health.bg,
              health.text
            )}
          >
            {health.icon}
            <div className={cn('h-1.5 w-1.5 rounded-full', health.dot)} />
            {health.label}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Primary metrics */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile icon={Activity} label="Open tasks" value={s.openTasks} tone="blue" />
          <StatTile
            icon={CheckCircle2}
            label="Completed"
            value={s.completedThisWeek}
            delta={delta}
            tone="emerald"
          />
          <StatTile
            icon={ClockIcon}
            label="Overdue"
            value={s.overdueTasks}
            tone={s.overdueTasks > 0 ? 'amber' : 'muted'}
          />
          <StatTile
            icon={Timer}
            label="Avg cycle"
            value={s.avgCycleTimeDays !== null ? `${s.avgCycleTimeDays}d` : '—'}
            tone="violet"
          />
        </div>

        {/* 7-day sparkline */}
        <div>
          <div className="flex items-end gap-1 h-10">
            {s.tasksDoneSparkline.map((count, i) => (
              <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
                <div
                  className={cn(
                    'w-full rounded-sm transition-all',
                    count === 0 ? 'bg-secondary' : 'bg-emerald-500/60'
                  )}
                  style={{ height: `${Math.max(8, (count / maxSpark) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/60 uppercase tracking-wider">
            {['6d', '5d', '4d', '3d', '2d', 'yest', 'today'].map((lbl) => (
              <span key={lbl} className="flex-1 text-center">
                {lbl}
              </span>
            ))}
          </div>
        </div>

        {/* Secondary metrics strip */}
        <div className="pt-3 border-t border-border/60 grid grid-cols-2 gap-4 sm:grid-cols-4 text-[12px]">
          <div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Timer className="h-3 w-3" />
              <span className="uppercase tracking-wider text-[10px] font-medium">Meetings</span>
            </div>
            <p className="mt-0.5 font-semibold text-foreground tabular-nums">
              {s.meetingsAttended}
              <span className="text-muted-foreground font-normal">/{s.meetingsInvited}</span>
            </p>
            {s.onTimePercent !== null && (
              <p className="text-[10px] text-emerald-500">{s.onTimePercent}% on time</p>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ClockIcon className="h-3 w-3" />
              <span className="uppercase tracking-wider text-[10px] font-medium">Punctuality</span>
            </div>
            <p className="mt-0.5 font-semibold text-foreground tabular-nums">
              {s.avgMinutesLate !== null ? `${s.avgMinutesLate}m` : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground">avg late</p>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              <span className="uppercase tracking-wider text-[10px] font-medium">Comments</span>
            </div>
            <p className="mt-0.5 font-semibold text-foreground tabular-nums">
              {s.commentsThisWeek}
            </p>
            <p className="text-[10px] text-muted-foreground">this week</p>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <FolderKanban className="h-3 w-3" />
              <span className="uppercase tracking-wider text-[10px] font-medium">Notes</span>
            </div>
            <p className="mt-0.5 font-semibold text-foreground tabular-nums">{s.notesAuthored}</p>
            <p className="text-[10px] text-muted-foreground">authored</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

/* ============================================
   Performance notes — admin-authored feedback, visible to admins + subject.
   Admins can add notes; only the author can delete their own notes.
   ============================================ */
const PerformanceNotesBlock = memo(function PerformanceNotesBlock({
  userId,
  canWrite,
  currentUserId,
  notes,
  isLoading,
}: {
  userId: string;
  canWrite: boolean;
  currentUserId: string;
  notes: PerformanceNotes | undefined;
  isLoading: boolean;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState('');

  const addNote = trpc.team.addPerformanceNote.useMutation({
    onSuccess: () => {
      utils.team.listPerformanceNotes.invalidate({ userId });
      setDraft('');
    },
  });
  const deleteNote = trpc.team.deletePerformanceNote.useMutation({
    onSuccess: () => utils.team.listPerformanceNotes.invalidate({ userId }),
  });

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10">
            <ClipboardList className="h-3.5 w-3.5 text-violet-500" />
          </div>
          Performance Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="flex gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a note — feedback, milestone, 1:1 takeaway..."
              rows={2}
              className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              onClick={() => {
                if (draft.trim()) addNote.mutate({ userId, content: draft.trim() });
              }}
              disabled={!draft.trim() || addNote.isPending}
              className="self-end flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
            >
              {addNote.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Add
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !notes || notes.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {notes.map((n) => (
              <div key={n.id} className="flex items-start gap-3 py-3 group">
                <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                  <AvatarImage src={n.author.avatar ?? undefined} />
                  <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
                    {n.author.name
                      .split(' ')
                      .map((p) => p[0])
                      .join('')}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-medium text-foreground">{n.author.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {format(new Date(n.createdAt), 'MMM d, yyyy')}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap leading-relaxed">
                    {n.content}
                  </p>
                </div>
                {canWrite && n.author.id === currentUserId && (
                  <button
                    onClick={() => deleteNote.mutate({ id: n.id })}
                    className="opacity-0 group-hover:opacity-100 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition-all"
                    title="Delete note"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

function StatTile({
  icon: Icon,
  label,
  value,
  delta,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  delta?: number;
  tone: 'emerald' | 'blue' | 'amber' | 'violet' | 'muted';
}) {
  const tones: Record<string, { bg: string; text: string }> = {
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-500' },
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
    violet: { bg: 'bg-violet-500/10', text: 'text-violet-500' },
    muted: { bg: 'bg-muted', text: 'text-muted-foreground' },
  };
  const t = tones[tone];

  return (
    <div className="rounded-xl border border-border/60 bg-background/50 p-3">
      <div className="flex items-center gap-2">
        <div className={cn('flex h-6 w-6 items-center justify-center rounded-md', t.bg)}>
          <Icon className={cn('h-3 w-3', t.text)} />
        </div>
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p className={cn('mt-1.5 font-display text-2xl font-bold tabular-nums', t.text)}>{value}</p>
      {delta !== undefined && delta !== 0 && (
        <p
          className={cn(
            'text-[10px] font-medium tabular-nums flex items-center gap-0.5',
            delta > 0 ? 'text-emerald-500' : 'text-amber-500'
          )}
        >
          {delta > 0 ? (
            <TrendingUp className="h-2.5 w-2.5" />
          ) : (
            <TrendingDown className="h-2.5 w-2.5" />
          )}
          {delta > 0 ? '+' : ''}
          {delta} vs last week
        </p>
      )}
    </div>
  );
}

/**
 * DEV-913: an administrator opens this person's actions in the audit log, on
 * any workspace that has it (every pharmacy does).
 */
function MemberAuditLink({ memberId }: { memberId: string }) {
  const entitlements = useEntitlements();
  if (!isModuleGranted('audit', entitlements.enabledModules, entitlements.vertical)) return null;
  return (
    <Button
      variant="outline"
      size="lg"
      nativeButton={false}
      role="link"
      render={<Link href={`/audit-logs?${new URLSearchParams({ actorId: memberId })}`} />}
    >
      <ScrollText className="h-3.5 w-3.5" /> See their actions
    </Button>
  );
}
