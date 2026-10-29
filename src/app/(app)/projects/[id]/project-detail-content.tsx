'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { safeHref } from '@/lib/validators';
import { uploadAttachment } from '@/lib/chat/upload-client';
import {
  ArrowLeft,
  FolderKanban,
  Users,
  Calendar,
  FileText,
  ExternalLink,
  Clock,
  CheckCircle2,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  Save,
  UserPlus,
  Crown,
  X,
  Search,
  Building2,
  Upload,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { NotesContent } from '@/app/(app)/notes/notes-content';
import {
  StatusBadge,
  ProgressBar,
  getProgress,
  getDeadline,
  deadlineMeta,
} from '@/components/projects/project-ui';

// Shared Paper-theme hover idiom for interactive cards.
const cardHover =
  'transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-lg hover:shadow-black/5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:hover:shadow-black/20';

// Mini-board preview: deterministic "task tile" widths (so it reads like real
// cards, not a flat bar) + how we guess which column means "done".
const GHOST_WIDTHS = ['90%', '70%', '84%', '64%'];
const DONE_RE = /done|complete|ship|closed|live|merged/i;

export function ProjectDetailContent({ projectId }: { projectId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const { data: project, isLoading } = trpc.projects.getById.useQuery({ id: projectId });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editTech, setEditTech] = useState<string[]>([]);
  const [techInput, setTechInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const addEditTech = () => {
    const val = techInput.trim();
    if (val && !editTech.includes(val)) {
      setEditTech([...editTech, val]);
      setTechInput('');
    }
  };

  const updateProject = trpc.projects.update.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setIsEditing(false);
    },
  });
  const deleteProject = trpc.projects.delete.useMutation({
    onSuccess: () => router.push('/projects'),
  });

  // Show the project name in the topbar breadcrumb instead of the raw id.
  useBreadcrumbLabel(projectId, project?.name);

  if (isLoading) return <ProjectDetailSkeleton />;
  if (!project) return <ProjectNotFound />;

  // Delete requires LEAD/ADMIN (server: assertProjectAccess manage:true) — mirror
  // the Team tab's gating so non-managers don't hit a swallowed FORBIDDEN.
  const isAdmin = session?.user?.role === 'ADMIN';
  const callerMembership = project.members.find((m) => m.user.id === session?.user?.id);
  const canManage = isAdmin || callerMembership?.role === 'LEAD';

  const progress = getProgress(project);
  const closed = project.status === 'COMPLETED' || project.status === 'CANCELLED';
  const deadline = closed ? null : getDeadline(project);
  const due = deadline ? deadlineMeta(deadline) : null;
  const budgetLabel =
    project.budget != null
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(Number(project.budget))
      : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/projects"
          className="mb-5 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Projects
        </Link>

        <PageHeader
          eyebrow="WORKSPACE"
          className="mb-0 border-b-0 pb-5"
          heading={
            <span className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="min-w-0 break-words">{project.name}</span>
              <StatusBadge status={project.status} />
            </span>
          }
          description={
            project.client ? (
              <span className="inline-flex max-w-full items-center gap-1.5">
                <Building2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{project.client.name}</span>
                {project.client.website && (
                  <a
                    href={safeHref(project.client.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Visit ${project.client.name} website`}
                    className="inline-flex shrink-0 items-center rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </span>
            ) : project.type === 'INTERNAL' ? (
              <span className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Internal Product
              </span>
            ) : undefined
          }
          actions={
            <>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  setIsEditing(!isEditing);
                  setEditName(project.name);
                  setEditDesc(project.description || '');
                  setEditStatus(project.status);
                  setEditStart(
                    project.startDate ? format(new Date(project.startDate), 'yyyy-MM-dd') : ''
                  );
                  setEditEnd(
                    project.endDate ? format(new Date(project.endDate), 'yyyy-MM-dd') : ''
                  );
                  setEditTech(project.techStack);
                  setTechInput('');
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              {canManage &&
                (!showDeleteConfirm ? (
                  <Button
                    variant="destructive"
                    size="icon-lg"
                    onClick={() => setShowDeleteConfirm(true)}
                    aria-label="Delete project"
                    title="Delete project"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="destructive"
                      size="lg"
                      onClick={() => deleteProject.mutate({ id: projectId })}
                      disabled={deleteProject.isPending}
                    >
                      {deleteProject.isPending ? 'Deleting...' : 'Confirm Delete'}
                    </Button>
                    <Button variant="ghost" size="lg" onClick={() => setShowDeleteConfirm(false)}>
                      Cancel
                    </Button>
                  </>
                ))}
            </>
          }
        />

        {/* At-a-glance project metadata remains part of the detail header. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-b border-border-subtle pb-6">
          {progress && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Milestones
              </span>
              <ProgressBar pct={progress.pct} className="w-24" />
              <span className="text-xs font-semibold text-foreground tabular-nums">
                {progress.done}/{progress.total} · {progress.pct}%
              </span>
            </div>
          )}
          {due && (
            <span
              className={cn('flex items-center gap-1.5 text-xs font-medium tabular-nums', due.tone)}
            >
              <Clock className="h-3.5 w-3.5" />
              {due.label}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <Users className="h-3.5 w-3.5" />
            {project.members.length} member{project.members.length !== 1 ? 's' : ''}
          </span>
          {(project.startDate || project.endDate) && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <Calendar className="h-3.5 w-3.5" />
              {project.startDate ? format(new Date(project.startDate), 'MMM d, yyyy') : '—'}
              {' – '}
              {project.endDate ? format(new Date(project.endDate), 'MMM d, yyyy') : '—'}
            </span>
          )}
        </div>
      </div>

      {deleteProject.error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {deleteProject.error.message}
        </p>
      )}

      {/* Edit form */}
      {isEditing && (
        <Card className="border-primary/20 ring-primary/10">
          <CardContent className="space-y-4">
            <h3 className="font-display text-sm font-semibold text-foreground">Edit Project</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">Name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="IN_DEVELOPMENT">In Development</option>
                  <option value="ON_HOLD">On Hold</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">Description</label>
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">Start Date</label>
                <input
                  type="date"
                  value={editStart}
                  onChange={(e) => setEditStart(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">End Date</label>
                <input
                  type="date"
                  value={editEnd}
                  onChange={(e) => setEditEnd(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">Tech Stack</label>
              <div className="flex gap-2">
                <input
                  value={techInput}
                  onChange={(e) => setTechInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addEditTech();
                    }
                  }}
                  placeholder="Add technology..."
                  className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={addEditTech}
                  disabled={!techInput.trim()}
                  className="rounded-xl bg-secondary px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary/80 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              {editTech.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {editTech.map((tech) => (
                    <span
                      key={tech}
                      className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {tech}
                      <button
                        type="button"
                        onClick={() => setEditTech((s) => s.filter((t) => t !== tech))}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {updateProject.error && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {updateProject.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  updateProject.mutate({
                    id: projectId,
                    name: editName.trim() || undefined,
                    description: editDesc || null,
                    status: editStatus as
                      'ACTIVE' | 'IN_DEVELOPMENT' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED',
                    startDate: editStart ? new Date(editStart) : null,
                    endDate: editEnd ? new Date(editEnd) : null,
                    techStack: editTech,
                  })
                }
                disabled={updateProject.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
              >
                {updateProject.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save Changes
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-6">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="milestones">Milestones</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
        </div>

        {/* OVERVIEW */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Details */}
            <Card className="border-border/60 lg:col-span-2">
              <CardContent className="space-y-5">
                <h3 className="font-display text-[15px] font-semibold text-foreground">Overview</h3>

                {project.description ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {project.description}
                  </p>
                ) : (
                  <p className="text-sm italic text-muted-foreground/60">
                    No description provided yet.
                  </p>
                )}

                {project.techStack.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Tech Stack
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border/60 pt-4 sm:grid-cols-3">
                  <Fact
                    label="Type"
                    value={project.type === 'CLIENT' ? 'Client Project' : 'Internal Product'}
                  />
                  {project.client && <Fact label="Client" value={project.client.name} />}
                  {project.startDate && (
                    <Fact
                      label="Started"
                      value={format(new Date(project.startDate), 'MMM d, yyyy')}
                    />
                  )}
                  {project.endDate && (
                    <Fact
                      label="Deadline"
                      value={format(new Date(project.endDate), 'MMM d, yyyy')}
                    />
                  )}
                  {budgetLabel && <Fact label="Budget" value={budgetLabel} numeric />}
                  <Fact label="Milestones" value={String(project.milestones.length)} numeric />
                </div>
              </CardContent>
            </Card>

            {/* Side column */}
            <div className="space-y-5">
              <Card className="border-border/60">
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-[15px] font-semibold text-foreground">Team</h3>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                      {project.members.length}
                    </span>
                  </div>
                  {project.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No members assigned yet.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {project.members.slice(0, 6).map((m) => (
                        <div key={m.user.id} className="flex items-center gap-2.5">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={m.user.avatar ?? undefined} />
                            <AvatarFallback className="bg-secondary text-[10px] font-medium">
                              {m.user.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {m.user.name}
                            </p>
                            {m.user.title && (
                              <p className="truncate text-xs text-muted-foreground">
                                {m.user.title}
                              </p>
                            )}
                          </div>
                          {m.role === 'LEAD' && (
                            <Crown
                              className="h-3.5 w-3.5 shrink-0 text-primary"
                              aria-label="Lead"
                            />
                          )}
                        </div>
                      ))}
                      {project.members.length > 6 && (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          +{project.members.length - 6} more
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-2 gap-3">
                <StatTile icon={FolderKanban} value={project.boards.length} label="Boards" />
                <StatTile icon={Calendar} value={project.milestones.length} label="Milestones" />
              </div>
            </div>
          </div>
        </TabsContent>

        {/* BOARD */}
        <TabsContent value="board" className="space-y-4">
          <BoardsTab projectId={projectId} boards={project.boards} />
        </TabsContent>

        {/* TEAM */}
        <TabsContent value="team">
          <ProjectTeamTab projectId={projectId} members={project.members} />
        </TabsContent>

        {/* MILESTONES */}
        <TabsContent value="milestones">
          <MilestonesTab projectId={projectId} milestones={project.milestones} />
        </TabsContent>

        {/* NOTES */}
        <TabsContent value="notes">
          <NotesContent projectId={projectId} embedded />
        </TabsContent>

        {/* FILES */}
        <TabsContent value="files">
          <FilesTab projectId={projectId} files={project.files} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BoardsTab({
  projectId,
  boards,
}: {
  projectId: string;
  boards: Array<{
    id: string;
    name: string;
    columns: Array<{ id: string; name: string; _count: { tasks: number } }>;
  }>;
}) {
  const utils = trpc.useUtils();
  const [showCreate, setShowCreate] = useState(false);
  const [boardName, setBoardName] = useState('');
  // IMP-PROJ-07: pick a column template when creating a board.
  const [boardTemplate, setBoardTemplate] = useState<'kanban' | 'scrum' | 'simple' | 'bugtracker'>(
    'kanban'
  );
  const [deletingBoardId, setDeletingBoardId] = useState<string | null>(null);

  const createBoard = trpc.projects.createBoard.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setShowCreate(false);
      setBoardName('');
    },
  });
  const deleteBoard = trpc.projects.deleteBoard.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setDeletingBoardId(null);
    },
  });
  // IMP-PROJ-05: rename a board in place (server-side access-checked).
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [editBoardName, setEditBoardName] = useState('');
  const updateBoard = trpc.projects.updateBoard.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setEditingBoardId(null);
    },
  });
  const saveBoardName = (id: string) => {
    const name = editBoardName.trim();
    if (name) updateBoard.mutate({ id, name });
  };

  return (
    <>
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground tabular-nums">
          {boards.length} board{boards.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus className="h-3.5 w-3.5" />
          New Board
        </button>
      </div>

      {/* Create board inline form */}
      {showCreate && (
        <div className="rounded-xl border border-primary/30 bg-card p-4">
          <label className="mb-1.5 block text-sm font-medium text-foreground">Board Name</label>
          <input
            autoFocus
            value={boardName}
            onChange={(e) => setBoardName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && boardName.trim()) {
                createBoard.mutate({ projectId, name: boardName.trim(), template: boardTemplate });
              }
              if (e.key === 'Escape') {
                setShowCreate(false);
                setBoardName('');
              }
            }}
            placeholder="e.g. Sprint Board, Feature Roadmap..."
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {/* IMP-PROJ-07: column template picker. */}
          <div className="mt-3">
            <label className="mb-1.5 block text-xs font-medium text-foreground">Template</label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  {
                    id: 'kanban',
                    label: 'Kanban',
                    cols: 'Backlog · To Do · In Progress · Review · Done',
                  },
                  {
                    id: 'scrum',
                    label: 'Scrum',
                    cols: 'Backlog · Sprint · In Progress · Review · Done',
                  },
                  { id: 'simple', label: 'Simple', cols: 'To Do · Doing · Done' },
                  {
                    id: 'bugtracker',
                    label: 'Bug tracker',
                    cols: 'Reported · Triaged · In Progress · Testing · Closed',
                  },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setBoardTemplate(t.id)}
                  title={t.cols}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    boardTemplate === t.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <p className="mb-3 mt-2 text-xs text-muted-foreground">
            Creates the template&apos;s columns and a default label set.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (boardName.trim())
                  createBoard.mutate({
                    projectId,
                    name: boardName.trim(),
                    template: boardTemplate,
                  });
              }}
              disabled={!boardName.trim() || createBoard.isPending}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
            >
              {createBoard.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating...
                </>
              ) : (
                'Create Board'
              )}
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setBoardName('');
              }}
              className="rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Board cards */}
      {boards.length === 0 && !showCreate ? (
        <EmptyState
          icon={FolderKanban}
          title="No boards yet"
          description="Create a board to start managing tasks"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          {boards.map((board) => {
            const totalTasks = board.columns.reduce((sum, c) => sum + c._count.tasks, 0);
            // The "done" column: rightmost one whose name looks finished,
            // else the last column (standard left→right kanban convention).
            const doneCol =
              [...board.columns].reverse().find((c) => DONE_RE.test(c.name)) ??
              board.columns[board.columns.length - 1];
            const doneCount = doneCol?._count.tasks ?? 0;
            const donePct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;
            const href = `/projects/${projectId}/board/${board.id}`;

            return (
              <Card
                key={board.id}
                className={cn('group relative overflow-hidden border-border/60', cardHover)}
              >
                {/* Hairline brand accent along the top edge. */}
                <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary/70 via-primary/30 to-transparent" />
                <CardContent className="space-y-4">
                  {/* Header: title + at-a-glance done badge + delete */}
                  <div className="flex items-start justify-between gap-3">
                    {editingBoardId === board.id ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <FolderKanban className="h-[18px] w-[18px]" />
                        </span>
                        <input
                          autoFocus
                          value={editBoardName}
                          onChange={(e) => setEditBoardName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveBoardName(board.id);
                            if (e.key === 'Escape') setEditingBoardId(null);
                          }}
                          className="min-w-0 flex-1 rounded-lg border border-primary/40 bg-background px-2.5 py-1.5 text-sm font-semibold text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                    ) : (
                      <Link
                        href={href}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <FolderKanban className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
                            {board.name}
                          </span>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {board.columns.length} columns &middot; {totalTasks} tasks
                          </span>
                        </span>
                      </Link>
                    )}
                    <div className="flex shrink-0 items-center gap-2">
                      {editingBoardId === board.id ? (
                        <>
                          <button
                            onClick={() => saveBoardName(board.id)}
                            disabled={!editBoardName.trim() || updateBoard.isPending}
                            className="rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingBoardId(null)}
                            className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="hidden items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground tabular-nums sm:inline-flex">
                            <CheckCircle2 className="h-3 w-3 text-primary" />
                            {donePct}%
                          </span>
                          {deletingBoardId !== board.id && (
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                setEditBoardName(board.name);
                                setEditingBoardId(board.id);
                              }}
                              aria-label={`Rename ${board.name}`}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-primary/10 hover:!text-primary group-hover:text-muted-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      {editingBoardId !== board.id && deletingBoardId === board.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => deleteBoard.mutate({ id: board.id })}
                            className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setDeletingBoardId(null)}
                            className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            No
                          </button>
                        </div>
                      ) : editingBoardId !== board.id ? (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            setDeletingBoardId(board.id);
                          }}
                          aria-label={`Delete ${board.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-red-500/10 hover:!text-red-500 group-hover:text-muted-foreground"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* Mini-board: each column as a little stack of task tiles. */}
                  <Link
                    href={href}
                    aria-label={`Open ${board.name}`}
                    className="block rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {board.columns.map((col) => {
                        const n = col._count.tasks;
                        const tiles = Math.min(n, GHOST_WIDTHS.length);
                        const isDone = col.id === doneCol?.id;
                        return (
                          <div
                            key={col.id}
                            className="flex min-w-[92px] flex-1 flex-col gap-2 rounded-lg border border-border/50 bg-secondary/40 p-2.5 transition-colors group-hover:border-border"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {col.name}
                              </span>
                              <span
                                className={cn(
                                  'shrink-0 text-[10px] font-bold tabular-nums',
                                  n > 0 ? 'text-foreground' : 'text-muted-foreground/40'
                                )}
                              >
                                {n}
                              </span>
                            </div>
                            <div className="flex min-h-[2.75rem] flex-col gap-1">
                              {n === 0 ? (
                                <div className="h-2 w-1/2 rounded bg-foreground/[0.04]" />
                              ) : (
                                Array.from({ length: tiles }).map((_, ti) => (
                                  <div
                                    key={ti}
                                    className={cn(
                                      'h-2 rounded',
                                      isDone ? 'bg-primary/45' : 'bg-foreground/10'
                                    )}
                                    style={{ width: GHOST_WIDTHS[ti] }}
                                  />
                                ))
                              )}
                              {n > tiles && (
                                <span className="text-[9px] font-medium text-muted-foreground tabular-nums">
                                  +{n - tiles} more
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Link>

                  {/* Footer: real completion reading. */}
                  <div className="flex items-center gap-3">
                    <ProgressBar pct={donePct} className="flex-1" />
                    <span className="shrink-0 text-[11px] font-medium text-muted-foreground tabular-nums">
                      {doneCount}/{totalTasks} done
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {(createBoard.error || deleteBoard.error) && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {createBoard.error?.message || deleteBoard.error?.message}
        </p>
      )}
    </>
  );
}

function MilestonesTab({
  projectId,
  milestones,
}: {
  projectId: string;
  milestones: Array<{
    id: string;
    name: string;
    description: string | null;
    dueDate: Date;
    completedAt: Date | null;
  }>;
}) {
  const utils = trpc.useUtils();
  const [showAdd, setShowAdd] = useState(false);
  const [msName, setMsName] = useState('');
  const [msDesc, setMsDesc] = useState('');
  const [msDue, setMsDue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDue, setEditDue] = useState('');

  const createMilestone = trpc.projects.createMilestone.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setShowAdd(false);
      setMsName('');
      setMsDesc('');
      setMsDue('');
    },
  });
  const updateMilestone = trpc.projects.updateMilestone.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });
  const deleteMilestone = trpc.projects.deleteMilestone.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground tabular-nums">
          {milestones.length} milestone{milestones.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus className="h-3.5 w-3.5" /> Add Milestone
        </button>
      </div>

      {showAdd && (
        <Card className="border-primary/20 ring-primary/10">
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">Name *</label>
                <input
                  autoFocus
                  value={msName}
                  onChange={(e) => setMsName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && msName.trim() && msDue)
                      createMilestone.mutate({
                        projectId,
                        name: msName.trim(),
                        description: msDesc || undefined,
                        dueDate: new Date(msDue),
                      });
                  }}
                  placeholder="e.g. MVP Launch"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">Due Date *</label>
                <input
                  type="date"
                  value={msDue}
                  onChange={(e) => setMsDue(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">Description</label>
              <input
                value={msDesc}
                onChange={(e) => setMsDesc(e.target.value)}
                placeholder="Optional details..."
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAdd(false)}
                className="rounded-xl px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (msName.trim() && msDue)
                    createMilestone.mutate({
                      projectId,
                      name: msName.trim(),
                      description: msDesc || undefined,
                      dueDate: new Date(msDue),
                    });
                }}
                disabled={!msName.trim() || !msDue || createMilestone.isPending}
                className="flex items-center gap-1 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
              >
                {createMilestone.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{' '}
                Add
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {milestones.length === 0 && !showAdd ? (
        <EmptyState
          icon={Calendar}
          title="No milestones"
          description="Add milestones to track project progress"
        />
      ) : (
        <div className="relative space-y-3">
          {/* Timeline spine */}
          {milestones.length > 1 && (
            <span className="absolute bottom-5 left-5 top-5 w-px bg-border" aria-hidden />
          )}
          {milestones.map((ms) => {
            const isPast = new Date(ms.dueDate) < new Date();
            const isCompleted = !!ms.completedAt;
            const isEditingThis = editingId === ms.id;
            const due = deadlineMeta(new Date(ms.dueDate));

            if (isEditingThis) {
              return (
                <div key={ms.id} className="relative flex items-start gap-4">
                  <div
                    className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary ring-4 ring-background"
                    aria-hidden
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 space-y-3 rounded-xl border border-primary/20 bg-card p-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-foreground">
                          Name
                        </label>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-foreground">
                          Due Date
                        </label>
                        <input
                          type="date"
                          value={editDue}
                          onChange={(e) => setEditDue(e.target.value)}
                          className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-foreground">
                        Description
                      </label>
                      <input
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="Optional..."
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-lg px-3 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (editName.trim() && editDue) {
                            updateMilestone.mutate({
                              id: ms.id,
                              name: editName.trim(),
                              description: editDesc.trim() || null,
                              dueDate: new Date(editDue),
                            });
                            setEditingId(null);
                          }
                        }}
                        disabled={!editName.trim() || !editDue}
                        className="rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div key={ms.id} className="group relative flex items-start gap-4">
                {/* Timeline node — toggles complete */}
                <button
                  onClick={() =>
                    updateMilestone.mutate({
                      id: ms.id,
                      completedAt: isCompleted ? null : new Date(),
                    })
                  }
                  className={cn(
                    'relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-4 ring-background transition-colors',
                    isCompleted
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/20'
                      : isPast
                        ? 'bg-red-500/10 hover:bg-red-500/20'
                        : 'bg-amber-500/10 hover:bg-amber-500/20'
                  )}
                  title={isCompleted ? 'Mark incomplete' : 'Mark complete'}
                  aria-label={isCompleted ? 'Mark incomplete' : 'Mark complete'}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <Clock className={cn('h-5 w-5', isPast ? 'text-red-500' : 'text-amber-500')} />
                  )}
                </button>

                <div className="flex flex-1 items-center gap-4 rounded-xl border border-border/60 bg-card p-4">
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-sm font-medium',
                        isCompleted ? 'text-muted-foreground line-through' : 'text-foreground'
                      )}
                    >
                      {ms.name}
                    </p>
                    {ms.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {ms.description}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-medium text-foreground tabular-nums">
                      {format(new Date(ms.dueDate), 'MMM d, yyyy')}
                    </p>
                    {isCompleted && ms.completedAt ? (
                      <p className="mt-0.5 text-[11px] text-emerald-500 tabular-nums">
                        Completed {format(new Date(ms.completedAt), 'MMM d')}
                      </p>
                    ) : (
                      <p className={cn('mt-0.5 text-[11px] font-medium tabular-nums', due.tone)}>
                        {due.label}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setEditingId(ms.id);
                      setEditName(ms.name);
                      setEditDesc(ms.description || '');
                      setEditDue(format(new Date(ms.dueDate), 'yyyy-MM-dd'));
                    }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-secondary hover:!text-foreground group-hover:text-muted-foreground"
                    title="Edit milestone"
                    aria-label="Edit milestone"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => deleteMilestone.mutate({ id: ms.id })}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-red-500/10 hover:!text-red-500 group-hover:text-muted-foreground"
                    title="Delete milestone"
                    aria-label="Delete milestone"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(createMilestone.error || updateMilestone.error || deleteMilestone.error) && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {createMilestone.error?.message ||
            updateMilestone.error?.message ||
            deleteMilestone.error?.message}
        </p>
      )}
    </div>
  );
}

/* ============================================
   Files Tab — list + upload to ProjectFile
   ============================================ */
function FilesTab({
  projectId,
  files,
}: {
  projectId: string;
  files: Array<{
    id: string;
    name: string;
    url: string;
    createdAt: Date;
    uploadedBy: { id: string; name: string };
  }>;
}) {
  const utils = trpc.useUtils();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const addFile = trpc.projects.addFile.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });
  // IMP-PROJ-05: delete a project file (server-side access-checked).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const deleteFile = trpc.projects.deleteFile.useMutation({
    onSuccess: () => {
      setConfirmDeleteId(null);
      utils.projects.getById.invalidate({ id: projectId });
    },
  });

  // Reuse the shared upload pipeline (uploadAttachment → /api/upload) for the
  // blob, then persist the file record via the addFile mutation.
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after a failure
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadAttachment(file);
      await addFile.mutateAsync({
        projectId,
        name: uploaded.name,
        url: uploaded.url,
        type: uploaded.type ?? undefined,
        size: uploaded.size ?? undefined,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground tabular-nums">
          {files.length} file{files.length !== 1 ? 's' : ''}
        </p>
        <label
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] focus-within:outline-none focus-within:ring-2 focus-within:ring-ring/60',
            uploading && 'pointer-events-none opacity-60'
          )}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {uploading ? 'Uploading…' : 'Upload File'}
          <input type="file" className="hidden" onChange={handleFileSelect} />
        </label>
      </div>

      {(uploadError || addFile.error || deleteFile.error) && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {uploadError || addFile.error?.message || deleteFile.error?.message}
        </p>
      )}

      {files.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No files yet"
          description="Upload project files, designs, and documents"
        />
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <div
              key={f.id}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4',
                cardHover
              )}
            >
              <a
                href={safeHref(f.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-lg"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                  <FileText className="h-5 w-5 text-blue-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{f.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded by {f.uploadedBy.name} &middot;{' '}
                    {format(new Date(f.createdAt), 'MMM d, yyyy')}
                  </p>
                </div>
                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground/40" />
              </a>
              {confirmDeleteId === f.id ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => deleteFile.mutate({ id: f.id })}
                    disabled={deleteFile.isPending}
                    className="rounded-lg bg-red-500 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                  >
                    {deleteFile.isPending ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(f.id)}
                  title="Delete file"
                  className="shrink-0 rounded-lg p-2 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================
   Project Team Tab — list / add / remove / role
   ============================================ */
type ProjectMemberShape = {
  user: {
    id: string;
    name: string;
    email?: string | null;
    avatar: string | null;
    title: string | null;
    department?: string;
  };
  role: string;
};

function ProjectTeamTab({
  projectId,
  members,
}: {
  projectId: string;
  members: ProjectMemberShape[];
}) {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const userId = session?.user?.id;
  const isAdmin = session?.user?.role === 'ADMIN';

  // Caller's role on this project (for can-edit gating)
  const callerMembership = members.find((m) => m.user.id === userId);
  const canManage = isAdmin || callerMembership?.role === 'LEAD';

  const [showAdd, setShowAdd] = useState(false);
  const [picker, setPicker] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const team = trpc.team.getAll.useQuery(undefined, { enabled: showAdd });

  const addMember = trpc.projects.addMember.useMutation({
    // Optimistic: drop the member into the cache immediately so the team list
    // updates on click, instead of after the server round-trip.
    onMutate: async (vars) => {
      setPicker('');
      await utils.projects.getById.cancel({ id: projectId });
      const prev = utils.projects.getById.getData({ id: projectId });
      const candidate = (team.data ?? []).find((u) => u.id === vars.userId) as
        | {
            id: string;
            name: string;
            avatar: string | null;
            title: string | null;
            email?: string;
            department?: string | null;
          }
        | undefined;
      utils.projects.getById.setData({ id: projectId }, (old) => {
        if (!old || !candidate) return old;
        if (old.members.some((m) => m.user.id === vars.userId)) return old;
        const optimistic = {
          id: `optimistic-${vars.userId}`,
          projectId,
          userId: vars.userId,
          role: vars.role ?? 'MEMBER',
          user: {
            id: candidate.id,
            name: candidate.name,
            email: candidate.email ?? '',
            avatar: candidate.avatar ?? null,
            title: candidate.title ?? null,
            department: candidate.department ?? null,
          },
        } as (typeof old.members)[number];
        return { ...old, members: [...old.members, optimistic] };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back to the snapshot if the server rejected the add.
      if (ctx?.prev) utils.projects.getById.setData({ id: projectId }, ctx.prev);
    },
    onSettled: () => {
      // Reconcile the optimistic row with the server's real one.
      utils.projects.getById.invalidate({ id: projectId });
    },
  });
  const removeMember = trpc.projects.removeMember.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setRemovingId(null);
    },
  });
  const setRole = trpc.projects.setMemberRole.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });

  const memberIds = new Set(members.map((m) => m.user.id));
  const candidates = (team.data ?? []).filter(
    (u) =>
      !memberIds.has(u.id) &&
      (picker.trim().length === 0 ||
        u.name.toLowerCase().includes(picker.toLowerCase()) ||
        u.title?.toLowerCase().includes(picker.toLowerCase()))
  );

  const leadCount = members.filter((m) => m.role === 'LEAD').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground tabular-nums">
          {members.length} member{members.length !== 1 ? 's' : ''} &middot; {leadCount} lead
          {leadCount !== 1 ? 's' : ''}
        </p>
        {canManage && (
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Member
          </button>
        )}
      </div>

      {/* Add picker */}
      {showAdd && canManage && (
        <Card className="border-primary/20 ring-primary/10">
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-foreground">
                Add team member
              </h3>
              <button
                onClick={() => setShowAdd(false)}
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                type="text"
                value={picker}
                onChange={(e) => setPicker(e.target.value)}
                placeholder="Search team members…"
                className="flex h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {team.isLoading ? (
              <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading team…
              </div>
            ) : candidates.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">
                {team.data && team.data.length === members.length
                  ? 'Everyone is already on this project.'
                  : 'No matching members.'}
              </p>
            ) : (
              <div className="max-h-56 divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/60 bg-card">
                {candidates.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => addMember.mutate({ projectId, userId: u.id, role: 'MEMBER' })}
                    disabled={addMember.isPending}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={u.avatar ?? undefined} />
                      <AvatarFallback className="bg-secondary text-[10px]">
                        {u.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{u.name}</p>
                      {u.title && (
                        <p className="truncate text-[10px] text-muted-foreground">{u.title}</p>
                      )}
                    </div>
                    <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Members grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => {
          const isLead = m.role === 'LEAD';
          const isLastLead = isLead && leadCount === 1;
          const isSelf = m.user.id === userId;
          const isConfirmingRemove = removingId === m.user.id;
          const canEditThis = canManage || isSelf;

          return (
            <Card key={m.user.id} className="group relative border-border/60">
              <CardContent className="flex items-center gap-4">
                <Avatar className="h-11 w-11">
                  <AvatarImage src={m.user.avatar ?? undefined} />
                  <AvatarFallback className="bg-secondary font-medium text-foreground">
                    {m.user.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {m.user.name}{' '}
                    {isSelf && (
                      <span className="text-[10px] font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.user.title}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                        isLead ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {isLead && <Crown className="h-2.5 w-2.5" />}
                      {m.role}
                    </span>
                    {canManage && !isLastLead && (
                      <button
                        onClick={() =>
                          setRole.mutate({
                            projectId,
                            userId: m.user.id,
                            role: isLead ? 'MEMBER' : 'LEAD',
                          })
                        }
                        disabled={setRole.isPending}
                        className="text-[10px] text-muted-foreground hover:text-primary disabled:opacity-50"
                        title={isLead ? 'Demote to member' : 'Promote to lead'}
                      >
                        {isLead ? '· demote' : '· make lead'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Remove button — only for managers, or self-leave */}
                {canEditThis &&
                  !isLastLead &&
                  (isConfirmingRemove ? (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <button
                        onClick={() => removeMember.mutate({ projectId, userId: m.user.id })}
                        disabled={removeMember.isPending}
                        className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {removeMember.isPending ? '...' : 'Remove'}
                      </button>
                      <button
                        onClick={() => setRemovingId(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRemovingId(m.user.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-red-500/10 hover:!text-red-500 group-hover:text-muted-foreground"
                      title={isSelf ? 'Leave project' : 'Remove from project'}
                      aria-label={isSelf ? 'Leave project' : 'Remove from project'}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {(addMember.error || removeMember.error || setRole.error) && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {addMember.error?.message || removeMember.error?.message || setRole.error?.message}
        </p>
      )}
    </div>
  );
}

/* ============================================
   Small presentational helpers
   ============================================ */
function Fact({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn('text-sm font-medium text-foreground', numeric && 'tabular-nums')}>
        {value}
      </p>
    </div>
  );
}

function StatTile({
  icon: Icon,
  value,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="font-display text-xl font-bold text-foreground tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
      <Icon className="h-12 w-12 text-muted-foreground/20" />
      <h3 className="mt-4 font-display text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function ProjectDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-28" />
      <Card className="border-border/60">
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <Skeleton className="h-8 w-96" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="border-border/60 lg:col-span-2">
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-20 w-full" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent>
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-32">
      <FolderKanban className="h-16 w-16 text-muted-foreground/20" />
      <h2 className="mt-4 font-display text-xl font-semibold text-foreground">Project not found</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This project may have been deleted or you don&apos;t have access.
      </p>
      <Link href="/projects" className="mt-6 text-sm font-medium text-primary hover:underline">
        Back to Projects
      </Link>
    </div>
  );
}
