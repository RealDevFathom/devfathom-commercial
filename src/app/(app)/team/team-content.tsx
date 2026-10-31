'use client';

import { memo, useState, useMemo } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Search,
  FolderKanban,
  CheckSquare,
  Users,
  Plus,
  X,
  Loader2,
  Check,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useEntitlements } from '@/components/entitlements-provider';
import { isModuleGranted, moduleForProcedure } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

type TeamMember = inferRouterOutputs<AppRouter>['team']['getAll'][number];

const departmentColors: Record<string, string> = {
  LEADERSHIP: 'bg-primary/10 text-primary',
  ENGINEERING: 'bg-blue-500/10 text-blue-500',
  PRODUCT: 'bg-violet-500/10 text-violet-500',
  QUALITY: 'bg-amber-500/10 text-amber-500',
  MARKETING: 'bg-emerald-500/10 text-emerald-500',
  DESIGN: 'bg-pink-500/10 text-pink-500',
};

const statusDot: Record<string, string> = {
  ACTIVE: 'bg-emerald-500',
  INACTIVE: 'bg-muted-foreground',
  ON_LEAVE: 'bg-amber-500',
  INVITED: 'bg-sky-500',
};

export function TeamContent({
  initialShowAddMember = false,
  invitationReturnTo,
}: {
  initialShowAddMember?: boolean;
  invitationReturnTo?: '/restaurant/staff';
}) {
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const canReadDirectory = isModuleGranted('hr', entitlements.enabledModules);
  const isAdmin =
    session?.user?.role === 'ADMIN' &&
    isModuleGranted(moduleForProcedure('team.inviteMember')!, entitlements.enabledModules);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  // Keep the request while the session loads. The modal below always uses the
  // same capability check as the visible Add Member action.
  const [showAddMember, setShowAddMember] = useState(initialShowAddMember);
  const { data: team, isLoading } = trpc.team.getAll.useQuery(undefined, {
    enabled: canReadDirectory,
  });

  const departments = useMemo(() => {
    if (!team) return [];
    return [...new Set(team.map((m) => m.department))];
  }, [team]);

  const filtered = useMemo(() => {
    if (!team) return [];
    return team.filter((m) => {
      if (
        search &&
        !m.name.toLowerCase().includes(search.toLowerCase()) &&
        !m.title.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      if (deptFilter !== 'ALL' && m.department !== deptFilter) return false;
      return true;
    });
  }, [team, search, deptFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="FIRM"
        heading="Team"
        description={`${team?.length ?? 0} team members across ${departments.length} departments.`}
        actions={
          isAdmin ? (
            <Button size="lg" onClick={() => setShowAddMember(true)}>
              <Plus className="h-4 w-4" /> Add Member
            </Button>
          ) : undefined
        }
      />

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name or role..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setDeptFilter('ALL')}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              deptFilter === 'ALL'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            All
          </button>
          {departments.map((d) => (
            <button
              key={d}
              onClick={() => setDeptFilter(d)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                deptFilter === d
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              {d.charAt(0) + d.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Team grid */}
      {!canReadDirectory ? (
        <p className="text-sm text-text-muted">
          Invite workspace members here. The team directory requires the HR module.
        </p>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-14 w-14 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-5 w-32 mb-2" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <Users className="h-12 w-12 text-muted-foreground/20" />
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
            No team members found
          </h3>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((member) => (
            <TeamMemberCard key={member.id} member={member} />
          ))}
        </div>
      )}

      {isAdmin && showAddMember && (
        <AddMemberModal onClose={() => setShowAddMember(false)} returnTo={invitationReturnTo} />
      )}
    </div>
  );
}

const TeamMemberCard = memo(function TeamMemberCard({ member }: { member: TeamMember }) {
  const utils = trpc.useUtils();
  const prefetch = () => utils.team.getById.prefetch({ id: member.id });

  return (
    <Link href={`/team/${member.id}`} onMouseEnter={prefetch} onFocus={prefetch}>
      <Card className="group h-full border-border/60 transition-all duration-200 hover:border-border hover:shadow-lg hover:-translate-y-0.5 cursor-pointer">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="relative">
              <Avatar className="h-14 w-14">
                <AvatarImage src={member.avatar ?? undefined} />
                <AvatarFallback className="bg-secondary text-foreground font-semibold text-lg">
                  {member.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </AvatarFallback>
              </Avatar>
              <div
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card',
                  statusDot[member.status]
                )}
              />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {member.name}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{member.title}</p>
              <div className="flex items-center gap-2 mt-2">
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[10px] font-medium',
                    departmentColors[member.department]
                  )}
                >
                  {member.department.charAt(0) + member.department.slice(1).toLowerCase()}
                </span>
                {member.role === 'ADMIN' && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    Admin
                  </span>
                )}
                {member.role === 'HR' && (
                  <span className="rounded-md bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-500">
                    HR
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <FolderKanban className="h-3 w-3" />
                {member._count.projectMembers}
              </span>
              <span className="flex items-center gap-1">
                <CheckSquare className="h-3 w-3" />
                {member._count.assignedTasks}
              </span>
            </div>
            {member.lastActiveAt && (
              <span>{formatDistanceToNow(new Date(member.lastActiveAt), { addSuffix: true })}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

export function AddMemberModal({
  onClose,
  returnTo,
}: {
  onClose: () => void;
  returnTo?: '/restaurant/staff';
}) {
  const utils = trpc.useUtils();
  const inviteMember = trpc.team.inviteMember.useMutation();
  const departmentQuery = trpc.organizationAdmin.departments.useQuery(undefined, { retry: false });
  const roleQuery = trpc.organizationAdmin.roles.useQuery(undefined, { retry: false });
  const departmentOptions = (departmentQuery.data ?? []).filter((item) => item.active);
  const roleOptions = roleQuery.data ?? [];

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'HR' | 'EMPLOYEE'>('EMPLOYEE');
  const [organizationRoleId, setOrganizationRoleId] = useState('');
  const [department, setDepartment] = useState('');
  const [title, setTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ email: string; inviteUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedDepartment = departmentOptions.find((item) => item.key === department);
  const departmentReady =
    !departmentQuery.isFetching && !departmentQuery.isError && Boolean(selectedDepartment);

  const handleSubmit = () => {
    setError('');
    if (
      !name.trim() ||
      !email.trim() ||
      !title.trim() ||
      !departmentReady ||
      inviteMember.isPending
    )
      return;
    const submittedEmail = email.trim().toLowerCase();
    inviteMember.mutate(
      {
        name: name.trim(),
        email: submittedEmail,
        role,
        organizationRoleId: organizationRoleId || null,
        department,
        title: title.trim(),
        phone: phone || undefined,
        bio: bio || undefined,
        skills,
      },
      {
        onSuccess: (data) => {
          utils.team.getAll.invalidate();
          setSent({ email: submittedEmail, inviteUrl: data.inviteUrl });
        },
        onError: (err) => setError(err.message),
      }
    );
  };

  const handleCopy = async () => {
    if (!sent) return;
    await navigator.clipboard.writeText(sent.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/90 backdrop-blur-xl px-6 py-4">
            <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
              Add Team Member
            </h2>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {sent ? (
            <div className="p-6">
              <div className="flex flex-col items-center py-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <Check className="h-7 w-7 text-primary" />
                </div>
                <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
                  Invitation sent to {sent.email}
                </h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  They&apos;ll receive an email to set their password and finish their profile.
                </p>
                <div className="mt-6 w-full rounded-xl border border-border bg-card px-4 py-3 text-left">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Invite link</p>
                  <p className="break-all text-sm text-foreground">{sent.inviteUrl}</p>
                </div>
                <div className="mt-4 flex w-full items-center gap-2">
                  <button
                    onClick={handleCopy}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copied!' : 'Copy invite link'}
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
                  >
                    Done
                  </button>
                </div>
                {returnTo ? (
                  <Link
                    href={`${returnTo}?invitedEmail=${encodeURIComponent(sent.email)}`}
                    className="mt-3 text-sm font-medium text-primary hover:underline"
                  >
                    Return to Restaurant staff
                  </Link>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <div className="p-6 space-y-5">
                {error && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                    {error}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      Full Name *
                    </label>
                    <input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="John Doe"
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      Email *
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="john@company.com"
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      Job Title *
                    </label>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Full Stack Developer"
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      Phone
                    </label>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+1 (786) 555-0100"
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="invite-department"
                      className="block text-sm font-medium text-foreground mb-1.5"
                    >
                      Department
                    </label>
                    <select
                      id="invite-department"
                      value={selectedDepartment ? department : ''}
                      disabled={
                        departmentQuery.isFetching ||
                        departmentQuery.isError ||
                        !departmentOptions.length ||
                        inviteMember.isPending
                      }
                      aria-describedby="invite-department-status"
                      aria-invalid={Boolean(department && !selectedDepartment)}
                      onChange={(e) => setDepartment(e.target.value)}
                      className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">Choose a department</option>
                      {departmentOptions.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <div
                      id="invite-department-status"
                      className="mt-2 text-sm text-text-muted"
                      role={departmentQuery.isError ? 'alert' : 'status'}
                    >
                      {departmentQuery.isFetching
                        ? 'Loading departments…'
                        : departmentQuery.isError
                          ? 'Departments could not be loaded. Retry or ask your administrator to check access.'
                          : !departmentOptions.length
                            ? 'No active departments are available. Ask your administrator to review the organization department catalog.'
                            : department && !selectedDepartment
                              ? 'That department is no longer available. Choose an active department.'
                              : 'Choose from this workspace’s active departments.'}
                      {departmentQuery.isError ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="mt-2"
                          onClick={() => void departmentQuery.refetch()}
                        >
                          Retry departments
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Role</label>
                    <div className="flex rounded-xl border border-border overflow-hidden">
                      {(['EMPLOYEE', 'HR', 'ADMIN'] as const).map((r) => (
                        <button
                          key={r}
                          onClick={() => setRole(r)}
                          className={cn(
                            'flex-1 py-2.5 text-xs font-medium transition-colors',
                            role === r
                              ? 'bg-foreground text-background'
                              : 'bg-card text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {r === 'EMPLOYEE' ? 'Employee' : r === 'HR' ? 'HR' : 'Admin'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="invite-role-template"
                    className="block text-sm font-medium text-foreground mb-1.5"
                  >
                    Restaurant staff role
                  </label>
                  <select
                    id="invite-role-template"
                    value={organizationRoleId}
                    disabled={roleQuery.isFetching || roleQuery.isError || inviteMember.isPending}
                    onChange={(event) => setOrganizationRoleId(event.target.value)}
                    className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">No role template</option>
                    {roleOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-text-muted">
                    {roleQuery.isFetching
                      ? 'Loading staff roles…'
                      : roleQuery.isError
                        ? 'Staff roles could not be loaded.'
                        : 'Choose the workspace role that controls restaurant access.'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Bio</label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    rows={2}
                    placeholder="Brief bio..."
                    className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Skills</label>
                  <div className="flex gap-2">
                    <input
                      value={skillInput}
                      onChange={(e) => setSkillInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const v = skillInput.trim();
                          if (v && !skills.includes(v)) {
                            setSkills([...skills, v]);
                            setSkillInput('');
                          }
                        }
                      }}
                      placeholder="Add skill, press Enter..."
                      className="flex-1 rounded-xl border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  {skills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skills.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                        >
                          {s}
                          <button
                            onClick={() => setSkills(skills.filter((sk) => sk !== s))}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border/60 bg-background px-6 py-4">
                <button
                  onClick={onClose}
                  className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={
                    !name.trim() ||
                    !email.trim() ||
                    !title.trim() ||
                    !departmentReady ||
                    inviteMember.isPending
                  }
                  className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
                >
                  {inviteMember.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending…
                    </>
                  ) : (
                    'Send Invite'
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
