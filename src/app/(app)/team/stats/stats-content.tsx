'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  Clock,
  Activity,
  Trophy,
  Timer,
  MessageSquare,
  Users as UsersIcon,
  Crown,
  Flame,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';

export function TeamStatsContent() {
  const stats = trpc.teamStats.getAll.useQuery(undefined, {
    staleTime: 60_000, // 1 minute — batch is ~500ms so don't re-fetch on every navigation
  });

  if (stats.isLoading) return <StatsSkeleton />;

  if (stats.isError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <AlertCircle className="h-12 w-12 text-muted-foreground/30" />
        <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
          Unable to load team stats
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{stats.error.message}</p>
      </div>
    );
  }

  const data = stats.data!;
  const { members, alerts, velocity, leaderboards, totals } = data;

  const weekDelta = totals.teamCompletedThisWeek - totals.teamCompletedLastWeek;
  const weekDeltaPct =
    totals.teamCompletedLastWeek > 0
      ? Math.round((weekDelta / totals.teamCompletedLastWeek) * 100)
      : null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Team Insights
        </h1>
        <p className="text-muted-foreground mt-1.5 text-[15px]">
          How the team is performing this week. Workload, velocity, and pulse in one place.
        </p>
      </div>

      {/* Top KPI strip — team-level totals */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          icon={CheckCircle2}
          label="Completed this week"
          value={totals.teamCompletedThisWeek}
          delta={weekDeltaPct}
          tone="emerald"
        />
        <KpiCard
          icon={Activity}
          label="Open tasks"
          value={totals.teamOpenTasks}
          tone="blue"
          subtitle={`${totals.teamMembers - totals.membersWithNoTasks}/${totals.teamMembers} with active work`}
        />
        <KpiCard
          icon={Clock}
          label="Overdue"
          value={totals.teamOverdue}
          tone={totals.teamOverdue > 0 ? 'amber' : 'muted'}
        />
        <KpiCard
          icon={UsersIcon}
          label="Team size"
          value={totals.teamMembers}
          tone="violet"
          subtitle={
            totals.membersWithNoTasks > 0
              ? `${totals.membersWithNoTasks} idle`
              : 'everyone has work'
          }
        />
      </div>

      {/* Alerts banner — only if there's something to show */}
      {alerts.length > 0 && (
        <Card className="border-amber-500/20 bg-amber-500/[0.02]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[13px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-500 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" />
              Heads-up · {alerts.length}{' '}
              {alerts.length === 1 ? 'thing needs attention' : 'things need attention'}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1.5">
              {alerts.slice(0, 8).map((alert, i) => (
                <AlertRow key={`${alert.userId}-${alert.kind}-${i}`} alert={alert} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Team velocity chart — 30 day completion trend */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            Team velocity · last 30 days
          </CardTitle>
          <p className="text-xs text-muted-foreground pl-8">
            Tasks moved to Done per day across the whole team
          </p>
        </CardHeader>
        <CardContent className="pl-4 pr-6 pb-6">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={velocity}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => format(new Date(d), 'MMM d')}
                interval={4}
                stroke="currentColor"
                fontSize={11}
                strokeOpacity={0.5}
              />
              <YAxis
                allowDecimals={false}
                stroke="currentColor"
                fontSize={11}
                strokeOpacity={0.5}
                width={24}
              />
              <Tooltip
                cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                contentStyle={{
                  background: 'var(--popover)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--popover-foreground)',
                }}
                labelStyle={{ color: 'var(--popover-foreground)', fontWeight: 600 }}
                itemStyle={{ color: 'var(--popover-foreground)' }}
                labelFormatter={(d) => format(new Date(d), 'EEE, MMM d')}
                formatter={(value) => [String(value), 'completed']}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#10b981"
                strokeWidth={2.5}
                dot={{ r: 0 }}
                activeDot={{ r: 4, fill: '#10b981' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Workload distribution + Leaderboards side-by-side */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3 border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
                <Target className="h-3.5 w-3.5 text-blue-500" />
              </div>
              Workload distribution
            </CardTitle>
            <p className="text-xs text-muted-foreground pl-8">
              Open tasks per member · imbalances are easy to spot here
            </p>
          </CardHeader>
          <CardContent className="pl-4 pr-6 pb-6">
            <ResponsiveContainer width="100%" height={Math.max(180, members.length * 32)}>
              <BarChart
                data={[...members].sort((a, b) => b.openTasks - a.openTasks)}
                layout="vertical"
                margin={{ left: 8, right: 30, top: 4, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  strokeOpacity={0.08}
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  stroke="currentColor"
                  fontSize={11}
                  strokeOpacity={0.5}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="currentColor"
                  fontSize={11}
                  strokeOpacity={0.7}
                  width={90}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(name: string) => name.split(' ')[0]}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(188,136,80,0.1)' }}
                  contentStyle={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--popover-foreground)',
                  }}
                  labelStyle={{ color: 'var(--popover-foreground)', fontWeight: 600 }}
                  itemStyle={{ color: 'var(--popover-foreground)' }}
                  formatter={(value) => [String(value), 'open tasks']}
                />
                <Bar dataKey="openTasks" radius={[0, 6, 6, 0]}>
                  {[...members]
                    .sort((a, b) => b.openTasks - a.openTasks)
                    .map((m) => (
                      <Cell
                        key={m.userId}
                        fill={
                          m.openTasks === 0 ? '#64748b' : m.openTasks > 10 ? '#f59e0b' : '#3b82f6'
                        }
                      />
                    ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Leaderboards */}
        <div className="lg:col-span-2 space-y-4">
          <LeaderboardCard
            title="Top completer"
            subtitle="this week"
            icon={Trophy}
            iconColor="text-amber-500 bg-amber-500/10"
            members={leaderboards.topCompleter}
            valueKey="completedThisWeek"
            valueLabel="done"
          />
          <LeaderboardCard
            title="Best punctuality"
            subtitle="meetings on time"
            icon={Timer}
            iconColor="text-blue-500 bg-blue-500/10"
            members={leaderboards.bestPunctuality}
            valueKey="onTimePercent"
            valueLabel="%"
          />
          <LeaderboardCard
            title="Fastest cycle"
            subtitle="avg time to Done"
            icon={Zap}
            iconColor="text-violet-500 bg-violet-500/10"
            members={leaderboards.fastestCycle}
            valueKey="avgCycleTimeDays"
            valueLabel="d"
            lowerIsBetter
          />
          <LeaderboardCard
            title="Most collaborative"
            subtitle="notes + comments"
            icon={MessageSquare}
            iconColor="text-emerald-500 bg-emerald-500/10"
            members={leaderboards.mostCollaborative}
            valueKey="collab"
            valueLabel=""
          />
        </div>
      </div>

      {/* Per-member cards */}
      <div>
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Individual stats
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {members.map((m) => (
            <MemberStatsCard key={m.userId} stats={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   KPI card — top strip
   ============================================ */
function KpiCard({
  icon: Icon,
  label,
  value,
  delta,
  subtitle,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  delta?: number | null;
  subtitle?: string;
  tone: 'emerald' | 'blue' | 'amber' | 'violet' | 'muted';
}) {
  const tones: Record<string, string> = {
    emerald: 'bg-emerald-500/10 text-emerald-500',
    blue: 'bg-blue-500/10 text-blue-500',
    amber: 'bg-amber-500/10 text-amber-500',
    violet: 'bg-violet-500/10 text-violet-500',
    muted: 'bg-muted text-muted-foreground',
  };

  return (
    <Card className="border-border/60">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 font-display text-3xl font-bold tracking-tight tabular-nums text-foreground">
              {value}
            </p>
            {delta !== undefined && delta !== null && (
              <div className="mt-1 flex items-center gap-1 text-xs">
                {delta > 0 ? (
                  <>
                    <TrendingUp className="h-3 w-3 text-emerald-500" />
                    <span className="font-medium text-emerald-500">+{delta}%</span>
                    <span className="text-muted-foreground">vs last week</span>
                  </>
                ) : delta < 0 ? (
                  <>
                    <TrendingDown className="h-3 w-3 text-amber-500" />
                    <span className="font-medium text-amber-500">{delta}%</span>
                    <span className="text-muted-foreground">vs last week</span>
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">no change</span>
                  </>
                )}
              </div>
            )}
            {subtitle && !delta && (
              <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-xl shrink-0',
              tones[tone]
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================
   Alert row
   ============================================ */
function AlertRow({
  alert,
}: {
  alert: {
    userId: string;
    name: string;
    severity: 'high' | 'medium' | 'low';
    kind: string;
    message: string;
  };
}) {
  const toneClass =
    alert.severity === 'high'
      ? 'bg-red-500'
      : alert.severity === 'medium'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/40';
  const Icon =
    alert.severity === 'high' ? AlertCircle : alert.severity === 'medium' ? AlertTriangle : Info;

  return (
    <Link
      href={`/team/${alert.userId}`}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-amber-500/5"
    >
      <div className={cn('h-1.5 w-1.5 shrink-0 rounded-full', toneClass)} />
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          alert.severity === 'high'
            ? 'text-red-500'
            : alert.severity === 'medium'
              ? 'text-amber-500'
              : 'text-muted-foreground'
        )}
      />
      <span className="font-semibold text-foreground">{alert.name}</span>
      <span className="text-muted-foreground">{alert.message}</span>
    </Link>
  );
}

/* ============================================
   Leaderboard card
   ============================================ */
type LeaderboardMember = {
  userId: string;
  name: string;
  avatar: string | null;
  title: string | null;
  completedThisWeek: number;
  onTimePercent: number | null;
  avgCycleTimeDays: number | null;
  commentsThisWeek: number;
  notesAuthored: number;
};

function LeaderboardCard({
  title,
  subtitle,
  icon: Icon,
  iconColor,
  members,
  valueKey,
  valueLabel,
  lowerIsBetter,
}: {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  members: LeaderboardMember[];
  valueKey: 'completedThisWeek' | 'onTimePercent' | 'avgCycleTimeDays' | 'collab';
  valueLabel: string;
  lowerIsBetter?: boolean;
}) {
  const getValue = (m: LeaderboardMember) => {
    if (valueKey === 'collab') return m.commentsThisWeek + m.notesAuthored;
    return m[valueKey];
  };

  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className={cn('flex h-6 w-6 items-center justify-center rounded-md', iconColor)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground leading-tight">{title}</p>
            <p className="text-[10px] text-muted-foreground leading-tight">{subtitle}</p>
          </div>
        </div>
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">Not enough data yet</p>
        ) : (
          <div className="space-y-1.5">
            {members.map((m, i) => {
              const value = getValue(m);
              return (
                <Link
                  key={m.userId}
                  href={`/team/${m.userId}`}
                  className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-secondary/50 transition-colors"
                >
                  <div
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold shrink-0',
                      i === 0
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-secondary text-muted-foreground'
                    )}
                  >
                    {i === 0 ? <Crown className="h-3 w-3" /> : i + 1}
                  </div>
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={m.avatar ?? undefined} />
                    <AvatarFallback className="text-[8px] bg-secondary">{m.name[0]}</AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate text-xs text-foreground">
                    {m.name.split(' ')[0]}
                  </span>
                  <span className="text-xs font-semibold text-foreground tabular-nums">
                    {value ?? '—'}
                    {value !== null && value !== undefined && valueLabel}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        {lowerIsBetter && members.length > 0 && (
          <p className="mt-2 text-[9px] text-muted-foreground/60 uppercase tracking-wider">
            lower is better
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================
   Per-member card
   ============================================ */
function MemberStatsCard({
  stats,
}: {
  stats: {
    userId: string;
    name: string;
    avatar: string | null;
    title: string | null;
    openTasks: number;
    completedThisWeek: number;
    completedLastWeek: number;
    overdueTasks: number;
    avgCycleTimeDays: number | null;
    meetingsInvited: number;
    meetingsAttended: number;
    avgMinutesLate: number | null;
    onTimePercent: number | null;
    notesAuthored: number;
    projectsActive: number;
    commentsThisWeek: number;
    lastActiveAt: Date | null;
    tasksDoneSparkline: number[];
  };
}) {
  const delta = stats.completedThisWeek - stats.completedLastWeek;
  const maxSpark = Math.max(1, ...stats.tasksDoneSparkline);

  // Health indicator: green if active, amber if idle, red if no tasks
  const health =
    stats.openTasks === 0
      ? { label: 'idle', bg: 'bg-red-500/10', dot: 'bg-red-500', text: 'text-red-500' }
      : stats.completedThisWeek === 0
        ? { label: 'stalled', bg: 'bg-amber-500/10', dot: 'bg-amber-500', text: 'text-amber-500' }
        : stats.completedThisWeek >= 5
          ? {
              label: 'on fire',
              bg: 'bg-orange-500/10',
              dot: 'bg-orange-500',
              text: 'text-orange-500',
            }
          : {
              label: 'active',
              bg: 'bg-emerald-500/10',
              dot: 'bg-emerald-500',
              text: 'text-emerald-500',
            };

  return (
    <Link href={`/team/${stats.userId}`}>
      <Card className="group border-border/60 transition-all hover:border-border hover:shadow-lg hover:-translate-y-0.5">
        <CardContent className="p-5">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <Avatar className="h-10 w-10">
              <AvatarImage src={stats.avatar ?? undefined} />
              <AvatarFallback className="bg-secondary font-medium">
                {stats.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {stats.name}
              </p>
              {stats.title && (
                <p className="text-[11px] text-muted-foreground truncate">{stats.title}</p>
              )}
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                health.bg,
                health.text
              )}
            >
              {health.label === 'on fire' && <Flame className="h-2.5 w-2.5" />}
              {health.label === 'active' && <Sparkles className="h-2.5 w-2.5" />}
              <div className={cn('h-1 w-1 rounded-full', health.dot)} />
              {health.label}
            </div>
          </div>

          {/* 4-quadrant stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Open"
              value={stats.openTasks}
              tone={stats.openTasks === 0 ? 'muted' : 'blue'}
            />
            <Stat
              label="Done this week"
              value={stats.completedThisWeek}
              delta={delta}
              tone={stats.completedThisWeek > 0 ? 'emerald' : 'muted'}
            />
            <Stat
              label="Overdue"
              value={stats.overdueTasks}
              tone={stats.overdueTasks > 0 ? 'amber' : 'muted'}
            />
            <Stat
              label="Cycle time"
              value={stats.avgCycleTimeDays !== null ? `${stats.avgCycleTimeDays}d` : '—'}
              tone="violet"
            />
          </div>

          {/* Sparkline */}
          <div className="mt-4 flex items-end gap-0.5 h-8">
            {stats.tasksDoneSparkline.map((count, i) => (
              <div
                key={i}
                className={cn(
                  'flex-1 rounded-sm transition-all',
                  count === 0 ? 'bg-secondary' : 'bg-emerald-500/60'
                )}
                style={{ height: `${Math.max(8, (count / maxSpark) * 100)}%` }}
                title={`${count} task${count === 1 ? '' : 's'} done`}
              />
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider">
            7-day activity
          </p>

          {/* Meta row: meetings + collaboration + last active */}
          <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5" title="Meetings attended">
              <Timer className="h-3 w-3" />
              <span className="tabular-nums">
                {stats.meetingsAttended}/{stats.meetingsInvited}
              </span>
              {stats.onTimePercent !== null && (
                <span className="text-emerald-500">· {stats.onTimePercent}% on time</span>
              )}
            </div>
            <div className="flex items-center gap-1.5" title="Notes authored">
              <MessageSquare className="h-3 w-3" />
              <span className="tabular-nums">{stats.notesAuthored + stats.commentsThisWeek}</span>
            </div>
          </div>
          {stats.lastActiveAt && (
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              Last active {formatDistanceToNow(new Date(stats.lastActiveAt), { addSuffix: true })}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function Stat({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: number | string;
  delta?: number;
  tone: 'emerald' | 'blue' | 'amber' | 'violet' | 'muted';
}) {
  const tones: Record<string, string> = {
    emerald: 'text-emerald-500',
    blue: 'text-blue-500',
    amber: 'text-amber-500',
    violet: 'text-violet-500',
    muted: 'text-muted-foreground',
  };
  return (
    <div className="rounded-lg bg-background/50 border border-border/40 px-2.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <p className={cn('mt-0.5 font-display text-xl font-bold tabular-nums', tones[tone])}>
        {value}
      </p>
      {delta !== undefined && delta !== 0 && (
        <p
          className={cn(
            'text-[9px] font-medium tabular-nums',
            delta > 0 ? 'text-emerald-500' : 'text-amber-500'
          )}
        >
          {delta > 0 ? '+' : ''}
          {delta} vs last week
        </p>
      )}
    </div>
  );
}

/* ============================================
   Skeleton
   ============================================ */
function StatsSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border-border/60">
            <CardContent className="p-5">
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-9 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="border-border/60">
        <CardContent className="p-6">
          <Skeleton className="h-44 w-full" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="border-border/60">
            <CardContent className="p-5">
              <Skeleton className="h-12 w-full mb-4" />
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, j) => (
                  <Skeleton key={j} className="h-14 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
