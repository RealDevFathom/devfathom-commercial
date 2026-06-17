'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  ArrowLeft, Mail, Phone, Calendar, FolderKanban, CheckSquare, Circle, Users,
  Pencil, Save, X, Loader2, Lock, UserX, Eye, EyeOff,
  CheckCircle2, Clock as ClockIcon, Timer, MessageSquare, Flame, Sparkles, Activity, TrendingUp, TrendingDown,
  ClipboardList, Trash2, Send,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const priorityConfig: Record<string, { color: string }> = {
  URGENT: { color: 'text-red-500' }, HIGH: { color: 'text-[#FF4C29]' },
  MEDIUM: { color: 'text-amber-500' }, LOW: { color: 'text-muted-foreground' },
};

const leaveStatusConfig: Record<string, { bg: string; label: string }> = {
  PENDING: { bg: 'bg-amber-500/10 text-amber-500', label: 'Pending' },
  APPROVED: { bg: 'bg-emerald-500/10 text-emerald-500', label: 'Approved' },
  REJECTED: { bg: 'bg-red-500/10 text-red-500', label: 'Rejected' },
};

const departmentOptions = ['LEADERSHIP', 'ENGINEERING', 'PRODUCT', 'QUALITY', 'MARKETING', 'DESIGN'] as const;

