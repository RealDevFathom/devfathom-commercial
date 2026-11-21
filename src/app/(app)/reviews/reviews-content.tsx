'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  ClipboardList,
  Plus,
  Loader2,
  Star,
  Lock,
  Unlock,
  ChevronLeft,
  UserPlus,
  CheckCircle2,
  Inbox,
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
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { AppRouter } from '@/server/routers/_app';
import { format } from 'date-fns';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Cycle = RouterOutputs['reviews']['listCycles'][number];
type ReviewRow = RouterOutputs['reviews']['listReviews'][number];

const initials = (name: string) =>
  name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2);

/* ============================================================
   Root
   ============================================================ */
export function ReviewsContent() {
  const { data: session } = useSession();
  const isManager = session?.user?.role === 'ADMIN' || session?.user?.role === 'HR';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="FIRM"
        heading="Performance Reviews"
        description={
          isManager
            ? 'Run review cycles, assign reviewers, and complete your own reviews.'
            : 'Reviews assigned to you and feedback shared about your work.'
        }
      />

      {isManager ? (
        <Tabs defaultValue="cycles" className="space-y-6">
          <TabsList>
            <TabsTrigger value="cycles">Cycles</TabsTrigger>
            <TabsTrigger value="mine">My Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="cycles">
            <CyclesManager />
          </TabsContent>
          <TabsContent value="mine">
            <MyReviewsPanel />
          </TabsContent>
        </Tabs>
      ) : (
        <MyReviewsPanel />
      )}
    </div>
  );
}

/* ============================================================
   Cycles manager (HR/Admin) — list, create, close/reopen, drill in
   ============================================================ */
function CyclesManager() {
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const { data: cycles, isLoading } = trpc.reviews.listCycles.useQuery();

  const selectedCycle = useMemo(
    () => cycles?.find((c) => c.id === selectedCycleId) ?? null,
    [cycles, selectedCycleId]
  );

  if (selectedCycle) {
    return <CycleDetail cycle={selectedCycle} onBack={() => setSelectedCycleId(null)} />;
  }

  return <CyclesList cycles={cycles} isLoading={isLoading} onOpen={setSelectedCycleId} />;
}

