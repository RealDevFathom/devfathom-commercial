import type { inferRouterOutputs } from '@trpc/server';
import { TRPCError } from '@trpc/server';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { RESTAURANT_NOTIFICATION_CHANNELS } from '@/lib/restaurant/notifications';
import type { AppRouter } from '@/server/routers/_app';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { restaurantNotificationsRouter } from '@/server/routers/restaurant-notifications';
import { createTRPCContext } from '@/server/trpc';

/**
 * Resolve the tenant actor first, then hand the resolved session and
 * organization to the context factory.
 *
 * `createTRPCContext()` with no argument cannot stand in for this. It forwards
 * `{ request: undefined, session: undefined }` to `resolveTenantActor`, whose
 * `'session' in options` check reads that explicitly-undefined key as "the
 * caller already resolved the session". Auth.js is then never consulted, the
 * organization is always null, and the factory throws `Workspace not found.`
 * as an unhandled Server Component error on every request and every host.
 */
async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

/** The notification action maps a throw to an error notice, so this reads there. */
const NO_ACTOR = 'Your session is no longer active. Sign in again and retry.';

const route = '/restaurant/notifications';
const category = 'sop.escalation';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type NotificationPage = RouterOutputs['restaurantNotifications']['list'];
type Notification = NotificationPage['items'][number];
type Matrix = RouterOutputs['restaurantNotifications']['getMatrix'];
type Channel = (typeof RESTAURANT_NOTIFICATION_CHANNELS)[number];
type Filter = 'all' | 'unread';
type Notice = { kind: 'success' | 'error'; text: string };

type Branch = {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
};

type LoadedViewProps = {
  state: 'ready' | 'empty';
  action: (formData: FormData) => Promise<void>;
  filter: Filter;
  cursor?: string;
  nextCursor?: string;
  notice?: Notice;
  notifications: Notification[];
  unreadCount: number;
  branches: Branch[];
  matrixBranch: Branch | null;
  canManage: boolean;
  matrices: { organization: Matrix; branch: Matrix | null } | null;
};

export type NotificationsViewProps =
  { state: 'disabled' | 'permission' | 'error'; retryHref?: string } | LoadedViewProps;

type SearchParams = Promise<{
  filter?: string | string[];
  cursor?: string | string[];
  branch?: string | string[];
  notice?: string | string[];
  kind?: string | string[];
}>;

const CHANNEL_LABEL: Record<Channel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
  WHATSAPP: 'WhatsApp',
};

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optionalField = (form: FormData, name: string) => field(form, name) || undefined;
const queryValue = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

function actionError(error: unknown) {
  return error instanceof TRPCError ? error.message : 'Notification command failed.';
}

