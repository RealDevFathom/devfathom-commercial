'use client';

import type { ComponentProps, ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, Lock, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DialogClose, DialogTitle } from '@/components/ui/dialog';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/utils';

/**
 * DEV-977 phase 2B (Counter v2): the one frame every panel over the counter uses, so payment,
 * receipt, discount, controlled medicine, returns and no-permission sheets share the design's
 * geometry. Studio tokens only: card surface, subtle border, 24px panel radius, mono eyebrow.
 *
 * - `dialog`: a centred 560px dialog from 1024px; a bottom sheet below.
 * - `wide`: a centred dialog up to 1000px from 1024px; the full screen below (payment).
 * - `side`: a side sheet from 768px (460px, 480px from 1024px); a bottom sheet below.
 */
export type CounterSheetVariant = 'dialog' | 'wide' | 'side';

const SHEET_BASE =
  'pharmacy-workspace pos-calm fixed z-50 flex flex-col overflow-hidden bg-surface-card text-text-strong shadow-lg outline-none';

const SHEET_VARIANT: Record<CounterSheetVariant, string> = {
  // Below 1024px a bottom sheet rounded at the top; from 1024px a centred dialog.
  dialog:
    'inset-x-0 bottom-0 max-h-[calc(100dvh-2rem)] rounded-t-xl border-t border-border-subtle lg:inset-x-auto lg:top-1/2 lg:bottom-auto lg:left-1/2 lg:max-h-[calc(100dvh-4rem)] lg:w-[min(35rem,calc(100vw-4rem))] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-xl lg:border',
  // The full screen below 1024px, so the phone's cash entry and change are never covered.
  wide: 'inset-0 lg:inset-auto lg:top-1/2 lg:left-1/2 lg:max-h-[calc(100dvh-4rem)] lg:w-[min(62.5rem,calc(100vw-4rem))] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-xl lg:border lg:border-border-subtle',
  side: 'inset-x-0 bottom-0 max-h-[calc(100dvh-2rem)] rounded-t-xl border-t border-border-subtle md:inset-y-0 md:start-auto md:end-0 md:max-h-none md:w-[28.75rem] md:rounded-none md:border-t-0 md:border-s lg:w-[30rem]',
};

export function counterSheetClassName(variant: CounterSheetVariant, className?: string) {
  return cn(SHEET_BASE, SHEET_VARIANT[variant], className);
}

/** The design's dimmed backdrop: ink at 45%, no blur. */
export const COUNTER_SHEET_BACKDROP =
  'bg-foreground/45 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none';

/** Eyebrow, title and one-line subtitle, with the close control as a 44px icon button. */
export function CounterSheetHeader({
  eyebrow,
  title,
  subtitle,
  closeLabel = 'Close',
  showClose = true,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  closeLabel?: string;
  showClose?: boolean;
}) {
  return (
    <div
      data-counter-sheet-head=""
      className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle px-5 pt-4.5 pb-4"
    >
      <div className="min-w-0 space-y-0.5">
        {eyebrow ? <Eyebrow className="block">{eyebrow}</Eyebrow> : null}
        <DialogTitle className="text-xl leading-tight font-semibold text-text-strong">
          {title}
        </DialogTitle>
        {subtitle ? <p className="text-[13px] text-text-muted">{subtitle}</p> : null}
      </div>
      {showClose ? (
        <DialogClose
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0 shadow-none hover:translate-y-0 active:translate-y-0"
            />
          }
          aria-label={closeLabel}
        >
          <X aria-hidden="true" />
        </DialogClose>
      ) : null}
    </div>
  );
}

/** The sheet's action row: right-aligned, buttons share the width below 1024px. */
export function CounterSheetFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-counter-sheet-foot=""
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-end gap-2.5 border-t border-border-subtle px-5 py-3.5 max-lg:[&>[data-slot=button]]:flex-1',
        className
      )}
    >
      {children}
    </div>
  );
}

export type CounterNoteTone = 'neutral' | 'warning' | 'danger' | 'success';

const NOTE_SURFACE: Record<CounterNoteTone, string> = {
  neutral: 'bg-surface-sunken',
  warning: 'bg-warning/10',
  danger: 'bg-destructive/10',
  success: 'bg-success/10',
};
const NOTE_ICON_COLOUR: Record<CounterNoteTone, string> = {
  neutral: 'text-text-body',
  warning: 'text-warning',
  danger: 'text-destructive',
  success: 'text-success',
};
const NOTE_ICON = {
  neutral: Info,
  warning: TriangleAlert,
  danger: TriangleAlert,
  success: CircleCheck,
} as const;

/**
 * A tinted note with an icon, so tone is never carried by colour alone. Text stays in the
 * body and strong text tokens; only the icon takes the state colour.
 */
export function CounterNote({
  tone = 'neutral',
  children,
  className,
  ...props
}: {
  tone?: CounterNoteTone;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<'div'>, 'children' | 'className'>) {
  const Icon = NOTE_ICON[tone];
  return (
    <div
      data-counter-note={tone}
      className={cn(
        'flex items-start gap-2.5 rounded-sm px-3.5 py-3 text-[13px] text-text-body [&_b]:text-text-strong',
        NOTE_SURFACE[tone],
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className={cn('mt-px size-4 shrink-0', NOTE_ICON_COLOUR[tone])} />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

const STATE_ICON = {
  neutral: Info,
  warning: Lock,
  danger: CircleAlert,
  success: CircleCheck,
} as const;

/** The design's centred state: a 48px tinted icon tile, a short heading, the explanation. */
export function CounterStateCard({
  tone = 'warning',
  heading,
  headingId,
  children,
  actions,
  className,
  ...props
}: {
  tone?: CounterNoteTone;
  heading: ReactNode;
  headingId?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & Omit<ComponentProps<'section'>, 'children' | 'className'>) {
  const Icon = STATE_ICON[tone];
  return (
    <section
      data-counter-state={tone}
      className={cn(
        'grid justify-items-center gap-2.5 rounded-md border border-border-subtle px-5 py-6 text-center text-sm',
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-12 place-items-center rounded-sm',
          NOTE_SURFACE[tone],
          NOTE_ICON_COLOUR[tone]
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <h3 id={headingId} className="text-base font-semibold text-text-strong">
        {heading}
      </h3>
      {children ? (
        <div className="grid max-w-[44ch] justify-items-center gap-2 text-text-body">
          {children}
        </div>
      ) : null}
      {actions ? <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </section>
  );
}

/**
 * Counter v2 C6: an action the signed-in member cannot take. Says what it needs and who can
 * do it; the bill stays open. It never offers a way round the permission: the server refuses
 * the action whatever this card says.
 */
export function CounterNoPermission({
  heading,
  children,
  who,
  role,
}: {
  heading: ReactNode;
  children: ReactNode;
  who: ReactNode;
  /** The member's own role, when the screen knows it. */
  role?: ReactNode;
}) {
  return (
    <CounterStateCard tone="warning" heading={heading} data-counter-no-permission="">
      {children}
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-start text-[13px]">
        <dt className="text-text-muted">Who can</dt>
        <dd className="font-semibold text-text-strong">{who}</dd>
        {role ? (
          <>
            <dt className="text-text-muted">Your role</dt>
            <dd className="font-semibold text-text-strong">{role}</dd>
          </>
        ) : null}
      </dl>
    </CounterStateCard>
  );
}
