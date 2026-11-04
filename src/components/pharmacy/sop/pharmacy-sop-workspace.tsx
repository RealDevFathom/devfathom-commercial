'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useEntitlements } from '@/components/entitlements-provider';
import { fieldClass } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';

import { JoinSitePrompt, SopBoardView } from './sop-board';
import {
  EMPTY_DRAFT,
  errorMessage,
  isDenied,
  isNoStaffProfile,
  type SopAccess,
  type SopBranch,
  type StepDraft,
} from './sop-model';
import { SopReportsView } from './sop-reports';
import { SopReviewQueue } from './sop-review';
import { SopRunner } from './sop-runner';
import { SopSetupView } from './sop-setup';
import { PharmacySopSkeleton } from './sop-skeleton';

type View = 'board' | 'review' | 'setup' | 'reports';
const VIEWS: readonly View[] = ['board', 'review', 'setup', 'reports'];
type Place = { branch: string | null; view: View | null; occurrence: string | null };
type Notice = { tone: 'success' | 'danger'; text: string };

/**
 * Tab triggers meet the 44px touch-target rule. The shared trigger fills its
 * list minus padding (37px in an h-11 list), so the list sizes to its
 * triggers here instead of the shared component changing.
 */
const TAB_LIST = 'h-auto group-data-horizontal/tabs:h-auto';
const TAB_TRIGGER = 'h-11 min-h-11 px-3';

function readPlace(params: URLSearchParams): Place {
  const view = params.get('view');
  return {
    branch: params.get('branch') || null,
    view: VIEWS.includes(view as View) ? (view as View) : null,
    occurrence: params.get('occurrence') || null,
  };
}

