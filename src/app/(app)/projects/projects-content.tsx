'use client';

import { memo, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Search,
  LayoutGrid,
  List,
  Plus,
  ArrowUpRight,
  FolderKanban,
  Calendar,
  Upload,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { X, Loader2 } from 'lucide-react';

type ViewMode = 'grid' | 'list';
type FilterStatus = 'ALL' | 'ACTIVE' | 'IN_DEVELOPMENT' | 'COMPLETED' | 'ON_HOLD';
type FilterType = 'ALL' | 'CLIENT' | 'INTERNAL';

const statusConfig: Record<string, { bg: string; dot: string; label: string }> = {
  ACTIVE: {
    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: 'Active',
  },
  IN_DEVELOPMENT: {
    bg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
    label: 'In Development',
  },
  ON_HOLD: {
    bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    label: 'On Hold',
  },
  COMPLETED: {
    bg: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    label: 'Completed',
  },
  CANCELLED: { bg: 'bg-red-500/10 text-red-500', dot: 'bg-red-500', label: 'Cancelled' },
};

export function ProjectsContent() {
  const [view, setView] = useState<ViewMode>('grid');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [typeFilter, setTypeFilter] = useState<FilterType>('ALL');

  const [showCreateModal, setShowCreateModal] = useState(false);

  const { data: projects, isLoading } = trpc.projects.getAll.useQuery();

  const filtered = useMemo(() => {
    if (!projects) return [];
    return projects.filter((p) => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (typeFilter !== 'ALL' && p.type !== typeFilter) return false;
      return true;
    });
  }, [projects, search, statusFilter, typeFilter]);

  const counts = useMemo(() => {
    if (!projects) return { total: 0, active: 0, dev: 0, client: 0, internal: 0 };
    return {
      total: projects.length,
      active: projects.filter((p) => p.status === 'ACTIVE').length,
      dev: projects.filter((p) => p.status === 'IN_DEVELOPMENT').length,
      client: projects.filter((p) => p.type === 'CLIENT').length,
      internal: projects.filter((p) => p.type === 'INTERNAL').length,
    };
  }, [projects]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
            Projects
          </h1>
          <p className="text-muted-foreground mt-1.5 text-[15px]">
            {counts.total} projects &middot; {counts.active} active &middot; {counts.dev} in
            development
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/projects/import"
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-all hover:bg-secondary active:scale-[0.98]"
          >
            <Upload className="h-4 w-4" />
            Import from Trello
          </Link>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      </div>

      {/* Toolbar — search, filters, view toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1.5">
          {(['ALL', 'ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD'] as FilterStatus[]).map((s) => (
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
              {s === 'ALL'
                ? 'All'
                : s === 'IN_DEVELOPMENT'
                  ? 'Dev'
                  : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex items-center gap-1.5">
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
              {t === 'ALL' ? 'All Types' : t.charAt(0) + t.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex items-center rounded-lg border border-border p-0.5 ml-auto">
          <button
            onClick={() => setView('grid')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
              view === 'grid'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            aria-label="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView('list')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
              view === 'list'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div
          className={cn(
            'grid gap-4',
            view === 'grid' ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'
          )}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-6">
                <Skeleton className="h-5 w-40 mb-2" />
                <Skeleton className="h-3 w-24 mb-4" />
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-3/4 mb-6" />
                <div className="flex -space-x-2">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <Skeleton key={j} className="h-7 w-7 rounded-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground/20" />
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
            No projects found
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {search ? 'Try a different search term' : 'Create your first project to get started'}
          </p>
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectGridCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((project) => (
            <ProjectListRow key={project.id} project={project} />
          ))}
        </div>
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
  const config = statusConfig[project.status] || statusConfig.ACTIVE;

  return (
    <Link href={`/projects/${project.id}`} onMouseEnter={prefetch} onFocus={prefetch}>
      <Card className="group h-full border-border/60 transition-all duration-200 hover:border-border hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/20 hover:-translate-y-0.5 cursor-pointer">
        <CardContent className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {project.name}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {project.client?.name || (project.type === 'INTERNAL' ? 'Internal Product' : '')}
              </p>
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                config.bg
              )}
            >
              <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
              {config.label}
            </div>
          </div>

          {/* Description */}
          {project.description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-4 leading-relaxed">
              {project.description}
            </p>
          )}

          {/* Tech stack tags */}
          {project.techStack.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
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
          <div className="flex items-center justify-between pt-3 border-t border-border/60">
            <div className="flex -space-x-2">
              {project.members.slice(0, 5).map((m) => (
                <Avatar key={m.user.id} className="h-7 w-7 border-2 border-card">
                  <AvatarImage src={m.user.avatar ?? undefined} />
                  <AvatarFallback className="text-[10px] bg-secondary font-medium">
                    {m.user.name[0]}
                  </AvatarFallback>
                </Avatar>
              ))}
              {project.members.length > 5 && (
                <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-muted-foreground">
                  +{project.members.length - 5}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {project._count.boards > 0 && (
                <span className="flex items-center gap-1">
                  <FolderKanban className="h-3 w-3" /> {project._count.boards}
                </span>
              )}
              {project._count.milestones > 0 && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> {project._count.milestones}
                </span>
              )}
              <ArrowUpRight className="h-4 w-4 opacity-0 group-hover:opacity-100 group-hover:text-primary transition-all" />
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
  const config = statusConfig[project.status] || statusConfig.ACTIVE;

  return (
    <Link href={`/projects/${project.id}`} onMouseEnter={prefetch} onFocus={prefetch}>
      <div className="group flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4 transition-all duration-150 hover:border-border hover:shadow-md hover:shadow-black/5 dark:hover:shadow-black/20 cursor-pointer">
        {/* Name + client */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
              {project.name}
            </h3>
            {project.type === 'INTERNAL' && (
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                Internal
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {project.client?.name || project.description?.slice(0, 60)}
          </p>
        </div>

        {/* Members */}
        <div className="hidden md:flex -space-x-1.5 shrink-0">
          {project.members.slice(0, 4).map((m) => (
            <Avatar key={m.user.id} className="h-6 w-6 border-2 border-card">
              <AvatarImage src={m.user.avatar ?? undefined} />
              <AvatarFallback className="text-[9px] bg-secondary font-medium">
                {m.user.name[0]}
              </AvatarFallback>
            </Avatar>
          ))}
        </div>

        {/* Date */}
        {project.startDate && (
          <span className="hidden lg:block text-xs text-muted-foreground shrink-0 w-24 text-right">
            {format(new Date(project.startDate), 'MMM yyyy')}
          </span>
        )}

        {/* Status */}
        <div
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
            config.bg
          )}
        >
          <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
          {config.label}
        </div>

        <ArrowUpRight className="h-4 w-4 text-muted-foreground/30 shrink-0 group-hover:text-primary transition-colors" />
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
  _count: { boards: number; milestones: number; files: number };
};
