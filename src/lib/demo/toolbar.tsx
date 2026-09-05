'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { DEMO_SALES_SCRIPT } from './sales-script';
import {
  clearTourProgress,
  isTourStepPath,
  readTourProgress,
  saveTourProgress,
  TOUR_STEPS,
} from './tour';
import { prepareTourTarget } from './tour-preparation';

type TourStatus = 'preparing' | 'ready' | 'error';

function resetRetrySeconds(response: Response, payload: unknown) {
  const body =
    payload && typeof payload === 'object' && 'retryAfter' in payload
      ? Number(payload.retryAfter)
      : Number.NaN;
  if (Number.isFinite(body) && body > 0) return Math.ceil(body);
  const header = Number(response.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : 0;
}

function resetError(payload: unknown) {
  return payload && typeof payload === 'object' && 'error' in payload
    ? String(payload.error)
    : 'This demo seat could not be reset. Try again.';
}

function tourStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function highlightTarget(target: HTMLElement) {
  const previous = {
    active: target.getAttribute('data-demo-tour-active'),
    outline: target.style.outline,
    outlineOffset: target.style.outlineOffset,
    scrollMargin: target.style.scrollMargin,
  };
  target.setAttribute('data-demo-tour-active', 'true');
  target.style.outline = '3px solid var(--ring)';
  target.style.outlineOffset = '4px';
  target.style.scrollMargin = '7rem';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });

  return () => {
    if (previous.active == null) target.removeAttribute('data-demo-tour-active');
    else target.setAttribute('data-demo-tour-active', previous.active);
    target.style.outline = previous.outline;
    target.style.outlineOffset = previous.outlineOffset;
    target.style.scrollMargin = previous.scrollMargin;
  };
}

function activePaymentDialog(target: HTMLElement | null) {
  const containing = target?.closest<HTMLElement>('[data-slot="dialog-content"]');
  if (containing) return containing;
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]'))
      .reverse()
      .find((dialog) => {
        const style = window.getComputedStyle(dialog);
        return (
          dialog.getAttribute('aria-hidden') !== 'true' &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }) ?? null
  );
}