function placeQuery(place: Place) {
  const params = new URLSearchParams();
  if (place.branch) params.set('branch', place.branch);
  if (place.view) params.set('view', place.view);
  if (place.occurrence) params.set('occurrence', place.occurrence);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Marks a history entry the workspace pushed when it opened a procedure from its own lists. */
const OPENED_HERE = 'pharmacySopOpenedHere';

function openedHere() {
  try {
    const state: unknown = window.history.state;
    return Boolean(
      state && typeof state === 'object' && (state as Record<string, unknown>)[OPENED_HERE]
    );
  } catch {
    return false;
  }
}

/**
 * Where the person is in the workspace — branch, tab and open procedure — kept
 * in the URL so the browser Back button walks back through it. Next.js folds
 * `history.pushState` into its router (keeping the state object it is given),
 * and `popstate` brings the state back when the person goes back or forward.
 *
 * Closing a procedure in the app goes back the way it came: when the workspace
 * itself pushed the procedure's entry, "Back" is `history.back()`, so browser
 * Back afterwards does not reopen it; a procedure opened from a link replaces
 * its entry with the list instead.
 */
function usePlace() {
  const searchParams = useSearchParams();
  const [place, setPlace] = useState<Place>(() =>
    readPlace(new URLSearchParams(searchParams?.toString() ?? ''))
  );
  const current = useRef(place);

  useEffect(() => {
    const onPop = () => {
      const next = readPlace(new URLSearchParams(window.location.search));
      current.current = next;
      setPlace(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((patch: Partial<Place>, mode: 'push' | 'replace' = 'push') => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPlace(next);
    const url = `${window.location.pathname}${placeQuery(next)}`;
    if (mode === 'push') {
      window.history.pushState(patch.occurrence ? { [OPENED_HERE]: true } : null, '', url);
    } else {
      window.history.replaceState(null, '', url);
    }
  }, []);

  const close = useCallback(() => {
    if (!current.current.occurrence) return;
    if (openedHere()) {
      // Show the list now; popstate confirms the same place once the browser
      // has stepped back to the entry the procedure was opened from.
      const next = { ...current.current, occurrence: null };
      current.current = next;
      setPlace(next);
      window.history.back();
      return;
    }
    go({ occurrence: null }, 'replace');
  }, [go]);

  return [place, go, close] as const;
}

function Header({ actions, description }: { actions?: React.ReactNode; description?: string }) {
  return (
    <PageHeader
      eyebrow="Pharmacy"
      heading="Procedures"
      description={
        description ??
        'Daily checks, receiving, incidents and training for your branch — done, recorded and reviewed in one place.'
      }
      actions={actions}
    />
  );
}

function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-6">
      <Header />
      <SectionCard title={title}>
        <div className="space-y-3 text-sm text-text-body" role="status">
          {children}
        </div>
      </SectionCard>
    </div>
  );
}

export function PharmacySopWorkspace() {
  const entitlements = useEntitlements();
  const moduleOn = isModuleGranted('pharmacy-safety', entitlements.enabledModules);
  const access = trpc.pharmacySop.access.useQuery(undefined, {
    enabled: moduleOn,
    retry: false,
  });
  const allowed: SopAccess | null = access.data ?? null;
  const anyAccess = Boolean(
    allowed && (allowed.canComplete || allowed.canManage || allowed.canVerify)
  );
  const branches = trpc.pharmacySop.branches.useQuery(undefined, {
    enabled: anyAccess,
    retry: false,
  });

  if (!moduleOn || isDenied(access.error) || (allowed && !anyAccess)) {
    return (
      <Blocked title="Procedures are not available to you">
        <p>
          Your workspace or your role does not include pharmacy procedures. Ask a pharmacy
          administrator if you need them.
        </p>
      </Blocked>
    );
  }
  if (access.isLoading || (anyAccess && branches.isLoading)) return <PharmacySopSkeleton />;
  if (access.error || branches.error || !allowed) {
    const failed = access.error ? access : branches;
    return (
      <Blocked title="Procedures could not be loaded">
        <p role="alert">
          {errorMessage(failed.error, 'Nothing was changed. Retry when you are ready.')}
        </p>
        <Button type="button" variant="outline" size="touch" onClick={() => void failed.refetch()}>
          Retry
        </Button>
      </Blocked>
    );
  }
  const list: SopBranch[] = branches.data ?? [];
  if (list.length === 0) {
    return (
      <Blocked title="You are not assigned to a pharmacy branch">
        <p>
          Procedures are run per branch. Ask an administrator to assign you to a branch in Branch
          assignments, then come back.
        </p>
        <Button
          type="button"
          variant="outline"
          size="touch"
          onClick={() => void branches.refetch()}
        >
          Check again
        </Button>
      </Blocked>
    );
  }
  return <Workspace access={allowed} branches={list} />;
}

function Workspace({ access, branches }: { access: SopAccess; branches: SopBranch[] }) {
  const pickerId = useId();
  const utils = trpc.useUtils();
  const [place, go, close] = usePlace();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});
  const lastOpened = useRef<string | null>(null);

  const branch = branches.find((row) => row.pharmacyBranchId === place.branch) ?? branches[0];
  const enabled = Boolean(branch.sopBranchId);
  // One board read serves the board, the review queue and the decision about
  // whether this person reviews here at all: the capability is not enough on
  // its own, they must also hold a reviewer role at this branch.
  const board = trpc.pharmacySop.board.useQuery(
    { pharmacyBranchId: branch.pharmacyBranchId },
    // A reviewer who only verifies still needs it: it carries their queue.
    { enabled: enabled && (access.canComplete || access.canVerify), retry: false }
  );
  // No procedures profile yet: offer to set one up wherever the person is,
  // except on the board, which shows the same prompt in place of its lists.
  const needsProfile = isNoStaffProfile(board.error);
  const reviewer = access.canVerify && Boolean(board.data?.canReview);
  const views: View[] = [
    ...(access.canComplete ? (['board'] as const) : []),
    ...(reviewer && enabled ? (['review'] as const) : []),
    ...(access.canManage ? (['setup'] as const) : []),
    ...((access.canManage || access.canVerify) && enabled ? (['reports'] as const) : []),
  ];
  const view: View | undefined = place.view && views.includes(place.view) ? place.view : views[0];
  const occurrence = enabled && (view === 'board' || view === 'review') ? place.occurrence : null;

  // Coming back from a procedure returns focus to the control that opened it.
  useEffect(() => {
    if (occurrence) {
      lastOpened.current = occurrence;
      return;
    }
    if (lastOpened.current) {
      document.getElementById(`sop-open-${lastOpened.current}`)?.focus();
      lastOpened.current = null;
    }
  }, [occurrence]);

  const draftFor = useCallback((key: string) => drafts[key] ?? EMPTY_DRAFT, [drafts]);
  const setDraft = useCallback(
    (key: string, patch: Partial<StepDraft>) =>
      setDrafts((current) => ({
        ...current,
        [key]: { ...(current[key] ?? EMPTY_DRAFT), ...patch },
      })),
    []
  );
  const clearDraft = useCallback(
    (key: string) =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }),
    []
  );

  const picker = (
    <label
      className="grid w-full gap-1.5 text-sm font-medium text-text-strong sm:w-80"
      htmlFor={pickerId}
    >
      <span>Branch</span>
      <select
        id={pickerId}
        className={fieldClass}
        value={branch.pharmacyBranchId}
        onChange={(event) => {
          setNotice(null);
          go({ branch: event.target.value, occurrence: null });
        }}
      >
        {branches.map((row) => (
          <option key={row.pharmacyBranchId} value={row.pharmacyBranchId}>
            {row.name}
            {row.sopBranchId ? '' : ' · not set up'}
          </option>
        ))}
      </select>
    </label>
  );

  const notSetUp = (
    <SectionCard title="Procedures are not set up at this branch yet">
      <div className="space-y-3 text-sm text-text-body" role="status">
        <p>
          {access.canManage
            ? 'Turn on procedures here, add the pharmacy library, then create the schedules you want. Nothing runs until you do.'
            : 'Ask your pharmacy manager to turn on procedures at this branch. Your work will appear here once they do.'}
        </p>
        {access.canManage ? (
          <Button type="button" size="touch" onClick={() => go({ view: 'setup' })}>
            Set up this branch
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );

  if (!view) {
    // A reviewer at a branch that is not set up yet has nothing to open.
    return (
      <div className="min-w-0 space-y-6">
        <Header actions={picker} />
        {notSetUp}
      </div>
    );
  }

  const open = (occurrenceId: string) => {
    setNotice(null);
    go({ view, occurrence: occurrenceId });
  };
  const back = close;

  const runner = occurrence ? (
    <SopRunner
      key={occurrence}
      pharmacyBranchId={branch.pharmacyBranchId}
      timezone={branch.timezone}
      occurrenceId={occurrence}
      access={access}
      from={view === 'review' ? 'review' : 'work'}
      draftFor={draftFor}
      setDraft={setDraft}
      clearDraft={clearDraft}
      onBack={back}
      onNotice={setNotice}
    />
  ) : null;

  return (
    <div className="min-w-0 space-y-6">
      <Header actions={picker} />

      {notice ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm ${
            notice.tone === 'danger'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-success/30 bg-success/10 text-success'
          }`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
        >
          <span className="min-w-0">{notice.text}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {needsProfile && view !== 'board' ? (
        <JoinSitePrompt pharmacyBranchId={branch.pharmacyBranchId} />
      ) : null}

      <Tabs
        value={view}
        onValueChange={(value) => {
          setNotice(null);
          go({ view: value as View, occurrence: null });
        }}
      >
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="Procedure views" className={TAB_LIST}>
            {views.includes('board') ? (
              <TabsTrigger value="board" className={TAB_TRIGGER}>
                Today&apos;s work
              </TabsTrigger>
            ) : null}
            {views.includes('review') ? (
              <TabsTrigger value="review" className={TAB_TRIGGER}>
                Review
              </TabsTrigger>
            ) : null}
            {views.includes('setup') ? (
              <TabsTrigger value="setup" className={TAB_TRIGGER}>
                Setup
              </TabsTrigger>
            ) : null}
            {views.includes('reports') ? (
              <TabsTrigger value="reports" className={TAB_TRIGGER}>
                Reports
              </TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        {views.includes('board') ? (
          <TabsContent value="board" className="mt-4">
            {!enabled
              ? notSetUp
              : (runner ?? (
                  <SopBoardView
                    pharmacyBranchId={branch.pharmacyBranchId}
                    timezone={branch.timezone}
                    access={access}
                    onOpen={open}
                    onSetup={() => go({ view: 'setup' })}
                    onNotice={setNotice}
                  />
                ))}
          </TabsContent>
        ) : null}
        {views.includes('review') ? (
          <TabsContent value="review" className="mt-4">
            {runner ?? (
              <ReviewTab
                pharmacyBranchId={branch.pharmacyBranchId}
                timezone={branch.timezone}
                onOpen={open}
              />
            )}
          </TabsContent>
        ) : null}
        {views.includes('setup') ? (
          <TabsContent value="setup" className="mt-4">
            <SopSetupView
              branch={branch}
              defaultTimezone={access.organizationTimezone}
              onChanged={() => void utils.pharmacySop.branches.invalidate()}
              onNotice={setNotice}
            />
          </TabsContent>
        ) : null}
        {views.includes('reports') ? (
          <TabsContent value="reports" className="mt-4">
            <SopReportsView pharmacyBranchId={branch.pharmacyBranchId} timezone={branch.timezone} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function ReviewTab({
  pharmacyBranchId,
  timezone,
  onOpen,
}: {
  pharmacyBranchId: string;
  timezone: string | null;
  onOpen: (occurrenceId: string) => void;
}) {
  const board = trpc.pharmacySop.board.useQuery({ pharmacyBranchId }, { retry: false });
  if (board.isLoading) {
    return (
      <SectionCard title="Waiting for your review">
        <p className="text-sm text-text-muted" role="status">
          Loading…
        </p>
      </SectionCard>
    );
  }
  if (board.error || !board.data) {
    return (
      <SectionCard title="The review queue could not be loaded">
        <div className="space-y-3" role="alert">
          <p className="text-sm text-destructive">
            {errorMessage(board.error, 'Nothing was changed. Retry when you are ready.')}
          </p>
          <Button type="button" variant="outline" size="touch" onClick={() => void board.refetch()}>
            Retry
          </Button>
        </div>
      </SectionCard>
    );
  }
  return <SopReviewQueue items={board.data.review} timezone={timezone} onOpen={onOpen} />;
}