export function MemberDetailContent({ memberId }: { memberId: string }) {
  const router = useRouter();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const utils = trpc.useUtils();
  const { data: member, isLoading } = trpc.team.getById.useQuery({ id: memberId });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDept, setEditDept] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editSkillInput, setEditSkillInput] = useState('');
  const [editSkills, setEditSkills] = useState<string[]>([]);

  const [showResetPw, setShowResetPw] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);

  const [showDeactivate, setShowDeactivate] = useState(false);

  const updateMember = trpc.team.adminUpdateMember.useMutation({
    onSuccess: () => { utils.team.getById.invalidate({ id: memberId }); utils.team.getAll.invalidate(); setIsEditing(false); },
  });
  const resetPassword = trpc.team.adminResetPassword.useMutation({
    onSuccess: () => { setShowResetPw(false); setNewPassword(''); setPwSuccess(true); setTimeout(() => setPwSuccess(false), 3000); },
  });
  const deactivate = trpc.team.deactivateMember.useMutation({
    onSuccess: () => { utils.team.getAll.invalidate(); router.push('/team'); },
  });

  if (isLoading) return <div className="space-y-6 animate-fade-in"><Skeleton className="h-4 w-28 mb-4" /><Skeleton className="h-9 w-48" /><div className="grid grid-cols-1 gap-5 lg:grid-cols-3"><Card className="lg:col-span-2 border-border/60"><CardContent className="p-6"><Skeleton className="h-40 w-full" /></CardContent></Card><Card className="border-border/60"><CardContent className="p-6"><Skeleton className="h-40 w-full" /></CardContent></Card></div></div>;
  if (!member) return <div className="flex flex-col items-center py-32"><Users className="h-16 w-16 text-muted-foreground/20" /><h2 className="mt-4 font-display text-xl font-semibold text-foreground">Member not found</h2><Link href="/team" className="mt-6 text-sm font-medium text-[#FF4C29] hover:underline">Back to Team</Link></div>;

  const startEdit = () => {
    setEditName(member.name);
    setEditTitle(member.title);
    setEditDept(member.department);
    setEditRole(member.role);
    setEditPhone(member.phone || '');
    setEditBio(member.bio || '');
    setEditSkills(member.skills);
    setIsEditing(true);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <Link href="/team" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to Team
        </Link>

        {/* Admin actions */}
        {isAdmin && memberId !== session?.user?.id && (
          <div className="flex items-center gap-2">
            <button onClick={startEdit}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button onClick={() => setShowResetPw(!showResetPw)}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
              <Lock className="h-3.5 w-3.5" /> Reset Password
            </button>
            {!showDeactivate ? (
              <button onClick={() => setShowDeactivate(true)}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/20 transition-colors">
                <UserX className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button onClick={() => deactivate.mutate({ id: memberId })} disabled={deactivate.isPending}
                  className="rounded-xl bg-red-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                  {deactivate.isPending ? 'Deactivating...' : 'Confirm Deactivate'}
                </button>
                <button onClick={() => setShowDeactivate(false)} className="text-xs text-muted-foreground hover:text-foreground px-1">Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reset password form */}
      {showResetPw && isAdmin && (
        <Card className="border-amber-500/20">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-amber-500" /> Reset Password for {member.name}</h3>
              <button onClick={() => setShowResetPw(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex gap-3">
              <div className="relative flex-1">
                <input type={showPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newPassword.length >= 8) resetPassword.mutate({ id: memberId, newPassword }); }}
                  placeholder="New password (min 8 chars)"
                  className="w-full rounded-xl border border-border bg-background px-4 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
                <button onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" tabIndex={-1}>
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <button onClick={() => resetPassword.mutate({ id: memberId, newPassword })}
                disabled={newPassword.length < 8 || resetPassword.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors">
                {resetPassword.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                Reset
              </button>
            </div>
          </CardContent>
        </Card>
      )}
      {pwSuccess && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-500">Password has been reset successfully.</div>
      )}

      {/* Edit form */}
      {isEditing && isAdmin && (
        <Card className="border-[#FF4C29]/20">
          <CardContent className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Edit Member</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Title</label>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Department</label>
                <select value={editDept} onChange={(e) => setEditDept(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none">
                  {departmentOptions.map((d) => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Role</label>
                <div className="flex rounded-xl border border-border overflow-hidden">
                  {(['EMPLOYEE', 'ADMIN'] as const).map((r) => (
                    <button key={r} onClick={() => setEditRole(r)}
                      className={cn('flex-1 py-2 text-xs font-medium transition-colors', editRole === r ? 'bg-foreground text-background' : 'bg-card text-muted-foreground hover:text-foreground')}>
                      {r === 'EMPLOYEE' ? 'Employee' : 'Admin'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Phone</label>
                <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Status</label>
                <select defaultValue={member.status}
                  onChange={(e) => updateMember.mutate({ id: memberId, status: e.target.value as 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE' })}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none">
                  <option value="ACTIVE">Active</option>
                  <option value="ON_LEAVE">On Leave</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Bio</label>
              <textarea value={editBio} onChange={(e) => setEditBio(e.target.value)} rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Skills</label>
              <div className="flex gap-2">
                <input value={editSkillInput} onChange={(e) => setEditSkillInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = editSkillInput.trim(); if (v && !editSkills.includes(v)) { setEditSkills([...editSkills, v]); setEditSkillInput(''); } } }}
                  placeholder="Add skill..."
                  className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none" />
              </div>
              {editSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {editSkills.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2 py-0.5 text-xs font-medium text-foreground">
                      {s} <button onClick={() => setEditSkills(editSkills.filter((sk) => sk !== s))} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsEditing(false)} className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                onClick={() => updateMember.mutate({
                  id: memberId,
                  name: editName.trim() || undefined,
                  title: editTitle.trim() || undefined,
                  department: editDept as typeof departmentOptions[number],
                  role: editRole as 'ADMIN' | 'EMPLOYEE',
                  phone: editPhone || null,
                  bio: editBio || null,
                  skills: editSkills,
                })}
                disabled={updateMember.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors">
                {updateMember.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save Changes
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Profile header */}
      <div className="flex items-start gap-5">
        <Avatar className="h-20 w-20 shrink-0">
          <AvatarImage src={member.avatar ?? undefined} />
          <AvatarFallback className="bg-secondary text-foreground font-bold text-2xl">{member.name.split(' ').map((n) => n[0]).join('')}</AvatarFallback>
        </Avatar>
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">{member.name}</h1>
          <p className="text-[15px] text-muted-foreground mt-0.5">{member.title}</p>
          <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
            {member.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{member.email}</span>}
            {member.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{member.phone}</span>}
          </div>
          {member.bio && <p className="text-sm text-muted-foreground mt-3 max-w-xl leading-relaxed">{member.bio}</p>}
          {member.skills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {member.skills.map((s) => <span key={s} className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground">{s}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* Personal stats — visible to self or admin */}
      {(session?.user?.id === memberId || isAdmin) && (
        <PersonalStatsBlock userId={memberId} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Projects */}
        <Card className="lg:col-span-2 border-border/60">
          <CardHeader className="pb-2"><CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground"><div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10"><FolderKanban className="h-3.5 w-3.5 text-blue-500" /></div>Projects ({member.projectMembers.length})</CardTitle></CardHeader>
          <CardContent>
            {member.projectMembers.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No projects assigned</p>
            ) : (
              <div className="divide-y divide-border/60">
                {member.projectMembers.map((pm) => {
                  const sColors: Record<string, string> = { ACTIVE: 'text-emerald-500', IN_DEVELOPMENT: 'text-blue-500', ON_HOLD: 'text-amber-500', COMPLETED: 'text-muted-foreground' };
                  return (
                    <Link key={pm.project.id} href={`/projects/${pm.project.id}`} className="flex items-center justify-between py-3 group hover:bg-secondary/30 -mx-6 px-6 transition-colors">
                      <div>
                        <p className="text-sm font-medium text-foreground group-hover:text-[#FF4C29] transition-colors">{pm.project.name}</p>
                        <p className="text-xs text-muted-foreground">{pm.project.type === 'CLIENT' ? 'Client' : 'Internal'} &middot; {pm.role}</p>
                      </div>
                      <span className={cn('text-xs font-medium', sColors[pm.project.status])}>{pm.project.status.replace('_', ' ')}</span>
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
              <div><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Department</p><p className="text-sm font-medium text-foreground">{member.department.charAt(0) + member.department.slice(1).toLowerCase()}</p></div>
              <div><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Role</p><p className="text-sm font-medium text-foreground">{member.role}</p></div>
              <div><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Start Date</p><p className="text-sm font-medium text-foreground">{format(new Date(member.startDate), 'MMM d, yyyy')}</p></div>
              <div><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Status</p><p className={cn('text-sm font-medium', member.status === 'ACTIVE' ? 'text-emerald-500' : member.status === 'ON_LEAVE' ? 'text-amber-500' : 'text-muted-foreground')}>{member.status}</p></div>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardHeader className="pb-2"><CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground"><div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#FF4C29]/10"><CheckSquare className="h-3.5 w-3.5 text-[#FF4C29]" /></div>Tasks</CardTitle></CardHeader>
            <CardContent>
              {member.assignedTasks.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No tasks assigned</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {member.assignedTasks.map((at) => (
                    <div key={at.task.id} className="flex items-center gap-2 py-2.5">
                      <Circle className={cn('h-3 w-3 shrink-0', priorityConfig[at.task.priority]?.color)} fill="currentColor" />
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
      {member.leaveRequests && (member.leaveRequests as Array<{ id: string; type: string; startDate: Date; endDate: Date; status: string; reason: string | null }>).length > 0 && (
        <Card className="border-border/60">
          <CardHeader className="pb-2"><CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground"><div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10"><Calendar className="h-3.5 w-3.5 text-amber-500" /></div>Leave History</CardTitle></CardHeader>
          <CardContent>
            <div className="divide-y divide-border/60">
              {(member.leaveRequests as Array<{ id: string; type: string; startDate: Date; endDate: Date; status: string; reason: string | null }>).map((lr) => {
                const lc = leaveStatusConfig[lr.status] || leaveStatusConfig.PENDING;
                return (
                  <div key={lr.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{lr.type.charAt(0) + lr.type.slice(1).toLowerCase()}</p>
                      <p className="text-xs text-muted-foreground">{format(new Date(lr.startDate), 'MMM d')} – {format(new Date(lr.endDate), 'MMM d, yyyy')}{lr.reason ? ` · ${lr.reason}` : ''}</p>
                    </div>
                    <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', lc.bg)}>{lc.label}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Performance notes — visible to self or admins; admins can write */}
      {(isAdmin || session?.user?.id === memberId) && (
        <PerformanceNotesBlock userId={memberId} canWrite={isAdmin} currentUserId={session?.user?.id ?? ''} />
      )}
    </div>
  );
}

/* ============================================
   Personal stats block — rendered on a member's profile page.
   Visible only to the member themselves or an admin.
   ============================================ */
function PersonalStatsBlock({ userId }: { userId: string }) {
  const stats = trpc.teamStats.getForUser.useQuery(
    { userId },
    { staleTime: 60_000 },
  );

  if (stats.isLoading) {
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

  if (stats.isError || !stats.data) return null;
  const s = stats.data;

  const delta = s.completedThisWeek - s.completedLastWeek;
  const maxSpark = Math.max(1, ...s.tasksDoneSparkline);

  const health =
    s.openTasks === 0
      ? { label: 'idle', bg: 'bg-red-500/10', dot: 'bg-red-500', text: 'text-red-500', icon: null as React.ReactNode }
      : s.completedThisWeek === 0
      ? { label: 'stalled', bg: 'bg-amber-500/10', dot: 'bg-amber-500', text: 'text-amber-500', icon: null as React.ReactNode }
      : s.completedThisWeek >= 5
      ? { label: 'on fire', bg: 'bg-orange-500/10', dot: 'bg-orange-500', text: 'text-orange-500', icon: <Flame className="h-3 w-3" /> }
      : { label: 'active', bg: 'bg-emerald-500/10', dot: 'bg-emerald-500', text: 'text-emerald-500', icon: <Sparkles className="h-3 w-3" /> };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#FF4C29]/10">
              <Activity className="h-3.5 w-3.5 text-[#FF4C29]" />
            </div>
            Personal stats · this week
          </CardTitle>
          <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium', health.bg, health.text)}>
            {health.icon}
            <div className={cn('h-1.5 w-1.5 rounded-full', health.dot)} />
            {health.label}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Primary metrics */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Activity}
            label="Open tasks"
            value={s.openTasks}
            tone="blue"
          />
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
                    count === 0 ? 'bg-secondary' : 'bg-emerald-500/60',
                  )}
                  style={{ height: `${Math.max(8, (count / maxSpark) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/60 uppercase tracking-wider">
            {['6d', '5d', '4d', '3d', '2d', 'yest', 'today'].map((lbl) => (
              <span key={lbl} className="flex-1 text-center">{lbl}</span>
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
              {s.meetingsAttended}<span className="text-muted-foreground font-normal">/{s.meetingsInvited}</span>
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
            <p className="mt-0.5 font-semibold text-foreground tabular-nums">{s.commentsThisWeek}</p>
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
}

/* ============================================
   Performance notes — admin-authored feedback, visible to admins + subject.
   Admins can add notes; only the author can delete their own notes.
   ============================================ */
function PerformanceNotesBlock({
  userId,
  canWrite,
  currentUserId,
}: {
  userId: string;
  canWrite: boolean;
  currentUserId: string;
}) {
  const utils = trpc.useUtils();
  const { data: notes, isLoading } = trpc.team.listPerformanceNotes.useQuery({ userId });
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
              className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
            />
            <button
              onClick={() => { if (draft.trim()) addNote.mutate({ userId, content: draft.trim() }); }}
              disabled={!draft.trim() || addNote.isPending}
              className="self-end flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors"
            >
              {addNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Add
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
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
                    {n.author.name.split(' ').map((p) => p[0]).join('')}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-medium text-foreground">{n.author.name}</p>
                    <p className="text-[11px] text-muted-foreground">{format(new Date(n.createdAt), 'MMM d, yyyy')}</p>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap leading-relaxed">{n.content}</p>
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
}

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
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className={cn('mt-1.5 font-display text-2xl font-bold tabular-nums', t.text)}>{value}</p>
      {delta !== undefined && delta !== 0 && (
        <p className={cn('text-[10px] font-medium tabular-nums flex items-center gap-0.5', delta > 0 ? 'text-emerald-500' : 'text-amber-500')}>
          {delta > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
          {delta > 0 ? '+' : ''}{delta} vs last week
        </p>
      )}
    </div>
  );
}
