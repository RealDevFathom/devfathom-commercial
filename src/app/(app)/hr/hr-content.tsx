'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  CheckCircle2,
  XCircle,
  Plus,
  X,
  Loader2,
  UserCog,
  CalendarOff,
  CalendarClock,
  UserPlus,
  PartyPopper,
  Users,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Save,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { AppRouter } from '@/server/routers/_app';
import { format, formatDistanceToNow } from 'date-fns';

type LeaveRequest = inferRouterOutputs<AppRouter>['team']['getLeaveRequests'][number];
type ResignationRow = inferRouterOutputs<AppRouter>['resignations']['listAll'][number];

const statusConfig: Record<string, { bg: string; label: string }> = {
  PENDING: { bg: 'bg-amber-500/10 text-amber-500', label: 'Pending' },
  APPROVED: { bg: 'bg-emerald-500/10 text-emerald-500', label: 'Approved' },
  REJECTED: { bg: 'bg-red-500/10 text-red-500', label: 'Rejected' },
};

const typeConfig: Record<string, { bg: string; label: string }> = {
  VACATION: { bg: 'bg-blue-500/10 text-blue-500', label: 'Vacation' },
  SICK: { bg: 'bg-red-500/10 text-red-500', label: 'Sick' },
  REMOTE: { bg: 'bg-violet-500/10 text-violet-500', label: 'Remote' },
};

// IMP-HR-01: solid fill colors for balance progress bars + calendar legend dots.
const typeBarColor: Record<string, string> = {
  VACATION: 'bg-blue-500',
  SICK: 'bg-red-500',
  REMOTE: 'bg-violet-500',
};

const departmentColors: Record<string, string> = {
  LEADERSHIP: 'bg-primary/10 text-primary',
  ENGINEERING: 'bg-blue-500/10 text-blue-500',
  PRODUCT: 'bg-violet-500/10 text-violet-500',
  QUALITY: 'bg-amber-500/10 text-amber-500',
  MARKETING: 'bg-emerald-500/10 text-emerald-500',
  DESIGN: 'bg-pink-500/10 text-pink-500',
};

export function HRContent() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  // The /hr route is open to both ADMIN and HR — both review resignations.
  const isReviewer = isAdmin || session?.user?.role === 'HR';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="PEOPLE OPS"
        heading="HR"
        description="Leave, headcount, and people operations."
      />

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
          <TabsTrigger value="balances">Balances</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="resignations">Resignations</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <HrOverview isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="leave">
          <LeaveTab isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="balances">
          <BalancesTab />
        </TabsContent>

        <TabsContent value="calendar">
          <CalendarTab />
        </TabsContent>

        <TabsContent value="resignations">
          <ResignationsTab isReviewer={isReviewer} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============================================================
   Overview tab — at-a-glance HR stats
   ============================================================ */
