'use client';

import { useState } from 'react';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';

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

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">HR</h1>
          <p className="text-muted-foreground mt-1.5 text-[15px]">
            Leave, headcount, and people operations.
          </p>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <HrOverview isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="leave">
          <LeaveTab isAdmin={isAdmin} />
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
              <p className="py-6 text-center text-sm text-muted-foreground">Everyone's in.</p>
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
                        departmentColors[u.department]
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

  const [leaveType, setLeaveType] = useState<'VACATION' | 'SICK' | 'REMOTE'>('VACATION');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const filtered = leaveRequests?.filter((lr) => filter === 'ALL' || lr.status === filter) ?? [];
  const pendingCount = leaveRequests?.filter((lr) => lr.status === 'PENDING').length ?? 0;

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
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
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
            <div className="grid grid-cols-3 gap-3">
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
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
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
            <div className="divide-y divide-border/60">
              {filtered.map((lr) => {
                const sc = statusConfig[lr.status] || statusConfig.PENDING;
                const tc = typeConfig[lr.type] || typeConfig.VACATION;
                return (
                  <div key={lr.id} className="flex items-center gap-4 px-6 py-4">
                    <Link href={`/team/${lr.user.id}`} className="shrink-0">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={lr.user.avatar ?? undefined} />
                        <AvatarFallback className="bg-secondary text-foreground font-medium text-sm">
                          {lr.user.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
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
                        {format(new Date(lr.startDate), 'MMM d')} –{' '}
                        {format(new Date(lr.endDate), 'MMM d, yyyy')}
                        {lr.reason ? ` · ${lr.reason}` : ''}
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
                    <span
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                        sc.bg
                      )}
                    >
                      {sc.label}
                    </span>
                    {isAdmin && lr.status === 'PENDING' && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => updateStatus.mutate({ id: lr.id, status: 'APPROVED' })}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                          title="Approve"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => updateStatus.mutate({ id: lr.id, status: 'REJECTED' })}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                          title="Reject"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
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