export function DemoToolbar({ seatName }: { seatName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const tourPanelRef = useRef<HTMLElement | null>(null);
  const restoreTourFocusRef = useRef<HTMLElement | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [resetFailure, setResetFailure] = useState('');
  const [resetCooldown, setResetCooldown] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tourStatus, setTourStatus] = useState<TourStatus>('preparing');
  const [tourError, setTourError] = useState('');
  const [tourTarget, setTourTarget] = useState<HTMLElement | null>(null);
  const [tourAttempt, setTourAttempt] = useState(0);
  const [guideCollapsed, setGuideCollapsed] = useState(false);
  const currentIndex = activeIndex ?? 0;
  const step = activeIndex == null ? null : TOUR_STEPS[currentIndex];

  function endTour() {
    const dialog = step?.id === 'bill-settlement' ? activePaymentDialog(tourTarget) : null;
    restoreTourFocusRef.current =
      dialog?.querySelector<HTMLElement>('button, [href], [tabindex="0"]') ??
      startButtonRef.current;
    clearTourProgress(tourStorage());
    setActiveIndex(null);
    setTourTarget(null);
    setTourError('');
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const progress = readTourProgress(tourStorage());
      if (progress) setActiveIndex(progress.index);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (resetCooldown <= 0) return;
    const timeout = window.setTimeout(
      () => setResetCooldown((current) => Math.max(0, current - 1)),
      1_000
    );
    return () => window.clearTimeout(timeout);
  }, [resetCooldown]);

  useEffect(() => {
    if (activeIndex == null) return;
    const step = TOUR_STEPS[activeIndex];
    if (!step) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTourStatus('preparing');
      setTourError('');
      setTourTarget(null);
    });

    if (!isTourStepPath(step, pathname)) {
      router.push(step.href);
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    let preparationCleanup = () => {};
    let highlightCleanup = () => {};
    void prepareTourTarget(step, { signal: controller.signal })
      .then((prepared) => {
        if (controller.signal.aborted) {
          prepared.cleanup();
          return;
        }
        preparationCleanup = prepared.cleanup;
        highlightCleanup = highlightTarget(prepared.target);
        setTourTarget(prepared.target);
        setTourStatus('ready');
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setTourError(
          error instanceof Error
            ? error.message
            : `Could not prepare “${step.title}”. Restore the seeded data, then retry.`
        );
        setTourStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
      highlightCleanup();
      preparationCleanup();
    };
  }, [activeIndex, pathname, router, tourAttempt]);

  useEffect(() => {
    if (activeIndex == null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      endTour();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    if (
      activeIndex != null &&
      (tourStatus === 'ready' || tourStatus === 'error') &&
      !tourPanelRef.current?.contains(document.activeElement)
    ) {
      tourPanelRef.current?.focus();
    }
  }, [activeIndex, tourStatus]);

  useEffect(() => {
    if (activeIndex != null || !restoreTourFocusRef.current) return;
    restoreTourFocusRef.current.focus();
    restoreTourFocusRef.current = null;
  }, [activeIndex]);

  function startTour() {
    restoreTourFocusRef.current = null;
    setGuideCollapsed(false);
    setTourStatus('preparing');
    setTourError('');
    setTourTarget(null);
    setActiveIndex(0);
    setTourAttempt((attempt) => attempt + 1);
    saveTourProgress(tourStorage(), 0);
  }

  function moveTour(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= TOUR_STEPS.length) {
      endTour();
      return;
    }
    saveTourProgress(tourStorage(), nextIndex);
    setTourStatus('preparing');
    setTourTarget(null);
    setTourError('');
    setActiveIndex(nextIndex);
  }

  async function resetSeat() {
    if (resetPending || resetCooldown > 0) return;
    setResetPending(true);
    setResetFailure('');
    setResetMessage('');
    try {
      const response = await fetch('/demo/restaurants/reset', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 429) {
          setResetCooldown(Math.max(1, resetRetrySeconds(response, payload)));
        }
        setResetFailure(resetError(payload));
        return;
      }
      if (!payload || typeof payload !== 'object' || !('resetAt' in payload)) {
        setResetFailure(
          'The reset completed without a valid confirmation. Refresh before using this seat.'
        );
        return;
      }

      clearTourProgress(tourStorage());
      setActiveIndex(null);
      setResetOpen(false);
      setResetMessage(`${seatName} reset. Seeded operations are ready.`);
      globalThis.location.reload();
    } catch {
      setResetFailure('This demo seat could not be reset. Check the connection and try again.');
    } finally {
      setResetPending(false);
    }
  }

  const tourPanel = step ? (
    <section
      ref={tourPanelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="demo-tour-title"
      aria-describedby="demo-tour-detail"
      tabIndex={-1}
      className={`fixed right-4 bottom-4 z-[70] rounded-lg border border-border-strong bg-card text-card-foreground shadow-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40 sm:right-6 sm:bottom-6 ${
        guideCollapsed
          ? 'w-[min(20rem,calc(100vw-2rem))] p-3'
          : 'max-h-[min(34rem,calc(100svh-2rem))] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto p-5'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-text-muted uppercase">
          Step {currentIndex + 1} of {TOUR_STEPS.length}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={!guideCollapsed}
          onClick={(event) => {
            setGuideCollapsed((collapsed) => !collapsed);
            event.currentTarget.focus();
          }}
        >
          {guideCollapsed ? 'Show guide' : 'Collapse guide'}
        </Button>
      </div>
      <h2 id="demo-tour-title" className="mt-2 font-display text-xl font-semibold text-text-strong">
        {step.title}
      </h2>

      {guideCollapsed ? (
        <div id="demo-tour-detail" className="mt-3 space-y-3">
          {tourStatus !== 'ready' ? (
            <p
              className={
                tourStatus === 'error' ? 'text-sm text-destructive' : 'text-sm text-text-muted'
              }
              role={tourStatus === 'error' ? 'alert' : 'status'}
            >
              {tourStatus === 'error' ? 'This step needs attention.' : 'Preparing live content…'}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
            <Button type="button" variant="ghost" onClick={endTour}>
              End tour
            </Button>
            {tourStatus === 'ready' ? (
              <Button type="button" onClick={() => moveTour(currentIndex + 1)}>
                {currentIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : tourStatus === 'preparing' ? (
        <p
          id="demo-tour-detail"
          className="mt-3 text-sm leading-relaxed text-text-muted"
          role="status"
        >
          Opening and checking live seeded content…
        </p>
      ) : tourStatus === 'error' ? (
        <div className="mt-3 space-y-4">
          <p
            id="demo-tour-detail"
            className="text-sm leading-relaxed text-destructive"
            role="alert"
          >
            {tourError}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                setTourStatus('preparing');
                setTourError('');
                setTourAttempt((attempt) => attempt + 1);
              }}
            >
              Retry this step
            </Button>
            <Button type="button" variant="outline" onClick={endTour}>
              End tour
            </Button>
          </div>
        </div>
      ) : (
        <div id="demo-tour-detail" className="mt-3 space-y-4">
          <ul className="space-y-2 text-sm leading-relaxed text-text-muted">
            {step.talkingPoints.map((point) => (
              <li key={point} className="flex gap-2">
                <span
                  aria-hidden
                  className="mt-[0.55rem] size-1.5 shrink-0 rounded-full bg-accent-brand"
                />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <div className="rounded-md border border-border-subtle bg-surface-sunken p-3">
            <p className="text-sm font-semibold text-text-strong">{step.likelyQuestion}</p>
            <p className="mt-1 text-sm leading-relaxed text-text-muted">{step.answer}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={currentIndex === 0}
              onClick={() => moveTour(currentIndex - 1)}
            >
              Previous
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={endTour}>
                End tour
              </Button>
              <Button type="button" onClick={() => moveTour(currentIndex + 1)}>
                {currentIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  ) : null;

  const tourHost =
    typeof document !== 'undefined' && step?.id === 'bill-settlement'
      ? (activePaymentDialog(tourTarget) ?? document.body)
      : typeof document !== 'undefined'
        ? document.body
        : null;

  return (
    <>
      <aside
        data-tour="demo-toolbar"
        aria-label="Restaurant demo controls"
        className="fixed right-3 bottom-3 z-40 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-end gap-2 rounded-md border border-border-default bg-card p-2 shadow-sm sm:right-5 sm:bottom-5"
      >
        <span className="max-w-40 truncate px-1 font-mono text-[0.6875rem] tracking-wide text-text-muted uppercase">
          {seatName}
        </span>
        <Button ref={startButtonRef} type="button" size="sm" onClick={startTour}>
          {activeIndex == null ? 'Start tour' : 'Restart tour'}
        </Button>

        <Dialog open={resetOpen} onOpenChange={setResetOpen}>
          <DialogTrigger
            render={
              <Button type="button" size="sm" variant="outline" disabled={resetCooldown > 0} />
            }
          >
            {resetCooldown > 0 ? `Reset in ${resetCooldown}s` : 'Reset my seat'}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset {seatName}?</DialogTitle>
              <DialogDescription>
                Current demo changes in this seat will be replaced with the seeded restaurant story.
                Other sales seats are untouched.
              </DialogDescription>
            </DialogHeader>
            {resetFailure ? (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {resetFailure}
              </p>
            ) : null}
            <DialogFooter showCloseButton={!resetPending}>
              <Button
                type="button"
                variant="destructive"
                disabled={resetPending}
                onClick={resetSeat}
              >
                {resetPending ? 'Resetting seat…' : 'Reset seat'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog>
          <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
            Sales script
          </DialogTrigger>
          <DialogContent className="max-h-[min(48rem,calc(100svh-2rem))] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Restaurant demo sales script</DialogTitle>
              <DialogDescription>
                Ten product-led stops. Claims stay within visible seeded operations.
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-4">
              {DEMO_SALES_SCRIPT.map((script, index) => (
                <li
                  key={script.id}
                  className="rounded-md border border-border-subtle bg-surface-sunken p-4"
                >
                  <p className="font-mono text-[0.6875rem] tracking-wide text-text-muted uppercase">
                    {index + 1}. {script.title}
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-text-muted">
                    {script.talkingPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                  <p className="mt-3 text-sm font-semibold text-text-strong">
                    Prospect: {script.likelyQuestion}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-text-muted">
                    Answer: {script.answer}
                  </p>
                </li>
              ))}
            </ol>
          </DialogContent>
        </Dialog>

        {resetMessage ? (
          <span className="max-w-56 text-xs text-success" role="status">
            {resetMessage}
          </span>
        ) : null}
      </aside>
      {tourHost && tourPanel ? createPortal(tourPanel, tourHost) : null}
    </>
  );
}