function HrOverview({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading } = trpc.team.getHrOverview.useQuery(undefined, { enabled: isAdmin });

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">Overview is available to admins only.</p>;
  }

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border-border/60">
            <CardContent className="p-5">
              <Skeleton className="h-20 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stat tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={CalendarOff}
          label="Out today"
          value={data.outToday.length}
          tone="amber"
          hint={data.outToday.length === 0 ? 'Nobody out' : `${data.outToday.length} on leave`}
        />
        <StatTile
          icon={CalendarClock}
          label="Pending approvals"
          value={data.pendingLeaveTotal}
          tone={data.pendingLeaveTotal > 0 ? 'orange' : 'emerald'}
          hint={data.pendingLeaveTotal === 0 ? 'All clear' : 'Awaiting review'}
        />
        <StatTile
          icon={UserPlus}
          label="Recent hires"
          value={data.recentHires.length}
          tone="blue"
          hint="Last 30 days"
        />
        <StatTile
          icon={Users}
          label="Active headcount"
          value={data.activeHeadcount}
          tone="violet"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Out today */}
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10">
                <CalendarOff className="h-3.5 w-3.5 text-amber-500" />
              </div>
              Out today
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.outToday.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Everyone&apos;s in.</p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.outToday.map((lr) => {
                  const tc = typeConfig[lr.type] || typeConfig.VACATION;
                  return (
                    <Link
                      key={lr.id}
                      href={`/team/${lr.user.id}`}
                      className="flex items-center gap-3 py-3 group hover:bg-secondary/30 -mx-6 px-6 transition-colors"
                    >
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarImage src={lr.user.avatar ?? undefined} />
                        <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
                          {lr.user.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                          {lr.user.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Back {format(new Date(lr.endDate), 'MMM d')}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                          tc.bg
                        )}
                      >
                        {tc.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pending approvals */}
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-orange-500/10">
                <CalendarClock className="h-3.5 w-3.5 text-orange-500" />
              </div>
              Pending approvals
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.pendingLeave.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing pending.</p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.pendingLeave.map((lr) => {
                  const tc = typeConfig[lr.type] || typeConfig.VACATION;
                  return (
                    <div key={lr.id} className="flex items-center gap-3 py-3">
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarImage src={lr.user.avatar ?? undefined} />
                        <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
                          {lr.user.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {lr.user.name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {format(new Date(lr.startDate), 'MMM d')} –{' '}
                          {format(new Date(lr.endDate), 'MMM d')}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                          tc.bg
                        )}
                      >
                        {tc.label}
                      </span>
                    </div>
                  );
                })}
                {data.pendingLeaveTotal > data.pendingLeave.length && (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    + {data.pendingLeaveTotal - data.pendingLeave.length} more
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent hires */}
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
                <UserPlus className="h-3.5 w-3.5 text-blue-500" />
              </div>
              Recent hires
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentHires.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No hires in the last 30 days.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.recentHires.map((u) => (
                  <Link
                    key={u.id}
                    href={`/team/${u.id}`}
                    className="flex items-center gap-3 py-3 group hover:bg-secondary/30 -mx-6 px-6 transition-colors"
                  >
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={u.avatar ?? undefined} />
                      <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
                        {u.name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                        {u.name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{u.title}</p>
                    </div>
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[10px] font-medium shrink-0',
                        departmentColors[u.department] ?? 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {u.department.charAt(0) + u.department.slice(1).toLowerCase()}
                    </span>
                    <span className="text-[11px] text-muted-foreground shrink-0 hidden sm:inline">
                      {formatDistanceToNow(new Date(u.startDate), { addSuffix: true })}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming anniversaries */}
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-pink-500/10">
                <PartyPopper className="h-3.5 w-3.5 text-pink-500" />
              </div>
              Upcoming anniversaries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.upcomingAnniversaries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing in the next 30 days.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.upcomingAnniversaries.map((u) => (
                  <Link
                    key={u.id}
                    href={`/team/${u.id}`}
                    className="flex items-center gap-3 py-3 group hover:bg-secondary/30 -mx-6 px-6 transition-colors"
                  >
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={u.avatar ?? undefined} />
                      <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
                        {u.name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                        {u.name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{u.title}</p>
                    </div>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {u.years}y on {format(new Date(u.anniversaryDate), 'MMM d')}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ============================================================
   Leave tab — preserved from the original HR page
   ============================================================ */
function LeaveTab({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const { data: leaveRequests, isLoading } = trpc.team.getLeaveRequests.useQuery(undefined, {
    enabled: isAdmin,
  });
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');

  const updateStatus = trpc.team.updateLeaveStatus.useMutation({
    onSuccess: () => {
      utils.team.getLeaveRequests.invalidate();
      utils.team.getHrOverview.invalidate();
    },
  });
  const createLeave = trpc.team.createLeaveRequest.useMutation({
    onSuccess: () => {
      utils.team.getLeaveRequests.invalidate();
      utils.team.getHrOverview.invalidate();
      setShowCreate(false);
    },
  });
  // IMP-HR-03: withdraw your own pending request.
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const cancelLeave = trpc.team.cancelLeaveRequest.useMutation({
    onSuccess: () => {
      utils.team.getLeaveRequests.invalidate();
      utils.team.getHrOverview.invalidate();
    },
  });

  const [leaveType, setLeaveType] = useState<'VACATION' | 'SICK' | 'REMOTE'>('VACATION');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const filtered = useMemo(
    () => leaveRequests?.filter((lr) => filter === 'ALL' || lr.status === filter) ?? [],
    [leaveRequests, filter]
  );
  const pendingCount = useMemo(
    () => leaveRequests?.filter((lr) => lr.status === 'PENDING').length ?? 0,
    [leaveRequests]
  );

  const handleUpdateStatus = useCallback(
    (id: string, status: 'APPROVED' | 'REJECTED') => updateStatus.mutate({ id, status }),
    [updateStatus]
  );

  // Virtualize the leave-history list — it can grow to hundreds of rows.
  const parentRef = useRef<HTMLDivElement>(null);
  // React Compiler intentionally leaves TanStack Virtual in manual mode.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 73,
    overscan: 8,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {pendingCount > 0
            ? `${pendingCount} pending request${pendingCount !== 1 ? 's' : ''}`
            : 'All requests processed'}
          .
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" /> Request Leave
        </button>
      </div>

      {showCreate && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">New Leave Request</h3>
              <button
                onClick={() => setShowCreate(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Type</label>
                <select
                  value={leaveType}
                  onChange={(e) => setLeaveType(e.target.value as typeof leaveType)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="VACATION">Vacation</option>
                  <option value="SICK">Sick Leave</option>
                  <option value="REMOTE">Remote Work</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Start Date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">End Date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Reason (optional)
              </label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Brief reason..."
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (startDate && endDate)
                    createLeave.mutate({
                      type: leaveType,
                      startDate: new Date(startDate),
                      endDate: new Date(endDate),
                      reason: reason || undefined,
                    });
                }}
                disabled={!startDate || !endDate || createLeave.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createLeave.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  'Submit Request'
                )}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-1.5">
        {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <UserCog className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No leave requests</p>
            </div>
          ) : (
            <div ref={parentRef} className="max-h-[70vh] overflow-y-auto">
              <div
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                className="relative w-full"
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const lr = filtered[virtualRow.index];
                  return (
                    <div
                      key={lr.id}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      className="absolute left-0 top-0 w-full border-b border-border/60 last:border-b-0"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <LeaveRow
                        lr={lr}
                        isAdmin={isAdmin}
                        currentUserId={currentUserId}
                        onUpdateStatus={handleUpdateStatus}
                        onCancel={(id) => cancelLeave.mutate({ id })}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================================================
   Leave row — memoized; rendered inside the virtualized list
   ============================================================ */
const LeaveRow = memo(function LeaveRow({
  lr,
  isAdmin,
  currentUserId,
  onUpdateStatus,
  onCancel,
}: {
  lr: LeaveRequest;
  isAdmin: boolean;
  currentUserId?: string;
  onUpdateStatus: (id: string, status: 'APPROVED' | 'REJECTED') => void;
  onCancel: (id: string) => void;
}) {
  const sc = statusConfig[lr.status] || statusConfig.PENDING;
  const tc = typeConfig[lr.type] || typeConfig.VACATION;
  const initials = lr.user.name
    .split(' ')
    .map((n) => n[0])
    .join('');
  const dateRange = `${format(new Date(lr.startDate), 'MMM d')} – ${format(new Date(lr.endDate), 'MMM d, yyyy')}`;

  return (
    <div className="flex items-center gap-4 px-6 py-4">
      <Link href={`/team/${lr.user.id}`} className="shrink-0">
        <Avatar className="h-10 w-10">
          <AvatarImage src={lr.user.avatar ?? undefined} />
          <AvatarFallback className="bg-secondary text-foreground font-medium text-sm">
            {initials}
          </AvatarFallback>
        </Avatar>
      </Link>
      <div className="flex-1 min-w-0">
        <Link
          href={`/team/${lr.user.id}`}
          className="text-sm font-semibold text-foreground hover:text-primary transition-colors"
        >
          {lr.user.name}
        </Link>
        <p className="text-xs text-muted-foreground">
          {dateRange}
          {lr.reason ? ` · ${lr.reason}` : ''}
        </p>
      </div>
      <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0', tc.bg)}>
        {tc.label}
      </span>
      <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0', sc.bg)}>
        {sc.label}
      </span>
      {lr.status === 'PENDING' && (
        <div className="flex items-center gap-1 shrink-0">
          {/* HR-01: a reviewer can't decide their OWN request — only others'. */}
          {isAdmin && lr.user.id !== currentUserId && (
            <>
              <button
                onClick={() => onUpdateStatus(lr.id, 'APPROVED')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                title="Approve"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => onUpdateStatus(lr.id, 'REJECTED')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                title="Reject"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </>
          )}
          {/* IMP-HR-03: withdraw your OWN pending request. */}
          {lr.user.id === currentUserId && (
            <button
              onClick={() => onCancel(lr.id)}
              className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition-colors"
              title="Withdraw my request"
            >
              Withdraw
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/* ============================================================
   Balances tab — IMP-HR-01. HR/Admin pick a member + year, see
   entitled / used / remaining per leave type, and edit entitlements.
   ============================================================ */
function BalancesTab() {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const { data: roster } = trpc.team.getRoster.useQuery();
  const currentYear = new Date().getFullYear();
  const [selectedUserId, setSelectedUserId] = useState('');
  const [year, setYear] = useState(currentYear);
  const userId = selectedUserId || session?.user?.id || '';

  const { data, isLoading } = trpc.team.getLeaveBalances.useQuery(
    { userId, year },
    { enabled: !!userId }
  );

  const setBalance = trpc.team.setLeaveBalance.useMutation({
    onSuccess: () => {
      utils.team.getLeaveBalances.invalidate();
      utils.team.getHrOverview.invalidate();
    },
  });

  const yearOptions = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Member</label>
          <select
            value={userId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="min-w-[14rem] rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          >
            {(roster ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Year</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-5">
                <Skeleton className="h-28 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {data.types.map((t) => (
            <BalanceCard
              key={`${t.type}-${t.entitledDays}`}
              type={t.type}
              entitledDays={t.entitledDays}
              usedDays={t.usedDays}
              remaining={t.remaining}
              saving={setBalance.isPending}
              onSave={(entitledDays) =>
                setBalance.mutate({ userId, year, type: t.type, entitledDays })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BalanceCard({
  type,
  entitledDays,
  usedDays,
  remaining,
  saving,
  onSave,
}: {
  type: 'VACATION' | 'SICK' | 'REMOTE';
  entitledDays: number;
  usedDays: number;
  remaining: number;
  saving: boolean;
  onSave: (entitledDays: number) => void;
}) {
  const tc = typeConfig[type] ?? typeConfig.VACATION;
  const bar = typeBarColor[type] ?? typeBarColor.VACATION;
  const [draft, setDraft] = useState(String(entitledDays));
  const pct = entitledDays > 0 ? Math.min(100, Math.round((usedDays / entitledDays) * 100)) : 0;
  const over = remaining < 0;
  const parsed = Number(draft);
  const dirty = draft.trim() !== '' && Number.isFinite(parsed) && parsed !== entitledDays;

  return (
    <Card className="border-border/60">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', tc.bg)}>
            {tc.label}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {usedDays} / {entitledDays} used
          </span>
        </div>

        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : bar)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p
            className={cn(
              'mt-2 text-sm font-semibold tabular-nums',
              over ? 'text-red-500' : 'text-foreground'
            )}
          >
            {remaining} day{Math.abs(remaining) === 1 ? '' : 's'} {over ? 'over' : 'remaining'}
          </p>
        </div>

        <div className="flex items-end gap-2 pt-1">
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Entitled days
            </label>
            <Input
              type="number"
              min={0}
              max={366}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              if (dirty) onSave(Math.max(0, Math.min(366, Math.round(parsed))));
            }}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================================
   Calendar tab — IMP-HR-01. Lightweight month grid of who is off
   when, built from getTeamLeaveCalendar (no calendar library).
   ============================================================ */
function CalendarTab() {
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [includePending, setIncludePending] = useState(false);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);

  const { data, isLoading } = trpc.team.getTeamLeaveCalendar.useQuery({
    startDate: monthStart,
    endDate: monthEnd,
    includePending,
  });

  const daysInMonth = monthEnd.getDate();
  const leadingBlanks = monthStart.getDay(); // 0 = Sunday
  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const dayMs = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayMs = dayMs(new Date());

  const offForDay = (day: number) => {
    const cellMs = new Date(cursor.getFullYear(), cursor.getMonth(), day).getTime();
    return (data ?? []).filter(
      (lr) => cellMs >= dayMs(new Date(lr.startDate)) && cellMs <= dayMs(new Date(lr.endDate))
    );
  };

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            title="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-foreground">
            {format(cursor, 'MMMM yyyy')}
          </span>
          <button
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            title="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            type="checkbox"
            checked={includePending}
            onChange={(e) => setIncludePending(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-primary"
          />
          Include pending
        </label>
      </div>

      <Card className="border-border/60">
        <CardContent className="p-4">
          {isLoading ? (
            <Skeleton className="h-[26rem] w-full" />
          ) : (
            <>
              <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                {weekdays.map((w) => (
                  <div
                    key={w}
                    className="text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {cells.map((day, i) => {
                  if (day === null)
                    return <div key={`b-${i}`} className="min-h-[5.5rem] rounded-lg" />;
                  const off = offForDay(day);
                  const isToday =
                    new Date(cursor.getFullYear(), cursor.getMonth(), day).getTime() === todayMs;
                  return (
                    <div
                      key={day}
                      className={cn(
                        'flex min-h-[5.5rem] flex-col gap-1 rounded-lg border p-1.5',
                        isToday ? 'border-primary/40 bg-primary/5' : 'border-border/60'
                      )}
                    >
                      <span
                        className={cn(
                          'text-[11px] font-medium tabular-nums',
                          isToday ? 'text-primary' : 'text-muted-foreground'
                        )}
                      >
                        {day}
                      </span>
                      <div className="flex flex-col gap-0.5 overflow-hidden">
                        {off.slice(0, 3).map((lr) => {
                          const tc = typeConfig[lr.type] ?? typeConfig.VACATION;
                          return (
                            <Link
                              key={lr.id}
                              href={`/team/${lr.user.id}`}
                              title={`${lr.user.name} · ${tc.label}${lr.status === 'PENDING' ? ' (pending)' : ''}`}
                              className={cn(
                                'flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80',
                                tc.bg,
                                lr.status === 'PENDING' && 'opacity-60'
                              )}
                            >
                              <span className="truncate">{lr.user.name.split(' ')[0]}</span>
                            </Link>
                          );
                        })}
                        {off.length > 3 && (
                          <span className="px-1 text-[10px] text-muted-foreground">
                            +{off.length - 3} more
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {(['VACATION', 'SICK', 'REMOTE'] as const).map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={cn('h-2.5 w-2.5 rounded-full', typeBarColor[t])} />
            {typeConfig[t].label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Stat tile — used on the overview grid
   ============================================================ */
function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  hint?: string;
  tone: 'emerald' | 'blue' | 'amber' | 'orange' | 'violet';
}) {
  const tones: Record<string, { bg: string; text: string }> = {
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-500' },
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
    orange: { bg: 'bg-orange-500/10', text: 'text-orange-500' },
    violet: { bg: 'bg-violet-500/10', text: 'text-violet-500' },
  };
  const t = tones[tone];

  return (
    <Card className="border-border/60">
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <div className={cn('flex h-7 w-7 items-center justify-center rounded-md', t.bg)}>
            <Icon className={cn('h-3.5 w-3.5', t.text)} />
          </div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
        </div>
        <p className={cn('mt-2 font-display text-3xl font-bold tabular-nums', t.text)}>{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   Resignations tab — ADMIN/HR review queue
   ============================================================ */
type ReviewTarget = {
  id: string;
  name: string;
  proposedLastDay: Date;
  decision: 'APPROVED' | 'DECLINED';
};

function ResignationsTab({ isReviewer }: { isReviewer: boolean }) {
  const { data, isLoading } = trpc.resignations.listAll.useQuery(
    { status: 'PENDING' },
    { enabled: isReviewer }
  );
  const [target, setTarget] = useState<ReviewTarget | null>(null);

  const openReview = useCallback(
    (row: ResignationRow, decision: 'APPROVED' | 'DECLINED') =>
      setTarget({
        id: row.id,
        name: row.user.name,
        proposedLastDay: new Date(row.proposedLastDay),
        decision,
      }),
    []
  );

  if (!isReviewer) {
    return (
      <p className="text-sm text-muted-foreground">
        Resignations are available to HR and admins only.
      </p>
    );
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-destructive/10">
            <LogOut className="h-3.5 w-3.5 text-destructive" />
          </div>
          Resignations
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">Pending requests awaiting your review.</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <div className="py-16 text-center">
            <LogOut className="mx-auto h-10 w-10 text-muted-foreground/20" />
            <p className="mt-3 text-sm text-muted-foreground">No pending resignations</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {data.map((row) => (
              <ResignationReviewRow key={row.id} row={row} onReview={openReview} />
            ))}
          </div>
        )}
      </CardContent>

      <ReviewResignationDialog
        key={target ? `${target.id}-${target.decision}` : 'closed'}
        target={target}
        onClose={() => setTarget(null)}
      />
    </Card>
  );
}

function ResignationReviewRow({
  row,
  onReview,
}: {
  row: ResignationRow;
  onReview: (row: ResignationRow, decision: 'APPROVED' | 'DECLINED') => void;
}) {
  const initials = row.user.name
    .split(' ')
    .map((n) => n[0])
    .join('');
  const dept = row.user.department;

  return (
    <div className="flex items-start gap-3 py-4">
      <Link href={`/team/${row.user.id}`} className="shrink-0">
        <Avatar className="h-10 w-10">
          <AvatarImage src={row.user.avatar ?? undefined} />
          <AvatarFallback className="bg-secondary text-foreground font-medium text-sm">
            {initials}
          </AvatarFallback>
        </Avatar>
      </Link>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/team/${row.user.id}`}
            className="text-sm font-semibold text-foreground hover:text-primary transition-colors"
          >
            {row.user.name}
          </Link>
          {dept && (
            <span
              className={cn(
                'rounded-md px-2 py-0.5 text-[10px] font-medium',
                departmentColors[dept] ?? 'bg-secondary text-muted-foreground'
              )}
            >
              {dept.charAt(0) + dept.slice(1).toLowerCase()}
            </span>
          )}
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {row.user.role}
          </span>
        </div>
        {row.user.title && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{row.user.title}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          Proposed last day {format(new Date(row.proposedLastDay), 'MMM d, yyyy')} · submitted{' '}
          {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
        </p>
        <p className="text-sm text-foreground mt-2 whitespace-pre-wrap leading-relaxed">
          &ldquo;{row.reason}&rdquo;
        </p>
        <div className="flex items-center gap-2 mt-3">
          <Button size="sm" onClick={() => onReview(row, 'APPROVED')}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onReview(row, 'DECLINED')}>
            <XCircle className="h-3.5 w-3.5" /> Decline
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewResignationDialog({
  target,
  onClose,
}: {
  target: ReviewTarget | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState('');
  const [lastDay, setLastDay] = useState(() =>
    target ? new Date(target.proposedLastDay).toISOString().slice(0, 10) : ''
  );

  const review = trpc.resignations.review.useMutation({
    onSuccess: () => {
      utils.resignations.listAll.invalidate();
      utils.team.getHrOverview.invalidate();
      onClose();
    },
  });

  const isApprove = target?.decision === 'APPROVED';
  const today = new Date().toISOString().slice(0, 10);
  const dateValid = !isApprove || (!!lastDay && lastDay >= today);
  const canSubmit = dateValid && !review.isPending;

  return (
    <Dialog
      open={!!target}
      onOpenChange={(v) => {
        if (review.isPending) return;
        if (!v) {
          review.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle
            className={cn(
              'flex items-center gap-1.5',
              isApprove ? 'text-emerald-600 dark:text-emerald-500' : 'text-destructive'
            )}
          >
            {isApprove ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {isApprove ? 'Approve' : 'Decline'} resignation
          </DialogTitle>
          <DialogDescription>
            {isApprove
              ? `Confirm ${target?.name}'s last working day. You can add an optional note.`
              : `Decline ${target?.name}'s resignation. You can add an optional note.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isApprove && (
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Last working day <span className="text-destructive">*</span>
              </label>
              <Input
                type="date"
                min={today}
                value={lastDay}
                onChange={(e) => setLastDay(e.target.value)}
                disabled={review.isPending}
              />
              {lastDay && !dateValid && (
                <p className="mt-1 text-[11px] text-destructive">
                  The last working day can&apos;t be in the past.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Review note (optional)
            </label>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                isApprove
                  ? 'Any handover or offboarding details...'
                  : 'Let the employee know why...'
              }
              disabled={review.isPending}
            />
          </div>

          {review.error && <p className="text-xs text-destructive">{review.error.message}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button
            variant={isApprove ? 'default' : 'destructive'}
            onClick={() => {
              if (!target || !canSubmit) return;
              review.mutate({
                id: target.id,
                decision: target.decision,
                reviewNote: note.trim() || undefined,
                lastWorkingDay: isApprove && lastDay ? new Date(lastDay) : undefined,
              });
            }}
            disabled={!canSubmit}
          >
            {review.isPending && <Loader2 className="animate-spin" />}
            {review.isPending
              ? 'Saving...'
              : isApprove
                ? 'Approve resignation'
                : 'Decline resignation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
