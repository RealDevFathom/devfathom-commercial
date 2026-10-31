'use client';

import { memo, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Search,
  LayoutGrid,
  List,
  Plus,
  ArrowUpRight,
  ArrowUpDown,
  FolderKanban,
  Clock,
  Layers,
  Building2,
  Upload,
  X,
  Loader2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  statusConfig,
  STATUS_ORDER,
  getProgress,
  getDeadline,
  deadlineMeta,
  StatusBadge,
  ProgressBar,
} from '@/components/projects/project-ui';

type ViewMode = 'grid' | 'list';
type FilterStatus = 'ALL' | 'ACTIVE' | 'IN_DEVELOPMENT' | 'ON_HOLD' | 'COMPLETED';
type FilterType = 'ALL' | 'CLIENT' | 'INTERNAL';
type SortKey = 'recent' | 'name' | 'progress' | 'deadline';

// Quick-filter row (Cancelled is rare → reachable via Group, not a pill).
const FILTER_STATUSES: FilterStatus[] = ['ALL', 'ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED'];
const STATUS_PILL: Record<FilterStatus, string> = {
  ALL: 'All',
  ACTIVE: 'Active',
  IN_DEVELOPMENT: 'Dev',
  ON_HOLD: 'Hold',
  COMPLETED: 'Done',
};

export function ProjectsContent() {
  const [view, setView] = useState<ViewMode>('grid');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [typeFilter, setTypeFilter] = useState<FilterType>('ALL');
  const [sort, setSort] = useState<SortKey>('recent');
  const [grouped, setGrouped] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const { data: projects, isLoading } = trpc.projects.getAll.useQuery();

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = search.trim().toLowerCase();
    const rows = projects.filter((p) => {
      if (
        q &&
        !(
          p.name.toLowerCase().includes(q) ||
          p.client?.name.toLowerCase().includes(q) ||
          p.techStack.some((t) => t.toLowerCase().includes(q))
        )
      )
        return false;
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (typeFilter !== 'ALL' && p.type !== typeFilter) return false;
      return true;
    });
    const rank = (p: ProjectData) => getProgress(p)?.pct ?? -1;
    const dl = (p: ProjectData) => getDeadline(p)?.getTime() ?? Number.POSITIVE_INFINITY;
    const out = [...rows];
    if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'progress') out.sort((a, b) => rank(b) - rank(a));
    else if (sort === 'deadline') out.sort((a, b) => dl(a) - dl(b));
    // 'recent' preserves the server's updatedAt-desc ordering.
    return out;
  }, [projects, search, statusFilter, typeFilter, sort]);

  const counts = useMemo(() => {
    const list = projects ?? [];
    return {
      total: list.length,
      active: list.filter((p) => p.status === 'ACTIVE').length,
      dev: list.filter((p) => p.status === 'IN_DEVELOPMENT').length,
      hold: list.filter((p) => p.status === 'ON_HOLD').length,
      done: list.filter((p) => p.status === 'COMPLETED').length,
    };
  }, [projects]);

  const groups = useMemo(
    () =>
      grouped
        ? STATUS_ORDER.map((s) => ({
            status: s,
            items: filtered.filter((p) => p.status === s),
          })).filter((g) => g.items.length > 0)
        : [],
    [grouped, filtered]
  );

  const renderItems = (items: ProjectData[]) =>
    view === 'grid' ? (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((p) => (
          <ProjectGridCard key={p.id} project={p} />
        ))}
      </div>
    ) : (
      <div className="space-y-1.5">
        {items.map((p) => (
          <ProjectListRow key={p.id} project={p} />
        ))}
      </div>
    );

  return (
    <div className="fieldbook-projects space-y-7">
      <PageHeader
        eyebrow="DELIVERY / INDEX"
        heading="Projects"
        description="Every active engagement, internal build, and delivery signal in one working index."
        actions={
          <>
            <Button
              variant="outline"
              size="lg"
              className="h-10 px-4"
              nativeButton={false}
              render={<Link href="/projects/import" />}
            >
              <Upload className="h-4 w-4" />
              Import from Trello
            </Button>
            <Button size="lg" className="h-10 px-4" onClick={() => setShowCreateModal(true)}>
              <Plus className="h-4 w-4" />
              New Project
            </Button>
          </>
        }
      />

      {/* At-a-glance stats */}
      <div className="flex flex-wrap items-center gap-2">
        <StatChip label="Total" value={counts.total} />
        <StatChip label="Active" value={counts.active} dot="bg-emerald-500" />
        <StatChip label="In Dev" value={counts.dev} dot="bg-blue-500" />
        <StatChip label="On Hold" value={counts.hold} dot="bg-amber-500" />
        <StatChip label="Completed" value={counts.done} dot="bg-muted-foreground" />
      </div>

      {/* Toolbar — search, filters, sort, group, view */}
      <div className="fieldbook-filterbar flex flex-col gap-3 p-2 lg:flex-row lg:items-center">
        {/* Search */}
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search name, client, tech…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Status + type filters */}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {FILTER_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                statusFilter === s
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              {STATUS_PILL[s]}
            </button>
          ))}
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
          {(['ALL', 'CLIENT', 'INTERNAL'] as FilterType[]).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                typeFilter === t
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              {t === 'ALL' ? 'All types' : t.charAt(0) + t.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {/* Sort + group + view */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort projects"
              className="h-10 cursor-pointer appearance-none rounded-xl border border-border bg-card pl-8 pr-7 text-sm font-medium text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="progress">Progress</option>
              <option value="deadline">Deadline</option>
            </select>
          </div>
          <button
            onClick={() => setGrouped((g) => !g)}
            aria-pressed={grouped}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors',
              grouped
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            )}
          >
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline">Group</span>
          </button>
          <div className="flex h-10 items-center rounded-xl border border-border bg-card p-0.5">
            <button
              onClick={() => setView('grid')}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                view === 'grid'
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setView('list')}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                view === 'list'
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label="List view"
              aria-pressed={view === 'list'}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <SkeletonGrid view={view} />
      ) : filtered.length === 0 ? (
        <EmptyState hasQuery={Boolean(search || statusFilter !== 'ALL' || typeFilter !== 'ALL')} />
      ) : grouped ? (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.status} className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', statusConfig[g.status].dot)} />
                <h2 className="font-display text-sm font-semibold text-foreground">
                  {statusConfig[g.status].label}
                </h2>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                  {g.items.length}
                </span>
              </div>
              {renderItems(g.items)}
            </section>
          ))}
        </div>
      ) : (
        <>
          {view === 'list' && <ListHeader />}
          {renderItems(filtered)}
        </>
      )}

      {/* Create Project Modal */}
      {showCreateModal && <CreateProjectModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}