function CyclesList({
  cycles,
  isLoading,
  onOpen,
}: {
  cycles: Cycle[] | undefined;
  isLoading: boolean;
  onOpen: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const [showCreate, setShowCreate] = useState(false);

  const toggle = trpc.reviews.closeCycle.useMutation();
  const reopen = trpc.reviews.reopenCycle.useMutation();

  const setStatus = (cycle: Cycle) => {
    const mut = cycle.status === 'OPEN' ? toggle : reopen;
    mut.mutate({ id: cycle.id }, { onSuccess: () => utils.reviews.listCycles.invalidate() });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {cycles?.length
            ? `${cycles.length} review cycle${cycles.length !== 1 ? 's' : ''}`
            : 'No review cycles yet'}
          .
        </p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> New cycle
        </Button>
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : !cycles || cycles.length === 0 ? (
            <div className="py-16 text-center">
              <ClipboardList className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No review cycles yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {cycles.map((cycle) => (
                <div key={cycle.id} className="flex items-center gap-4 px-6 py-4">
                  <button
                    onClick={() => onOpen(cycle.id)}
                    className="flex-1 min-w-0 text-left group"
                  >
                    <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                      {cycle.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(cycle.startDate), 'MMM d')} –{' '}
                      {format(new Date(cycle.endDate), 'MMM d, yyyy')} · {cycle._count.reviews}{' '}
                      review{cycle._count.reviews !== 1 ? 's' : ''}
                    </p>
                  </button>
                  <StatusBadge status={cycle.status} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatus(cycle)}
                    disabled={toggle.isPending || reopen.isPending}
                    title={cycle.status === 'OPEN' ? 'Close cycle' : 'Reopen cycle'}
                  >
                    {cycle.status === 'OPEN' ? (
                      <>
                        <Lock className="h-3.5 w-3.5" /> Close
                      </>
                    ) : (
                      <>
                        <Unlock className="h-3.5 w-3.5" /> Reopen
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateCycleDialog
        key={showCreate ? 'open' : 'closed'}
        open={showCreate}
        onClose={() => setShowCreate(false)}
      />
    </div>
  );
}

function CreateCycleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const create = trpc.reviews.createCycle.useMutation({
    onSuccess: () => {
      utils.reviews.listCycles.invalidate();
      onClose();
    },
  });

  const datesValid = !!startDate && !!endDate && endDate >= startDate;
  const canSubmit = name.trim().length > 0 && datesValid && !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (create.isPending) return;
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New review cycle</DialogTitle>
          <DialogDescription>
            Define the evaluation window, then assign reviewers from the cycle.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. H1 2026 Performance Review"
              disabled={create.isPending}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">Start date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={create.isPending}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">End date</label>
              <Input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={create.isPending}
              />
            </div>
          </div>
          {startDate && endDate && !datesValid && (
            <p className="text-[11px] text-destructive">
              The end date must be on or after the start date.
            </p>
          )}
          {create.error && <p className="text-xs text-destructive">{create.error.message}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              if (!canSubmit) return;
              create.mutate({
                name: name.trim(),
                startDate: new Date(startDate),
                endDate: new Date(endDate),
              });
            }}
            disabled={!canSubmit}
          >
            {create.isPending && <Loader2 className="animate-spin" />}
            {create.isPending ? 'Creating...' : 'Create cycle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================
   Cycle detail (HR/Admin) — assign reviewers + see all reviews
   ============================================================ */
function CycleDetail({ cycle, onBack }: { cycle: Cycle; onBack: () => void }) {
  const { data: reviews, isLoading } = trpc.reviews.listReviews.useQuery({ cycleId: cycle.id });

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-4 w-4" /> All cycles
      </button>

      <div className="flex items-center gap-3">
        <h2 className="font-display text-lg font-semibold text-foreground">{cycle.name}</h2>
        <StatusBadge status={cycle.status} />
      </div>

      {cycle.status === 'OPEN' && <AssignReviewerForm cycleId={cycle.id} />}

      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px] font-semibold text-foreground">
            Assigned reviews
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !reviews || reviews.length === 0 ? (
            <div className="py-12 text-center">
              <UserPlus className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No reviewers assigned yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {reviews.map((r) => (
                <div key={r.id} className="flex items-center gap-4 px-6 py-3.5">
                  <PersonChip name={r.subject.name} avatar={r.subject.avatar} sub="subject" />
                  <span className="text-xs text-muted-foreground">reviewed by</span>
                  <PersonChip name={r.reviewer.name} avatar={r.reviewer.avatar} sub="reviewer" />
                  <div className="ml-auto flex items-center gap-3">
                    {r.status === 'SUBMITTED' && r.rating != null && <Stars value={r.rating} />}
                    <StatusBadge status={r.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AssignReviewerForm({ cycleId }: { cycleId: string }) {
  const utils = trpc.useUtils();
  const { data: roster } = trpc.team.getRoster.useQuery();
  const [subjectId, setSubjectId] = useState('');
  const [reviewerId, setReviewerId] = useState('');

  const add = trpc.reviews.addReview.useMutation({
    onSuccess: () => {
      utils.reviews.listReviews.invalidate({ cycleId });
      utils.reviews.listCycles.invalidate();
      setSubjectId('');
      setReviewerId('');
    },
  });

  const canSubmit = !!subjectId && !!reviewerId && !add.isPending;

  return (
    <Card className="border-primary/20">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Assign a reviewer</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Subject</label>
            <StudioSelect
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">Select person…</option>
              {roster?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </StudioSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Reviewer</label>
            <StudioSelect
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">Select reviewer…</option>
              {roster?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </StudioSelect>
          </div>
          <Button
            onClick={() => canSubmit && add.mutate({ cycleId, subjectId, reviewerId })}
            disabled={!canSubmit}
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Assign
          </Button>
        </div>
        {add.error && <p className="text-xs text-destructive">{add.error.message}</p>}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   My reviews (everyone) — reviews to fill + feedback about me
   ============================================================ */
function MyReviewsPanel() {
  const { data, isLoading } = trpc.reviews.myReviews.useQuery();
  const [fillTarget, setFillTarget] = useState<ReviewRow | null>(null);

  const toComplete = useMemo(
    () => data?.assigned.filter((r) => r.status === 'DRAFT') ?? [],
    [data]
  );
  const submittedByMe = useMemo(
    () => data?.assigned.filter((r) => r.status === 'SUBMITTED') ?? [],
    [data]
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* To complete */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10">
              <ClipboardList className="h-3.5 w-3.5 text-amber-500" />
            </div>
            Reviews to complete
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {toComplete.length === 0 ? (
            <EmptyRow text="Nothing waiting on you." />
          ) : (
            <div className="divide-y divide-border/60">
              {toComplete.map((r) => (
                <div key={r.id} className="flex items-center gap-4 px-6 py-3.5">
                  <PersonChip name={r.subject.name} avatar={r.subject.avatar} sub={r.cycle.name} />
                  <Button size="sm" className="ml-auto" onClick={() => setFillTarget(r)}>
                    Fill review
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Submitted by me */}
      {submittedByMe.length > 0 && (
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              </div>
              Submitted by you
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/60">
              {submittedByMe.map((r) => (
                <ReviewFeedbackRow key={r.id} review={r} who={r.subject} relation="of" />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* About me */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
              <Star className="h-3.5 w-3.5 text-blue-500" />
            </div>
            Feedback about you
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!data || data.aboutMe.length === 0 ? (
            <EmptyRow text="No submitted feedback yet." />
          ) : (
            <div className="divide-y divide-border/60">
              {data.aboutMe.map((r) => (
                <ReviewFeedbackRow key={r.id} review={r} who={r.reviewer} relation="by" />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <FillReviewDialog
        key={fillTarget?.id ?? 'closed'}
        target={fillTarget}
        onClose={() => setFillTarget(null)}
      />
    </div>
  );
}

function ReviewFeedbackRow({
  review,
  who,
  relation,
}: {
  review: ReviewRow;
  who: ReviewRow['subject'];
  relation: 'by' | 'of';
}) {
  return (
    <div className="px-6 py-4 space-y-2">
      <div className="flex items-center gap-3">
        <PersonChip
          name={who.name}
          avatar={who.avatar}
          sub={`${relation === 'by' ? 'by' : 'of'} · ${review.cycle.name}`}
        />
        <div className="ml-auto">{review.rating != null && <Stars value={review.rating} />}</div>
      </div>
      {(review.strengths || review.improvements || review.comments) && (
        <div className="space-y-2 pl-12 text-sm text-foreground/90">
          {review.strengths && <FeedbackBlock label="Strengths" body={review.strengths} />}
          {review.improvements && (
            <FeedbackBlock label="Areas to improve" body={review.improvements} />
          )}
          {review.comments && <FeedbackBlock label="Comments" body={review.comments} />}
        </div>
      )}
    </div>
  );
}

function FeedbackBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap leading-relaxed">{body}</p>
    </div>
  );
}

function FillReviewDialog({ target, onClose }: { target: ReviewRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [rating, setRating] = useState(() => target?.rating ?? 0);
  const [strengths, setStrengths] = useState(() => target?.strengths ?? '');
  const [improvements, setImprovements] = useState(() => target?.improvements ?? '');
  const [comments, setComments] = useState(() => target?.comments ?? '');

  const submit = trpc.reviews.submitReview.useMutation({
    onSuccess: () => {
      utils.reviews.myReviews.invalidate();
      utils.reviews.listReviews.invalidate();
      onClose();
    },
  });

  const canSubmit = rating >= 1 && rating <= 5 && !submit.isPending;

  return (
    <Dialog
      open={!!target}
      onOpenChange={(v) => {
        if (submit.isPending) return;
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review {target?.subject.name}</DialogTitle>
          <DialogDescription>{target?.cycle.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Overall rating <span className="text-destructive">*</span>
            </label>
            <StarPicker value={rating} onChange={setRating} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Strengths</label>
            <Textarea
              rows={3}
              value={strengths}
              onChange={(e) => setStrengths(e.target.value)}
              placeholder="What did this person do well?"
              disabled={submit.isPending}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Areas to improve
            </label>
            <Textarea
              rows={3}
              value={improvements}
              onChange={(e) => setImprovements(e.target.value)}
              placeholder="Where could they grow?"
              disabled={submit.isPending}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Additional comments
            </label>
            <Textarea
              rows={2}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Anything else…"
              disabled={submit.isPending}
            />
          </div>
          {submit.error && <p className="text-xs text-destructive">{submit.error.message}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              if (!target || !canSubmit) return;
              submit.mutate({
                id: target.id,
                rating,
                strengths: strengths.trim() || undefined,
                improvements: improvements.trim() || undefined,
                comments: comments.trim() || undefined,
              });
            }}
            disabled={!canSubmit}
          >
            {submit.isPending && <Loader2 className="animate-spin" />}
            {submit.isPending ? 'Submitting...' : 'Submit review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================
   Small presentational helpers
   ============================================================ */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    OPEN: 'bg-emerald-500/10 text-emerald-500',
    CLOSED: 'bg-muted text-muted-foreground',
    DRAFT: 'bg-amber-500/10 text-amber-500',
    SUBMITTED: 'bg-blue-500/10 text-blue-500',
  };
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
        map[status] ?? 'bg-secondary text-muted-foreground'
      )}
    >
      {label}
    </span>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`${value} / 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            'h-3.5 w-3.5',
            i < value ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'
          )}
        />
      ))}
    </div>
  );
}

function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: 5 }).map((_, i) => {
        const n = i + 1;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className="transition-transform hover:scale-110"
            aria-label={`Rate ${n} of 5`}
          >
            <Star
              className={cn(
                'h-7 w-7',
                n <= value ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function PersonChip({ name, avatar, sub }: { name: string; avatar: string | null; sub?: string }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarImage src={avatar ?? undefined} />
        <AvatarFallback className="bg-secondary text-foreground font-medium text-xs">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        {sub && <p className="text-xs text-muted-foreground truncate">{sub}</p>}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="py-10 text-center">
      <Inbox className="mx-auto h-8 w-8 text-muted-foreground/20" />
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