function pageHref(filter: Filter, branch?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (filter === 'unread') params.set('filter', filter);
  if (branch) params.set('branch', branch);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

function destination(form: FormData, notice: string, kind: Notice['kind']) {
  const filter = field(form, 'filter') === 'unread' ? 'unread' : 'all';
  const params = new URLSearchParams({ notice, kind });
  if (filter === 'unread') params.set('filter', filter);
  const cursor = optionalField(form, 'cursor');
  const branch = optionalField(form, 'branch');
  if (cursor) params.set('cursor', cursor);
  if (branch) params.set('branch', branch);
  return `${route}?${params}`;
}

function parseChannel(value: string): Channel {
  const channel = RESTAURANT_NOTIFICATION_CHANNELS.find((item) => item === value);
  if (!channel) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown channel.' });
  return channel;
}

function parseEnabled(value: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown routing state.' });
}

function formatTimestamp(value: Date | string | null, timeZone: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

function capabilityLabel(channel: Channel) {
  return channel === 'IN_APP' ? 'Live delivery' : 'Stub only · not sent';
}

function deliveryLabel(channel: Channel, status: string) {
  if (channel !== 'IN_APP') return 'Stub only · not sent';
  return status === 'DELIVERED_IN_APP' ? 'Delivered in app' : status.replaceAll('_', ' ');
}

function deliveryTone(channel: Channel, status: string): StatusTone {
  if (channel !== 'IN_APP') return 'neutral';
  return status === 'DELIVERED_IN_APP' ? 'success' : 'warning';
}

function HiddenRouteState({
  filter,
  cursor,
  branch,
}: {
  filter: Filter;
  cursor?: string;
  branch?: string;
}) {
  return (
    <>
      <input type="hidden" name="filter" value={filter} />
      {cursor ? <input type="hidden" name="cursor" value={cursor} /> : null}
      {branch ? <input type="hidden" name="branch" value={branch} /> : null}
    </>
  );
}

function MatrixRows({
  matrix,
  scope,
  action,
  filter,
  cursor,
  selectedBranch,
}: {
  matrix: Matrix;
  scope: 'organization' | 'branch';
  action: LoadedViewProps['action'];
  filter: Filter;
  cursor?: string;
  selectedBranch: Branch | null;
}) {
  return (
    <ul className="divide-y divide-border-subtle">
      {matrix.channels.map(({ channel, enabled }) => (
        <li
          className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
          key={channel}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={channel} label={CHANNEL_LABEL[channel]} tone="info" />
              <StatusPill
                status={enabled ? 'ENABLED' : 'DISABLED'}
                label={enabled ? 'Routing enabled' : 'Routing disabled'}
                tone={enabled ? 'success' : 'neutral'}
              />
            </div>
            <p className="mt-2 text-sm text-text-muted">
              Delivery capability: {capabilityLabel(channel)}.
            </p>
          </div>
          <form action={action}>
            <HiddenRouteState filter={filter} cursor={cursor} branch={selectedBranch?.id} />
            <input type="hidden" name="intent" value="update-matrix" />
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="channel" value={channel} />
            <Button
              className="min-h-11 w-full sm:w-auto"
              name="enabled"
              type="submit"
              value={String(!enabled)}
              variant="secondary"
            >
              {enabled ? 'Disable routing' : 'Enable routing'}
            </Button>
          </form>
        </li>
      ))}
    </ul>
  );
}

function NotificationsView(props: NotificationsViewProps) {
  if (props.state !== 'ready' && props.state !== 'empty') {
    const copy = {
      disabled: {
        title: 'Notifications module disabled',
        body: 'Enable Restaurant Core to open the notifications center.',
      },
      permission: {
        title: 'Permission denied',
        body: 'An active restaurant staff profile is required to view in-app notifications.',
      },
      error: {
        title: 'Notifications could not load',
        body: 'No notification or routing data was changed. Retry this page.',
      },
    }[props.state];

    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="Notifications center"
          description="In-app alerts, read state, delivery records, and notification routing."
        />
        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">{copy.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">{copy.body}</p>
          {props.state === 'error' ? (
            <Link
              className={`${buttonVariants({ variant: 'secondary' })} mt-4 min-h-11`}
              href={props.retryHref ?? route}
            >
              Retry
            </Link>
          ) : null}
        </SectionCard>
      </div>
    );
  }

  const {
    action,
    branches,
    canManage,
    cursor,
    filter,
    matrices,
    matrixBranch,
    nextCursor,
    notice,
    notifications,
    unreadCount,
  } = props;
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const activeBranches = branches.filter((branch) => branch.active);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Notifications center"
        description="In-app alerts, read state, delivery records, and notification routing."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              status={unreadCount ? 'UNREAD' : 'CURRENT'}
              label={`${unreadCount} unread`}
              tone={unreadCount ? 'warning' : 'success'}
            />
            <form action={action}>
              <HiddenRouteState filter={filter} cursor={cursor} branch={matrixBranch?.id} />
              <input type="hidden" name="intent" value="mark-all-read" />
              <Button className="min-h-11" disabled={unreadCount === 0} type="submit">
                Mark all read
              </Button>
            </form>
          </div>
        }
      />

      {notice ? (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${
            notice.kind === 'error'
              ? 'border-destructive bg-destructive-background text-destructive-foreground'
              : 'border-success bg-success-background text-success-foreground'
          }`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      ) : null}

      <SectionCard eyebrow="Channel boundary">
        <h2 className="font-display text-lg leading-snug font-semibold tracking-tight text-text-strong">
          Delivery capability
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-text-body">
          In-app is the only live channel. Email, SMS, push, and WhatsApp are stub only and not
          sent. Routing controls decide whether a delivery record is created; they do not activate
          an external provider.
        </p>
      </SectionCard>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <SectionCard
          className="min-w-0"
          eyebrow="Personal inbox"
          actions={
            <span className="font-mono text-xs tabular-nums text-text-muted">
              {notifications.length} shown
            </span>
          }
        >
          <h2 className="font-display text-lg leading-snug font-semibold tracking-tight text-text-strong">
            {filter === 'unread' ? 'Unread notifications' : 'All notifications'}
          </h2>
          <nav aria-label="Notification filters" className="mt-4 mb-5 flex flex-wrap gap-2">
            {(['all', 'unread'] as const).map((value) => (
              <Link
                aria-current={filter === value ? 'page' : undefined}
                className={buttonVariants({
                  variant: filter === value ? 'default' : 'secondary',
                })}
                href={pageHref(value, matrixBranch?.id)}
                key={value}
              >
                {value === 'all' ? 'All' : `Unread (${unreadCount})`}
              </Link>
            ))}
          </nav>

          {notifications.length ? (
            <ol className="space-y-3">
              {notifications.map((notification) => {
                const branch = notification.branchId
                  ? branchById.get(notification.branchId)
                  : undefined;
                const timeZone = branch?.timezone ?? 'UTC';
                const timeZoneLabel = branch
                  ? `${branch.name} · ${branch.timezone}`
                  : 'Organization · UTC';

                return (
                  <li key={notification.id}>
                    <article
                      className={`min-w-0 rounded-[var(--radius-md)] border p-4 sm:p-5 ${
                        notification.isRead
                          ? 'border-border-subtle bg-card'
                          : 'border-border-strong bg-surface-sunken'
                      }`}
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill
                              status={notification.isRead ? 'READ' : 'UNREAD'}
                              label={notification.isRead ? 'Read' : 'Unread'}
                              tone={notification.isRead ? 'neutral' : 'warning'}
                            />
                            <span className="font-mono text-xs break-all text-text-muted">
                              {notification.category}
                            </span>
                          </div>
                          <h3 className="mt-3 text-lg font-semibold break-words text-text-strong">
                            {notification.title}
                          </h3>
                          <p className="mt-2 text-sm leading-relaxed break-words text-text-body">
                            {notification.body}
                          </p>
                          <p className="mt-3 font-mono text-xs leading-relaxed text-text-muted">
                            Created {formatTimestamp(notification.createdAt, timeZone)} ·{' '}
                            {timeZoneLabel}
                          </p>
                          {notification.readAt ? (
                            <p className="mt-1 font-mono text-xs text-text-faint">
                              Read {formatTimestamp(notification.readAt, timeZone)} · {timeZone}
                            </p>
                          ) : null}
                          {notification.entityType || notification.entityId ? (
                            <p className="mt-2 font-mono text-xs break-all text-text-faint">
                              Related: {notification.entityType ?? 'entity'} ·{' '}
                              {notification.entityId ?? '—'}
                            </p>
                          ) : null}
                        </div>
                        <form action={action} className="shrink-0">
                          <HiddenRouteState
                            filter={filter}
                            cursor={cursor}
                            branch={matrixBranch?.id}
                          />
                          <input type="hidden" name="intent" value="mark-read" />
                          <input type="hidden" name="notificationId" value={notification.id} />
                          <Button
                            className="min-h-11 w-full sm:w-auto"
                            disabled={notification.isRead}
                            type="submit"
                            variant="secondary"
                          >
                            {notification.isRead ? 'Already read' : 'Mark read'}
                          </Button>
                        </form>
                      </div>

                      <details className="mt-4 border-t border-border-subtle pt-4">
                        <summary className="min-h-11 cursor-pointer rounded-[var(--radius-xs)] py-3 font-medium text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                          Delivery records ({notification.deliveries.length})
                        </summary>
                        <ul className="mt-3 space-y-3">
                          {notification.deliveries.map((delivery, index) => (
                            <li
                              className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4"
                              key={`${delivery.channel}-${delivery.createdAt.toISOString()}-${index}`}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <StatusPill
                                  status={delivery.channel}
                                  label={`${CHANNEL_LABEL[delivery.channel]} · ${capabilityLabel(delivery.channel)}`}
                                  tone={delivery.channel === 'IN_APP' ? 'info' : 'neutral'}
                                />
                                <StatusPill
                                  status={delivery.status}
                                  label={deliveryLabel(delivery.channel, delivery.status)}
                                  tone={deliveryTone(delivery.channel, delivery.status)}
                                />
                              </div>
                              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                                <div>
                                  <dt className="font-mono text-xs uppercase tracking-wide text-text-muted">
                                    Attempt
                                  </dt>
                                  <dd className="mt-1 tabular-nums text-text-strong">
                                    {delivery.attempt}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="font-mono text-xs uppercase tracking-wide text-text-muted">
                                    Timestamp · {timeZone}
                                  </dt>
                                  <dd className="mt-1 text-text-strong">
                                    {formatTimestamp(delivery.createdAt, timeZone)}
                                  </dd>
                                </div>
                                <div className="min-w-0">
                                  <dt className="font-mono text-xs uppercase tracking-wide text-text-muted">
                                    Error
                                  </dt>
                                  <dd className="mt-1 break-words text-text-strong">
                                    {delivery.error ??
                                      (delivery.channel === 'IN_APP'
                                        ? 'None'
                                        : 'No provider request was made.')}
                                  </dd>
                                </div>
                              </dl>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="rounded-[var(--radius-sm)] border border-dashed border-border-default px-5 py-10 text-center">
              <p className="font-medium text-text-strong">
                {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-text-muted">
                {filter === 'unread'
                  ? 'Everything in this in-app inbox is read.'
                  : 'In-app notifications will appear after an enabled event is processed.'}
              </p>
              {filter === 'unread' ? (
                <Link
                  className={`${buttonVariants({ variant: 'secondary' })} mt-4 min-h-11`}
                  href={pageHref('all', matrixBranch?.id)}
                >
                  View all
                </Link>
              ) : null}
            </div>
          )}

          {nextCursor || cursor ? (
            <nav
              aria-label="Notification pages"
              className="mt-5 flex flex-wrap justify-between gap-2 border-t border-border-subtle pt-4"
            >
              <Link
                className={buttonVariants({ variant: 'secondary' })}
                href={pageHref(filter, matrixBranch?.id)}
              >
                Newest
              </Link>
              {nextCursor ? (
                <Link
                  className={buttonVariants({ variant: 'secondary' })}
                  href={pageHref(filter, matrixBranch?.id, nextCursor)}
                >
                  Older
                </Link>
              ) : null}
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard className="min-w-0" eyebrow="Administration">
          <h2 className="font-display text-lg leading-snug font-semibold tracking-tight text-text-strong">
            Channel matrix
          </h2>
          <div className="mt-4">
            {!canManage || !matrices ? (
              <div className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4">
                <h3 className="font-semibold text-text-strong">Permission denied</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-muted">
                  The staff:manage permission is required to view or change organization and branch
                  routing.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <section>
                  <h3 className="font-semibold text-text-strong">Organization routing</h3>
                  <p className="mt-1 text-sm text-text-muted">
                    Category: <span className="font-mono">{category}</span>
                  </p>
                  <div className="mt-4">
                    <MatrixRows
                      action={action}
                      filter={filter}
                      cursor={cursor}
                      matrix={matrices.organization}
                      scope="organization"
                      selectedBranch={matrixBranch}
                    />
                  </div>
                </section>

                <section className="border-t border-border-subtle pt-6">
                  <h3 className="font-semibold text-text-strong">Branch override</h3>
                  <p className="mt-1 text-sm leading-relaxed text-text-muted">
                    Effective routing is shown below. Changing a row creates or updates that
                    branch&apos;s override.
                  </p>
                  <form className="mt-4 flex flex-col gap-2 sm:flex-row" method="get">
                    {filter === 'unread' ? (
                      <input type="hidden" name="filter" value="unread" />
                    ) : null}
                    <label className="min-w-0 flex-1 text-sm text-text-body">
                      Branch
                      <select
                        className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        defaultValue={matrixBranch?.id ?? ''}
                        disabled={!activeBranches.length}
                        name="branch"
                      >
                        {!activeBranches.length ? (
                          <option value="">No active branches</option>
                        ) : null}
                        {activeBranches.map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.name} · {branch.timezone}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      className="min-h-11 self-end"
                      disabled={!activeBranches.length}
                      type="submit"
                      variant="secondary"
                    >
                      Load branch
                    </Button>
                  </form>
                  {matrixBranch && matrices.branch ? (
                    <div className="mt-5">
                      <p className="mb-4 font-mono text-xs text-text-muted">
                        {matrixBranch.name} · {matrixBranch.timezone}
                      </p>
                      <MatrixRows
                        action={action}
                        filter={filter}
                        cursor={cursor}
                        matrix={matrices.branch}
                        scope="branch"
                        selectedBranch={matrixBranch}
                      />
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-text-muted">
                      No active branch is available for override routing.
                    </p>
                  )}
                </section>
              </div>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

export default async function RestaurantNotificationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const filter: Filter = queryValue(query.filter) === 'unread' ? 'unread' : 'all';
  const cursor = queryValue(query.cursor);
  const requestedBranchId = queryValue(query.branch);
  const retryHref = pageHref(filter, requestedBranchId, cursor);
  const ctx = await tenantContext();
  // Tenancy did not resolve. Entitlements are unknowable here, so show the
  // permission surface rather than let a missing workspace reach the user as an
  // unhandled Server Component crash.
  if (!ctx) return <NotificationsView state="permission" />;

  if (!hasModule(ctx.entitlements, 'restaurant-core')) {
    return <NotificationsView state="disabled" />;
  }
  if (!ctx.session?.user) return <NotificationsView state="permission" />;

  async function runAction(form: FormData) {
    'use server';

    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
      const caller = restaurantNotificationsRouter.createCaller(actionCtx);
      const intent = field(form, 'intent');
      let success: string;

      switch (intent) {
        case 'mark-read':
          await caller.markRead({ id: field(form, 'notificationId') });
          success = 'Notification marked read.';
          break;
        case 'mark-all-read': {
          const result = await caller.markAllRead({});
          success = result.count
            ? `${result.count} notification${result.count === 1 ? '' : 's'} marked read.`
            : 'No unread notifications remained.';
          break;
        }
        case 'update-matrix': {
          const scope = field(form, 'scope');
          if (scope !== 'organization' && scope !== 'branch') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown matrix scope.' });
          }
          const channel = parseChannel(field(form, 'channel'));
          const enabled = parseEnabled(field(form, 'enabled'));
          const branchId = scope === 'branch' ? field(form, 'branch') : null;
          await caller.updateMatrix({ category, branchId, channel, enabled });
          success = `${CHANNEL_LABEL[channel]} routing ${enabled ? 'enabled' : 'disabled'} for ${
            scope === 'branch' ? 'this branch' : 'the organization'
          }.${channel === 'IN_APP' ? '' : ' Delivery remains stub only and not sent.'}`;
          break;
        }
        default:
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown notification command.' });
      }

      revalidatePath(route);
      next = destination(form, success, 'success');
    } catch (error) {
      next = destination(form, actionError(error), 'error');
    }
    redirect(next);
  }

  let viewProps: LoadedViewProps;
  try {
    const caller = restaurantNotificationsRouter.createCaller(ctx);
    const subject = subjectFromSession(ctx.session.user);
    const [page, unread, canManage] = await Promise.all([
      caller.list({ cursor, limit: 50, unreadOnly: filter === 'unread' }),
      caller.unreadCount({}),
      can(subject, 'staff:manage', undefined, { db: ctx.db, source: 'TRPC' }),
    ]);
    const notificationBranchIds = Array.from(
      new Set(page.items.flatMap((item) => (item.branchId ? [item.branchId] : [])))
    );
    const branches = await ctx.db.restaurantBranch.findMany({
      where: canManage
        ? { OR: [{ active: true }, { id: { in: notificationBranchIds } }] }
        : { id: { in: notificationBranchIds } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, timezone: true, active: true },
    });
    const activeBranches = branches.filter((branch) => branch.active);
    const matrixBranch = canManage
      ? (activeBranches.find((branch) => branch.id === requestedBranchId) ??
        activeBranches[0] ??
        null)
      : null;
    const matrices = canManage
      ? {
          organization: await caller.getMatrix({ category, branchId: null }),
          branch: matrixBranch
            ? await caller.getMatrix({ category, branchId: matrixBranch.id })
            : null,
        }
      : null;
    const noticeText = queryValue(query.notice);
    const notice = noticeText
      ? {
          kind: queryValue(query.kind) === 'error' ? ('error' as const) : ('success' as const),
          text: noticeText.slice(0, 500),
        }
      : undefined;

    viewProps = {
      action: runAction,
      branches,
      canManage,
      cursor,
      filter,
      matrices,
      matrixBranch,
      nextCursor: page.nextCursor,
      notice,
      notifications: page.items,
      state: page.items.length ? 'ready' : 'empty',
      unreadCount: unread.count,
    };
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      return <NotificationsView state="permission" />;
    }
    return <NotificationsView retryHref={retryHref} state="error" />;
  }
  return <NotificationsView {...viewProps} />;
}
