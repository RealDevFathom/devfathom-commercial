'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Plus,
  Search,
  FileText,
  Globe2,
  Lock,
  Users,
  Trash2,
  Loader2,
  ArrowUpRight,
  Link2,
  Share2,
  X,
  Check,
  Save,
  Pencil,
  AtSign,
  History,
  RotateCcw,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

// TipTap/ProseMirror is heavy; only load it on the client when a note detail
// pane actually mounts (i.e. in edit/view of a selected note), keeping it out
// of the initial bundle. ssr:false is allowed here because this is a Client
// Component (see node_modules/next/dist/docs/.../lazy-loading.md).
const NoteEditor = dynamic(
  () => import('@/components/notes/note-editor').then((mod) => mod.NoteEditor),
  { ssr: false }
);

type Visibility = 'PRIVATE' | 'SHARED' | 'TEAM';
type Scope = 'all' | 'mine' | 'shared' | 'mentions';

// IMP-NOTE-02: 'mentions' surfaces notes that @mention the current user.
const SCOPES: readonly Scope[] = ['all', 'mine', 'shared', 'mentions'];
const SCOPE_LABELS: Record<Scope, string> = {
  all: 'All',
  mine: 'My notes',
  shared: 'Shared',
  mentions: 'Mentions',
};

const visibilityConfig: Record<Visibility, { icon: typeof Lock; label: string; bg: string }> = {
  PRIVATE: { icon: Lock, label: 'Private', bg: 'bg-muted text-muted-foreground' },
  SHARED: { icon: Users, label: 'Shared', bg: 'bg-blue-500/10 text-blue-500' },
  TEAM: { icon: Globe2, label: 'Team', bg: 'bg-emerald-500/10 text-emerald-500' },
};

export interface NotesContentProps {
  selectedId?: string;
  /** When set, the list is scoped to this project. */
  projectId?: string;
  /** When set, the list is scoped to this client. */
  clientId?: string;
  /** When true, render in compact "tab" mode (no big page header). */
  embedded?: boolean;
}