/* ============================================
   Create Project Modal
   ============================================ */
function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: clients } = trpc.clients.getAll.useQuery();
  const { data: team } = trpc.team.getAll.useQuery();

  const createProject = trpc.projects.create.useMutation({
    onSuccess: () => {
      utils.projects.getAll.invalidate();
      onClose();
    },
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'CLIENT' | 'INTERNAL'>('CLIENT');
  const [status, setStatus] = useState<'ACTIVE' | 'IN_DEVELOPMENT' | 'ON_HOLD'>('ACTIVE');
  const [clientId, setClientId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [techInput, setTechInput] = useState('');
  const [techStack, setTechStack] = useState<string[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const handleAddTech = () => {
    const val = techInput.trim();
    if (val && !techStack.includes(val)) {
      setTechStack([...techStack, val]);
      setTechInput('');
    }
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    createProject.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      type,
      status,
      clientId: type === 'CLIENT' && clientId ? clientId : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      techStack,
      memberIds: selectedMembers,
      createDefaultBoard: true,
    });
  };

  const toggleMember = (id: string) => {
    setSelectedMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/90 backdrop-blur-xl px-6 py-4">
            <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
              New Project
            </h2>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Project Name *
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. WXW Delivery Platform"
                className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {/* Type + Status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Type</label>
                <div className="flex rounded-xl border border-border overflow-hidden">
                  {(['CLIENT', 'INTERNAL'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setType(t);
                        if (t === 'INTERNAL') setClientId('');
                      }}
                      className={cn(
                        'flex-1 py-2 text-xs font-medium transition-colors',
                        type === t
                          ? 'bg-foreground text-background'
                          : 'bg-card text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t === 'CLIENT' ? 'Client' : 'Internal'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="IN_DEVELOPMENT">In Development</option>
                  <option value="ON_HOLD">On Hold</option>
                </select>
              </div>
            </div>

            {/* Client selector */}
            {type === 'CLIENT' && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Client</label>
                <select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Select client...</option>
                  {clients?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Brief project description..."
                className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {/* Dates */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Start Date
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">End Date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {/* Tech Stack */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Tech Stack</label>
              <div className="flex gap-2">
                <input
                  value={techInput}
                  onChange={(e) => setTechInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTech();
                    }
                  }}
                  placeholder="Add technology..."
                  className="flex-1 rounded-xl border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  onClick={handleAddTech}
                  disabled={!techInput.trim()}
                  className="rounded-xl bg-secondary px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary/80 disabled:opacity-40 transition-colors"
                >
                  Add
                </button>
              </div>
              {techStack.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {techStack.map((tech) => (
                    <span
                      key={tech}
                      className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {tech}
                      <button
                        onClick={() => setTechStack((s) => s.filter((t) => t !== tech))}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Team Members */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Team Members{' '}
                <span className="text-muted-foreground font-normal">
                  ({selectedMembers.length} selected)
                </span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto rounded-xl border border-border bg-card p-2">
                {team?.map((member) => (
                  <button
                    key={member.id}
                    onClick={() => toggleMember(member.id)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      selectedMembers.includes(member.id)
                        ? 'bg-primary/10 ring-1 ring-primary/20'
                        : 'hover:bg-secondary'
                    )}
                  >
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarImage src={member.avatar ?? undefined} />
                      <AvatarFallback className="text-[9px] bg-secondary font-medium">
                        {member.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{member.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{member.title}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Error */}
          {createProject.error && (
            <p className="mx-6 mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
              {createProject.error.message}
            </p>
          )}

          {/* Footer */}
          <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border/60 bg-background px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!name.trim() || createProject.isPending}
              className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
            >
              {createProject.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Project'
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const ProjectGridCard = memo(function ProjectGridCard({ project }: { project: ProjectData }) {
  const utils = trpc.useUtils();
  const prefetch = () => utils.projects.getById.prefetch({ id: project.id });
  const progress = getProgress(project);
  const closed = project.status === 'COMPLETED' || project.status === 'CANCELLED';
  const deadline = closed ? null : getDeadline(project);
  const due = deadline ? deadlineMeta(deadline) : null;
  const rail = (statusConfig[project.status] ?? statusConfig.ACTIVE).rail;

  return (
    <Link
      href={`/projects/${project.id}`}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className="group block rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Card className="relative h-full overflow-hidden border-border/60 transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-lg hover:shadow-black/5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:hover:shadow-black/20">
        <span className={cn('absolute inset-y-0 left-0 w-1', rail)} aria-hidden />
        <CardContent className="p-5 pl-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-display text-base font-semibold text-foreground transition-colors group-hover:text-primary">
                {project.name}
              </h3>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                {project.type === 'INTERNAL' ? (
                  <span className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium">
                    Internal
                  </span>
                ) : (
                  <>
                    <Building2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{project.client?.name ?? 'Client'}</span>
                  </>
                )}
              </div>
            </div>
            <StatusBadge status={project.status} />
          </div>

          {/* Description */}
          {project.description && (
            <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {project.description}
            </p>
          )}

          {/* Progress */}
          {progress && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium text-muted-foreground">Milestones</span>
                <span className="font-semibold text-foreground tabular-nums">
                  {progress.done}/{progress.total} · {progress.pct}%
                </span>
              </div>
              <ProgressBar pct={progress.pct} />
            </div>
          )}

          {/* Tech */}
          {project.techStack.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {project.techStack.slice(0, 4).map((tech) => (
                <span
                  key={tech}
                  className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                >
                  {tech}
                </span>
              ))}
              {project.techStack.length > 4 && (
                <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  +{project.techStack.length - 4}
                </span>
              )}
            </div>
          )}

          {/* Footer — members + meta */}
          <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
            <div className="flex -space-x-2">
              {project.members.slice(0, 5).map((m) => (
                <Avatar key={m.user.id} className="h-7 w-7 border-2 border-card">
                  <AvatarImage src={m.user.avatar ?? undefined} />
                  <AvatarFallback className="bg-secondary text-[10px] font-medium">
                    {m.user.name[0]}
                  </AvatarFallback>
                </Avatar>
              ))}
              {project.members.length > 5 && (
                <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-muted-foreground">
                  +{project.members.length - 5}
                </div>
              )}
              {project.members.length === 0 && (
                <span className="text-xs text-muted-foreground">Unassigned</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {due && (
                <span className={cn('flex items-center gap-1 font-medium tabular-nums', due.tone)}>
                  <Clock className="h-3.5 w-3.5" />
                  {due.label}
                </span>
              )}
              {project._count.boards > 0 && (
                <span className="flex items-center gap-1 tabular-nums">
                  <FolderKanban className="h-3.5 w-3.5" />
                  {project._count.boards}
                </span>
              )}
              <ArrowUpRight className="h-4 w-4 opacity-0 transition-all group-hover:text-primary group-hover:opacity-100" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

const ProjectListRow = memo(function ProjectListRow({ project }: { project: ProjectData }) {
  const utils = trpc.useUtils();
  const prefetch = () => utils.projects.getById.prefetch({ id: project.id });
  const progress = getProgress(project);
  const closed = project.status === 'COMPLETED' || project.status === 'CANCELLED';
  const deadline = closed ? null : getDeadline(project);
  const due = deadline ? deadlineMeta(deadline) : null;
  const rail = (statusConfig[project.status] ?? statusConfig.ACTIVE).rail;

  return (
    <Link
      href={`/projects/${project.id}`}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className="group block rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <div className="relative flex items-center gap-4 overflow-hidden rounded-[4px] border border-border-default bg-card p-4 pl-5 transition-all duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-md motion-reduce:transition-none">
        <span className={cn('absolute inset-y-0 left-0 w-1', rail)} aria-hidden />

        {/* Name + client */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
              {project.name}
            </h3>
            {project.type === 'INTERNAL' && (
              <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Internal
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {project.type === 'CLIENT'
              ? (project.client?.name ?? 'Client')
              : project.description?.slice(0, 70) || 'Internal product'}
          </p>
        </div>

        {/* Progress */}
        <div className="hidden w-40 shrink-0 md:block">
          {progress ? (
            <div className="flex items-center gap-2">
              <ProgressBar pct={progress.pct} className="flex-1" />
              <span className="w-9 text-right text-[11px] font-semibold text-foreground tabular-nums">
                {progress.pct}%
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground/50">No milestones</span>
          )}
        </div>

        {/* Team */}
        <div className="hidden w-20 shrink-0 justify-end -space-x-1.5 lg:flex">
          {project.members.slice(0, 3).map((m) => (
            <Avatar key={m.user.id} className="h-6 w-6 border-2 border-card">
              <AvatarImage src={m.user.avatar ?? undefined} />
              <AvatarFallback className="bg-secondary text-[9px] font-medium">
                {m.user.name[0]}
              </AvatarFallback>
            </Avatar>
          ))}
          {project.members.length > 3 && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-secondary text-[9px] font-semibold text-muted-foreground">
              +{project.members.length - 3}
            </div>
          )}
        </div>

        {/* Due */}
        <div className="hidden w-24 shrink-0 text-right lg:block">
          {due ? (
            <span className={cn('text-xs font-medium tabular-nums', due.tone)}>{due.label}</span>
          ) : (
            <span className="text-xs text-muted-foreground/40">—</span>
          )}
        </div>

        {/* Status */}
        <div className="flex w-28 shrink-0 justify-end">
          <StatusBadge status={project.status} />
        </div>

        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-primary" />
      </div>
    </Link>
  );
});

type ProjectData = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  type: string;
  startDate: Date | null;
  endDate: Date | null;
  techStack: string[];
  client: { id: string; name: string; logo: string | null } | null;
  members: Array<{ user: { id: string; name: string; avatar: string | null; title: string } }>;
  milestones: Array<{ completedAt: Date | null; dueDate: Date }>;
  _count: { boards: number; milestones: number; files: number };
};

/* ============================================
   Small presentational helpers
   ============================================ */
function StatChip({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <div className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-border-default bg-card px-2.5 py-1">
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />}
      <span className="text-sm font-semibold text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function ListHeader() {
  return (
    <div className="hidden items-center gap-4 px-5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 md:flex">
      <span className="flex-1">Project</span>
      <span className="w-40">Progress</span>
      <span className="hidden w-20 text-right lg:block">Team</span>
      <span className="hidden w-24 text-right lg:block">Due</span>
      <span className="w-28 text-right">Status</span>
      <span className="w-4" />
    </div>
  );
}

function SkeletonGrid({ view }: { view: ViewMode }) {
  if (view === 'list') {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="hidden h-1.5 w-40 rounded-full md:block" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="border-border/60">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-1.5 w-full rounded-full" />
            <div className="flex -space-x-2">
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="h-7 w-7 rounded-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EmptyState({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
      <FolderKanban className="h-12 w-12 text-muted-foreground/20" />
      <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
        {hasQuery ? 'No matching projects' : 'No projects yet'}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {hasQuery
          ? 'Try clearing a filter or searching for something else.'
          : 'Create your first project to start tracking delivery.'}
      </p>
    </div>
  );
}