export function NotesContent({ selectedId, projectId, clientId, embedded }: NotesContentProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const [scope, setScope] = useState<Scope>('all');
  const [search, setSearch] = useState('');
  // Debounce the raw input into the query so we don't refetch per keystroke
  // (same ~200ms pattern as the topbar command search).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  const listResult = trpc.notes.list.useQuery(
    {
      // The list procedure only knows mine/shared/all; the 'mentions' scope is
      // served by a separate query below, so map it to a valid (disabled) value.
      scope: scope === 'mentions' ? 'all' : scope,
      projectId,
      clientId,
      search: debouncedSearch || undefined,
    },
    // Keep showing the previous list while a new query resolves so the sidebar
    // doesn't flash skeletons on every keystroke / filter change.
    { enabled: scope !== 'mentions', placeholderData: (prev) => prev }
  );

  // IMP-NOTE-02: "notes that mention me" — only fetched when its chip is active.
  const mentionsResult = trpc.notes.notesMentioningMe.useQuery(undefined, {
    enabled: scope === 'mentions',
    placeholderData: (prev) => prev,
  });

  const activeIsLoading = scope === 'mentions' ? mentionsResult.isLoading : listResult.isLoading;
  const activeData = scope === 'mentions' ? mentionsResult.data : listResult.data;

  const createNote = trpc.notes.create.useMutation({
    onSuccess: (note) => {
      utils.notes.list.invalidate();
      utils.notes.notesMentioningMe.invalidate();
      router.push(embedded ? `/notes/${note.id}` : `/notes/${note.id}`);
    },
  });

  const handleCreate = () => {
    createNote.mutate({
      title: 'Untitled',
      visibility: 'PRIVATE',
      projectId,
      clientId,
    });
  };

  return (
    <div className={embedded ? 'space-y-4 animate-fade-in' : 'space-y-6'}>
      {!embedded && (
        <PageHeader
          eyebrow="WORKSPACE"
          heading="Notes"
          description="Capture ideas, link them together, share them with the team."
          actions={
            <Button size="lg" onClick={handleCreate} disabled={createNote.isPending}>
              {createNote.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              New Note
            </Button>
          }
        />
      )}

      {/* minmax(0,1fr) instead of 1fr so the content column can shrink below
          its intrinsic content width — otherwise a long token or URL in a
          note stretches the grid and pushes the Edit button past the viewport. */}
      <div
        className={cn(
          'grid gap-5 grid-cols-1',
          embedded ? 'lg:grid-cols-[280px_minmax(0,1fr)]' : 'lg:grid-cols-[320px_minmax(0,1fr)]'
        )}
      >
        {/* LEFT — note list */}
        <div className="space-y-3">
          {/* Filter chips */}
          <div className="flex items-center gap-1.5">
            {SCOPES.map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                  scope === s
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                {SCOPE_LABELS[s]}
              </button>
            ))}
            {embedded && (
              <button
                onClick={handleCreate}
                disabled={createNote.isPending}
                className="ml-auto flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-50"
              >
                {createNote.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                New
              </button>
            )}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex h-9 w-full rounded-xl border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* List */}
          <div className="space-y-1.5">
            {activeIsLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="p-3">
                    <Skeleton className="mb-2 h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </CardContent>
                </Card>
              ))
            ) : (activeData?.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center">
                <FileText className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {scope === 'mentions' ? 'No notes mention you yet' : 'No notes yet'}
                </p>
                {scope !== 'mentions' && (
                  <button
                    onClick={handleCreate}
                    disabled={createNote.isPending}
                    className="mt-3 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" /> New note
                  </button>
                )}
              </div>
            ) : (
              activeData!.map((n) => (
                <NoteListRow key={n.id} note={n} isSelected={selectedId === n.id} userId={userId} />
              ))
            )}
          </div>
        </div>

        {/* RIGHT — editor or empty state.
            min-w-0 is critical so this column can actually shrink per the
            grid's minmax(0,1fr) instead of getting pushed by its contents. */}
        <div className="min-w-0">
          {selectedId ? (
            <NoteDetail key={selectedId} noteId={selectedId} />
          ) : (
            <Card className="border-dashed border-border/60">
              <CardContent className="flex flex-col items-center justify-center py-24 text-center">
                <FileText className="h-12 w-12 text-muted-foreground/20" />
                <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
                  Select a note
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick one from the list or create a new note to get started.
                </p>
                <p className="mt-3 max-w-sm text-xs text-muted-foreground/80">
                  Tip: type <span className="rounded bg-muted px-1.5 py-0.5 font-mono">[[</span>{' '}
                  inside any note to link to another note, or{' '}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono">@name</span> to mention
                  a teammate (they&rsquo;re notified on save if they can see the note).
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   Memoized sidebar row — keeps the list from re-rendering every row on each
   keystroke / placeholder swap; only re-renders when its own props change.
   ============================================ */
type NoteListItem = inferRouterOutputs<AppRouter>['notes']['list'][number];

const NoteListRow = memo(function NoteListRow({
  note: n,
  isSelected,
  userId,
}: {
  note: NoteListItem;
  isSelected: boolean;
  userId?: string;
}) {
  const vc = visibilityConfig[n.visibility as Visibility];
  const Icon = vc.icon;
  return (
    <Link
      href={`/notes/${n.id}`}
      className={cn(
        'block rounded-xl border px-3 py-2.5 transition-all',
        isSelected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border/60 bg-card hover:border-border hover:shadow-sm'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground truncate">{n.title || 'Untitled'}</p>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
            vc.bg
          )}
        >
          <Icon className="h-2.5 w-2.5" />
          {vc.label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Avatar className="h-3.5 w-3.5">
          <AvatarImage src={n.author.avatar ?? undefined} />
          <AvatarFallback className="bg-secondary text-[7px]">{n.author.name[0]}</AvatarFallback>
        </Avatar>
        <span>{n.author.id === userId ? 'You' : n.author.name}</span>
        <span>·</span>
        <span>{format(new Date(n.updatedAt), 'MMM d')}</span>
      </div>
    </Link>
  );
});

/* ============================================
   Detail pane (editor + meta + backlinks)

   Two modes:
   - VIEW (default): renders the latest server content read-only. The editor is
     keyed on the note's updatedAt so any server-side change re-mounts cleanly.
     React Query refetches on focus so you see teammates' edits.
   - EDIT: takes a snapshot of the current note into a local draft. The editor
     is keyed on a stable "edit session" key so it doesn't re-mount when the
     server data refetches in the background. Refetch on focus is disabled to
     avoid stomping the draft. Save sends the draft to the server (last write
     wins), then refetches and returns to view mode. Cancel discards the draft.
   ============================================ */
function NoteDetail({ noteId }: { noteId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState<unknown>(null);
  const [showSharePanel, setShowSharePanel] = useState(false);
  // IMP-NOTE-01: toggles the version-history panel.
  const [showHistory, setShowHistory] = useState(false);

  // Disable refetch-on-focus while editing so the server state can't stomp
  // the user's in-progress draft. View mode keeps the default (refetch).
  const noteQuery = trpc.notes.getById.useQuery(
    { id: noteId },
    { refetchOnWindowFocus: mode === 'view' }
  );
  const note = noteQuery.data;

  // Show the note title in the topbar breadcrumb instead of the raw id.
  useBreadcrumbLabel(noteId, note ? note.title || 'Untitled' : undefined);

  const updateNote = trpc.notes.update.useMutation({
    onSuccess: () => {
      // Refetch this note + the sidebar list so view mode gets the fresh
      // server state. This is safe because we only call it after exiting edit
      // mode (or as part of the save flow), so it can't interrupt typing.
      utils.notes.getById.invalidate({ id: noteId });
      utils.notes.list.invalidate();
      // IMP-NOTE-02: a save may have changed the @mention set.
      utils.notes.notesMentioningMe.invalidate();
      setMode('view');
    },
  });

  const deleteNote = trpc.notes.delete.useMutation({
    onSuccess: () => {
      utils.notes.list.invalidate();
      router.push('/notes');
    },
  });

  const enterEditMode = () => {
    if (!note) return;
    setDraftTitle(note.title);
    setDraftContent(note.contentJson);
    setShowHistory(false);
    setMode('edit');
  };

  const cancelEdit = () => {
    // No "are you sure" — the draft is local, server is untouched.
    setDraftTitle('');
    setDraftContent(null);
    setMode('view');
  };

  const handleSave = useCallback(() => {
    if (!note || mode !== 'edit') return;
    updateNote.mutate({
      id: noteId,
      title: draftTitle.trim() || 'Untitled',
      contentJson: draftContent,
    });
  }, [mode, note, noteId, draftTitle, draftContent, updateNote]);

  // Cmd/Ctrl+S saves while in edit mode
  useEffect(() => {
    if (mode !== 'edit') return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, handleSave]);

  // Browser warning on tab close if there are unsaved changes
  useEffect(() => {
    if (mode !== 'edit') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [mode]);

  // Helper passed to the editor: when a user picks "Create new" inside [[ popup
  const handleCreateLinked = useCallback(
    async (linkTitle: string) => {
      const created = await utils.client.notes.create.mutate({
        title: linkTitle,
        visibility: 'PRIVATE',
      });
      utils.notes.list.invalidate();
      utils.notes.search.invalidate();
      return { id: created.id, title: created.title };
    },
    [utils]
  );

  if (noteQuery.isLoading) {
    return (
      <Card className="border-border/60">
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!note) {
    return (
      <Card className="border-border/60">
        <CardContent className="py-16 text-center">
          <p className="text-sm text-muted-foreground">Note not found.</p>
        </CardContent>
      </Card>
    );
  }

  const vc = visibilityConfig[note.visibility as Visibility];
  const VIcon = vc.icon;
  const isAuthor = note.authorId === userId;
  const isAdmin = session?.user?.role === 'ADMIN';
  const isEditing = mode === 'edit';

  // Editor key:
  //   view mode: includes updatedAt → re-mounts when teammates save changes
  //   edit mode: a stable per-edit-session key so background refetches don't
  //              cause the editor to reset and lose the user's typing
  const editorKey = isEditing
    ? `${note.id}-edit`
    : `${note.id}-view-${new Date(note.updatedAt).getTime()}`;

  // Content rendered by the editor — draft when editing, server when viewing
  const editorContent = isEditing ? draftContent : note.contentJson;
  // Title shown in the input — draft when editing, server when viewing
  const titleValue = isEditing ? draftTitle : note.title;

  return (
    <Card className="border-border/60">
      <CardContent className="space-y-4 p-5">
        {/* Header: title + visibility + actions */}
        <div className="flex items-start gap-3">
          <input
            value={titleValue}
            onChange={(e) => isEditing && setDraftTitle(e.target.value)}
            placeholder="Untitled"
            readOnly={!isEditing}
            className={cn(
              // min-w-0 so a long title in a flex row doesn't push the buttons away
              'flex-1 min-w-0 bg-transparent font-display text-2xl font-bold tracking-tight text-foreground placeholder:text-muted-foreground focus:outline-none truncate',
              !isEditing && 'cursor-default'
            )}
          />

          {/* Edit / Save / Cancel actions */}
          {isEditing ? (
            <>
              <button
                onClick={cancelEdit}
                disabled={updateNote.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateNote.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:opacity-50"
                title="Save (⌘S)"
              >
                {updateNote.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </button>
            </>
          ) : (
            note.editable && (
              <button
                onClick={enterEditMode}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                title="Edit this note"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
            )
          )}

          {/* IMP-NOTE-01: version history — available to anyone who can view the
              note (restore is gated to author/admin inside the panel). */}
          {!isEditing && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                showHistory
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              )}
              title="View version history"
            >
              <History className="h-3.5 w-3.5" />
              History
            </button>
          )}

          {isAuthor ? (
            <>
              <select
                value={note.visibility}
                onChange={(e) =>
                  updateNote.mutate({ id: noteId, visibility: e.target.value as Visibility })
                }
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground focus:border-primary focus:outline-none"
              >
                <option value="PRIVATE">Private</option>
                <option value="SHARED">Shared</option>
                <option value="TEAM">Team</option>
              </select>
              <button
                onClick={() => setShowSharePanel((v) => !v)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  showSharePanel || note.shares.length > 0
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground'
                )}
                title="Share with team members"
              >
                <Share2 className="h-3.5 w-3.5" />
                Share
                {note.shares.length > 0 && (
                  <span className="rounded-full bg-primary/20 px-1.5 text-[10px] font-bold">
                    {note.shares.length}
                  </span>
                )}
              </button>
            </>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium',
                vc.bg
              )}
            >
              <VIcon className="h-3 w-3" /> {vc.label}
            </span>
          )}
          {isAuthor && (
            <button
              onClick={() => {
                if (confirm('Delete this note? This cannot be undone.')) {
                  deleteNote.mutate({ id: noteId });
                }
              }}
              className="rounded-lg border border-border bg-card p-2 text-muted-foreground transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-500"
              title="Delete note"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Share panel — author only */}
        {isAuthor && showSharePanel && (
          <SharePanel
            noteId={noteId}
            visibility={note.visibility as Visibility}
            shares={note.shares}
            authorId={note.authorId}
            onClose={() => setShowSharePanel(false)}
          />
        )}

        {/* IMP-NOTE-01: version history — list past snapshots, preview one, and
            (author/admin) restore it. */}
        {showHistory && (
          <HistoryPanel
            noteId={noteId}
            canRestore={isAuthor || isAdmin}
            onClose={() => setShowHistory(false)}
          />
        )}

        {/* Meta line */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground border-b border-border/60 pb-3">
          <div className="flex items-center gap-1.5">
            <Avatar className="h-4 w-4">
              <AvatarImage src={note.author.avatar ?? undefined} />
              <AvatarFallback className="bg-secondary text-[8px]">
                {note.author.name[0]}
              </AvatarFallback>
            </Avatar>
            <span>{isAuthor ? 'You' : note.author.name}</span>
          </div>
          <span>·</span>
          <span>Updated {format(new Date(note.updatedAt), 'MMM d, yyyy h:mm a')}</span>
          {note.project && (
            <>
              <span>·</span>
              <Link
                href={`/projects/${note.project.id}`}
                className="flex items-center gap-1 hover:text-primary"
              >
                <ArrowUpRight className="h-3 w-3" />
                {note.project.name}
              </Link>
            </>
          )}
          {note.client && (
            <>
              <span>·</span>
              <Link
                href={`/clients/${note.client.id}`}
                className="flex items-center gap-1 hover:text-primary"
              >
                <ArrowUpRight className="h-3 w-3" />
                {note.client.name}
              </Link>
            </>
          )}
          {!note.editable && (
            <>
              <span>·</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium">View only</span>
            </>
          )}
          {isEditing && (
            <>
              <span>·</span>
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-500">
                Editing
              </span>
            </>
          )}
        </div>

        {/* IMP-NOTE-02: people @mentioned in this note. The server already
            scopes mentions to who can see the note, so showing them to any
            viewer who passed the visibility check leaks nothing. */}
        {note.mentions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="flex items-center gap-1 font-medium text-muted-foreground">
              <AtSign className="h-3 w-3" /> Mentioned:
            </span>
            {note.mentions.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-foreground"
              >
                <Avatar className="h-3.5 w-3.5">
                  <AvatarImage src={m.user.avatar ?? undefined} />
                  <AvatarFallback className="bg-secondary text-[7px]">
                    {m.user.name[0]}
                  </AvatarFallback>
                </Avatar>
                {m.user.id === userId ? 'You' : m.user.name}
              </span>
            ))}
          </div>
        )}

        {/* Editor
            - View mode: keyed on updatedAt so server changes from teammates
              re-mount the editor with the latest content.
            - Edit mode: stable key for the duration of the session so
              background refetches don't reset the user's typing. */}
        <NoteEditor
          key={editorKey}
          initialContent={editorContent}
          editable={isEditing}
          onChange={(json) => {
            if (isEditing) setDraftContent(json);
          }}
          onCreateLinkedNote={handleCreateLinked}
          saving={updateNote.isPending}
        />

        {/* Backlinks */}
        {note.linksTo.length > 0 && (
          <div className="border-t border-border/60 pt-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Link2 className="h-3 w-3" /> Linked mentions ({note.linksTo.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {note.linksTo.map((l) => (
                <Link
                  key={l.id}
                  href={`/notes/${l.fromNote.id}`}
                  className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  <FileText className="h-3 w-3" />
                  {l.fromNote.title}
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================
   Share Panel — author picks team members + permission
   ============================================ */
type ShareEntry = {
  user: { id: string; name: string; avatar: string | null };
  permission: 'VIEW' | 'EDIT';
};

function SharePanel({
  noteId,
  visibility,
  shares,
  authorId,
  onClose,
}: {
  noteId: string;
  visibility: Visibility;
  shares: ShareEntry[];
  authorId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const team = trpc.team.getAll.useQuery();
  const [picker, setPicker] = useState('');

  const setShares = trpc.notes.setShares.useMutation({
    onSuccess: () => utils.notes.getById.invalidate({ id: noteId }),
  });
  const updateNote = trpc.notes.update.useMutation({
    onSuccess: () => utils.notes.getById.invalidate({ id: noteId }),
  });

  const sharedIds = new Set(shares.map((s) => s.user.id));
  const candidates = (team.data ?? []).filter(
    (u) =>
      u.id !== authorId &&
      !sharedIds.has(u.id) &&
      (picker.trim().length === 0 || u.name.toLowerCase().includes(picker.toLowerCase()))
  );

  // Sends the full new share list to the server (setShares replaces).
  const persist = (next: ShareEntry[]) => {
    setShares.mutate({
      id: noteId,
      shares: next.map((s) => ({ userId: s.user.id, permission: s.permission })),
    });
  };

  const addUser = (user: { id: string; name: string; avatar: string | null }) => {
    const next: ShareEntry[] = [...shares, { user, permission: 'VIEW' }];
    persist(next);
    // If currently PRIVATE, auto-flip to SHARED so the share takes effect
    if (visibility === 'PRIVATE') {
      updateNote.mutate({ id: noteId, visibility: 'SHARED' });
    }
    setPicker('');
  };

  const removeUser = (userId: string) => {
    persist(shares.filter((s) => s.user.id !== userId));
  };

  const setPerm = (userId: string, permission: 'VIEW' | 'EDIT') => {
    persist(shares.map((s) => (s.user.id === userId ? { ...s, permission } : s)));
  };

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Share this note</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {visibility === 'TEAM'
              ? 'This note is visible to the entire team — individual shares are not needed.'
              : visibility === 'PRIVATE'
                ? 'Adding a member will switch this note to Shared visibility.'
                : 'Pick team members and choose their permission.'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close share panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Current shares */}
      {shares.length > 0 && (
        <div className="space-y-1.5">
          {shares.map((s) => (
            <div
              key={s.user.id}
              className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={s.user.avatar ?? undefined} />
                <AvatarFallback className="bg-secondary text-[10px]">
                  {s.user.name[0]}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate text-sm font-medium text-foreground">
                {s.user.name}
              </span>
              <select
                value={s.permission}
                onChange={(e) => setPerm(s.user.id, e.target.value as 'VIEW' | 'EDIT')}
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground focus:border-primary focus:outline-none"
              >
                <option value="VIEW">Can view</option>
                <option value="EDIT">Can edit</option>
              </select>
              <button
                onClick={() => removeUser(s.user.id)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                aria-label={`Remove ${s.user.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add member picker */}
      {visibility !== 'TEAM' && (
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
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
              {sharedIds.size > 0 && team.data && team.data.length - 1 === sharedIds.size
                ? 'Everyone is already added.'
                : 'No matching members.'}
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-border/60 bg-card">
              {candidates.map((u) => (
                <button
                  key={u.id}
                  onClick={() => addUser(u)}
                  disabled={setShares.isPending}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={u.avatar ?? undefined} />
                    <AvatarFallback className="bg-secondary text-[9px]">{u.name[0]}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{u.name}</p>
                    {u.title && (
                      <p className="text-[10px] text-muted-foreground truncate">{u.title}</p>
                    )}
                  </div>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Saving indicator */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {setShares.isPending ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </>
        ) : (
          <>
            <Check className="h-3 w-3 text-emerald-500" /> Changes saved automatically
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================
   IMP-NOTE-01: Version history panel

   Left  — the list of snapshots (newest first), each labelled with its title,
           timestamp and editor.
   Right — a read-only preview of the selected snapshot (full Tiptap render), with
           a "Restore this version" action for the author/admin. Restoring first
           snapshots the CURRENT content (server-side), so it is itself undoable.
   ============================================ */
function HistoryPanel({
  noteId,
  canRestore,
  onClose,
}: {
  noteId: string;
  canRestore: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const revisionsQuery = trpc.notes.getNoteRevisions.useQuery({ noteId });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const revisionQuery = trpc.notes.getRevision.useQuery(
    { id: selectedId ?? '' },
    { enabled: !!selectedId }
  );

  const restore = trpc.notes.restoreRevision.useMutation({
    onSuccess: () => {
      utils.notes.getById.invalidate({ id: noteId });
      utils.notes.list.invalidate();
      utils.notes.notesMentioningMe.invalidate();
      utils.notes.getNoteRevisions.invalidate({ noteId });
      setSelectedId(null);
      onClose();
    },
  });

  const revisions = revisionsQuery.data ?? [];
  const editorLabel = (editedBy: { id: string; name: string } | null) =>
    editedBy ? ` · ${editedBy.id === userId ? 'You' : editedBy.name}` : '';

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Version history</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A snapshot is saved before each content change. The most recent 50 are kept.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close history panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Revision list */}
        <div>
          {revisionsQuery.isLoading ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : revisions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
              No earlier versions yet. Your next edit will create one.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
              {revisions.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'block w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    selectedId === r.id
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/60 bg-card hover:border-border'
                  )}
                >
                  <p className="text-xs font-medium text-foreground truncate">
                    {r.title || 'Untitled'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {format(new Date(r.createdAt), 'MMM d, yyyy h:mm a')}
                    {editorLabel(r.editedBy)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected revision preview */}
        <div className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
          {!selectedId ? (
            <div className="flex h-full min-h-32 flex-col items-center justify-center text-center">
              <Clock className="h-6 w-6 text-muted-foreground/30" />
              <p className="mt-2 text-xs text-muted-foreground">
                Select a version on the left to preview it here.
              </p>
            </div>
          ) : revisionQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading version…
            </div>
          ) : revisionQuery.data ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display text-base font-bold text-foreground truncate">
                    {revisionQuery.data.title || 'Untitled'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {format(new Date(revisionQuery.data.createdAt), 'MMM d, yyyy h:mm a')}
                    {editorLabel(revisionQuery.data.editedBy)}
                  </p>
                </div>
                {canRestore && (
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          'Restore this version? The current content is saved to history first, so you can undo this.'
                        )
                      ) {
                        restore.mutate({ id: revisionQuery.data!.id });
                      }
                    }}
                    disabled={restore.isPending}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:opacity-50"
                    title="Restore this version"
                  >
                    {restore.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    Restore this version
                  </button>
                )}
              </div>
              {/* Full read-only render of the snapshot. */}
              <div className="max-h-80 overflow-y-auto rounded-lg border border-border/40 bg-background px-1">
                <NoteEditor
                  key={revisionQuery.data.id}
                  initialContent={revisionQuery.data.contentJson}
                  editable={false}
                />
              </div>
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">Version not found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
