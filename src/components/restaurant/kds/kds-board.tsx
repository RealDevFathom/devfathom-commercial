'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';

import { DeliveryBoard } from './delivery-board';

type TicketDisplayStatus = 'NEW' | 'COOKING' | 'READY' | 'RECALLED';
type ItemDisplayStatus = 'HELD' | TicketDisplayStatus | 'SERVED' | 'VOIDED';
type Runtime = {
  sessionToken: string;
  operatorStaffProfileId: string;
  deviceName: string;
  branchName: string;
};
type OperatorOption = { staffProfileId: string; displayName: string; role: string };
type QueueItem = {
  orderItemId: string;
  name: string;
  modifierNames: string[];
  course: number;
  seatNumber: number | null;
  quantity: number;
  itemStatus: string;
  displayStatus: ItemDisplayStatus;
};
type QueueTicket = {
  ticketId: string;
  ticketNumber: number;
  orderId: string;
  orderNumber: number;
  createdAt: string;
  displayStatus: TicketDisplayStatus;
  items: QueueItem[];
};
type QueuePayload = {
  stationId: string;
  stationName: string | null;
  businessDate: string;
  tickets: QueueTicket[];
  cursor: number;
  gap: boolean;
  hasMore: boolean;
  displayMapping: Record<string, string>;
};
type NoticeState = { tone: StatusTone; message: string };

const LANES = ['NEW', 'COOKING', 'READY', 'RECALLED'] as const;
const DISPLAY_TONES: Record<ItemDisplayStatus, StatusTone> = {
  HELD: 'neutral',
  NEW: 'info',
  COOKING: 'warning',
  READY: 'success',
  RECALLED: 'danger',
  SERVED: 'success',
  VOIDED: 'danger',
};
const ACTIONS: Partial<
  Record<ItemDisplayStatus, { path: 'ack' | 'bump' | 'recall'; label: string; success: string }>
> = {
  NEW: { path: 'ack', label: 'Start', success: 'Item started.' },
  COOKING: { path: 'bump', label: 'Mark ready', success: 'Item marked ready.' },
  READY: { path: 'recall', label: 'Recall', success: 'Item recalled.' },
  RECALLED: { path: 'bump', label: 'Mark ready', success: 'Recalled item marked ready.' },
};
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const POLL_DELAYS = [5_000, 10_000, 20_000, 30_000] as const;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function messageFrom(body: unknown) {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
  ) {
    return body.error.slice(0, 240);
  }
  return 'Request failed without a safe server message.';
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(response.status, messageFrom(body));
  return body as T;
}

function queuePath(cursor?: number) {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set('sinceCursor', String(cursor));
  query.set('limit', '50');
  return `/api/restaurant/kds/queue?${query}`;
}

function formatAge(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function KdsBoard({ demo = false }: { demo?: boolean }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [operatorStaffProfileId, setOperatorStaffProfileId] = useState('');
  const [operatorPin, setOperatorPin] = useState('');
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [operatorsState, setOperatorsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const cursor = useRef<number | null>(null);
  const epoch = useRef(0);
  const establishing = useRef(false);
  const queueFlight = useRef<Promise<boolean> | null>(null);
  const pendingMutation = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  const disconnect = useCallback((message?: string) => {
    epoch.current += 1;
    cursor.current = null;
    pendingMutation.current = false;
    idempotencyKeys.current.clear();
    setRuntime(null);
    setQueue(null);
    setLoading(false);
    setQueueError(null);
    setLastSync(null);
    setPending(null);
    setNotice(message ? { tone: 'danger', message } : null);
  }, []);

  const deliveryAuthorizationFailure = useCallback(() => {
    disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
  }, [disconnect]);

  const loadQueue = useCallback(
    async (activeRuntime: Runtime, sinceCursor?: number) => {
      if (queueFlight.current) return queueFlight.current;
      const requestEpoch = epoch.current;
      const flight = (async () => {
        try {
          const headers = { 'X-Terminal-Session': activeRuntime.sessionToken };
          let next = await request<QueuePayload>(queuePath(sinceCursor), { headers });
          if (sinceCursor !== undefined && (next.gap || next.cursor < sinceCursor)) {
            next = await request<QueuePayload>(queuePath(), { headers });
          }
          if (requestEpoch !== epoch.current) return false;
          cursor.current = next.cursor;
          setQueue(next);
          setQueueError(null);
          setLastSync(new Date());
          return true;
        } catch (error) {
          if (requestEpoch !== epoch.current) return false;
          if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
            disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
            return false;
          }
          setQueueError(
            error instanceof RequestError
              ? error.message
              : 'Queue refresh failed. Retrying automatically.'
          );
          return false;
        } finally {
          if (requestEpoch === epoch.current) setLoading(false);
        }
      })();
      queueFlight.current = flight;
      try {
        return await flight;
      } finally {
        if (queueFlight.current === flight) queueFlight.current = null;
      }
    },
    [disconnect]
  );

  useEffect(() => {
    if (!runtime?.operatorStaffProfileId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      const succeeded = await loadQueue(runtime, cursor.current ?? undefined);
      failures = succeeded ? 0 : Math.min(failures + 1, POLL_DELAYS.length - 1);
      schedule(POLL_DELAYS[failures]);
    };
    const refreshNow = () => {
      failures = 0;
      schedule(0);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshNow();
    };
    window.addEventListener('online', refreshNow);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', refreshNow);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadQueue, runtime]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operatorId = operatorStaffProfileId.trim();
    if (!runtime || !operatorId || !/^\d{4,8}$/.test(operatorPin)) return;
    setPending('unlock');
    try {
      await request('/api/restaurant/terminal/unlock', {
        method: 'POST',
        headers: { 'X-Terminal-Session': runtime.sessionToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffProfileId: operatorId, type: 'PIN', secret: operatorPin }),
      });
    } catch (error) {
      setOperatorPin('');
      setPending(null);
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : 'Operator unlock failed.',
      });
      return;
    }
    epoch.current += 1;
    cursor.current = null;
    setQueue(null);
    setQueueError(null);
    setLastSync(null);
    setNotice(null);
    setLoading(true);
    setRuntime({ ...runtime, operatorStaffProfileId: operatorId });
    setOperatorStaffProfileId('');
    setOperatorPin('');
    setPending(null);
  }

  const establish = useCallback(async () => {
    if (establishing.current) return;
    establishing.current = true;
    setOperatorsState('loading');
    try {
      const established = await request<{
        sessionToken: string;
        session: { state: 'LOCKED' | 'UNLOCKED'; activeStaffProfileId?: string | null };
        device: { name: string; branchName: string; kind: string };
        operator?: OperatorOption;
      }>(demo ? '/demo/restaurants/device-session' : '/api/restaurant/terminal/establish', {
        method: 'POST',
        ...(demo
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'KDS' }),
            }
          : {}),
      });
      if (established.device.kind !== 'KDS')
        throw new RequestError(403, 'This browser is not enrolled as a KDS.');
      const lockedRuntime: Runtime = {
        sessionToken: established.sessionToken,
        operatorStaffProfileId:
          established.operator?.staffProfileId ?? established.session.activeStaffProfileId ?? '',
        deviceName: established.device.name,
        branchName: established.device.branchName,
      };
      setRuntime(lockedRuntime);
      if (established.operator) {
        setOperators([established.operator]);
        setOperatorsState('ready');
        return;
      }
      const data = await request<{ operators: OperatorOption[] }>(
        '/api/restaurant/terminal/operators',
        {
          headers: { 'X-Terminal-Session': established.sessionToken },
        }
      );
      setOperators(data.operators);
      setOperatorsState('ready');
    } catch {
      setOperators([]);
      setOperatorsState('error');
    } finally {
      establishing.current = false;
    }
  }, [demo]);

  useEffect(() => {
    queueMicrotask(() => void establish());
  }, [establish]);

  function keyFor(intent: string) {
    const existing = idempotencyKeys.current.get(intent);
    if (existing) return existing;
    const key = browserUuid();
    idempotencyKeys.current.set(intent, key);
    return key;
  }

  async function mutate(item: QueueItem) {
    if (!runtime || pendingMutation.current) return;
    const action = ACTIONS[item.displayStatus];
    if (!action) return;
    const intent = `${action.path}:${item.orderItemId}`;
    pendingMutation.current = true;
    setPending(intent);
    setNotice(null);
    try {
      await request(`/api/restaurant/kds/${action.path}`, {
        method: 'POST',
        headers: {
          'X-Terminal-Session': runtime.sessionToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': keyFor(intent),
        },
        body: JSON.stringify({
          orderItemId: item.orderItemId,
          operatorStaffProfileId: runtime.operatorStaffProfileId,
        }),
      });
      idempotencyKeys.current.delete(intent);
      setNotice({ tone: 'success', message: action.success });
      await loadQueue(runtime);
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) {
        idempotencyKeys.current.delete(intent);
      }
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
      } else {
        setNotice({
          tone: error instanceof RequestError ? 'danger' : 'warning',
          message:
            error instanceof RequestError
              ? error.message
              : 'Network request failed. Retry this action.',
        });
      }
    } finally {
      pendingMutation.current = false;
      setPending(null);
    }
  }

  async function reprint(ticket: QueueTicket) {
    if (!runtime || pendingMutation.current) return;
    const intent = `reprint:${ticket.ticketId}`;
    pendingMutation.current = true;
    setPending(intent);
    setNotice(null);
    try {
      await request('/api/restaurant/orders/reprint-kot', {
        method: 'POST',
        headers: {
          'X-Terminal-Session': runtime.sessionToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': keyFor(intent),
        },
        body: JSON.stringify({ orderId: ticket.orderId, ticketId: ticket.ticketId }),
      });
      idempotencyKeys.current.delete(intent);
      setNotice({ tone: 'success', message: `KOT ${ticket.ticketNumber} reprint queued.` });
    } catch (error) {
      if (error instanceof RequestError && error.status < 500)
        idempotencyKeys.current.delete(intent);
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
      } else {
        setNotice({
          tone: error instanceof RequestError ? 'danger' : 'warning',
          message: error instanceof Error ? error.message : 'KOT reprint failed. Try again.',
        });
      }
    } finally {
      pendingMutation.current = false;
      setPending(null);
    }
  }

  const busy = loading || pending !== null;
  const shellStatus = !runtime
    ? 'disconnected'
    : loading
      ? 'loading'
      : queueError
        ? 'error'
        : 'active';
  const shellTone: StatusTone = !runtime
    ? 'neutral'
    : loading || queueError
      ? 'warning'
      : 'success';

  if (!runtime || !runtime.operatorStaffProfileId) {
    return (
      <KdsShell status={shellStatus} tone={shellTone} busy={busy}>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant KDS"
            heading={runtime ? 'Unlock kitchen display' : 'Checking enrollment'}
            description={
              runtime
                ? `${runtime.deviceName} · ${runtime.branchName}`
                : 'Verifying this browser with the server.'
            }
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard title={runtime ? 'Operator unlock' : 'Browser enrollment'} titleLevel={2}>
            <form onSubmit={connect} className="space-y-4">
              {!runtime && operatorsState === 'error' ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm text-destructive">
                    This browser is not enrolled, the enrollment expired, or the device was revoked.
                  </p>
                  <a
                    href="/login?callbackUrl=%2Frestaurant%2Fdevices"
                    className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
                  >
                    Return to admin-assisted enrollment
                  </a>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="kds-operator-id">Acting operator</Label>
                <select
                  id="kds-operator-id"
                  required
                  value={operatorStaffProfileId}
                  onChange={(event) => setOperatorStaffProfileId(event.target.value)}
                  disabled={operatorsState !== 'ready' || operators.length === 0}
                  className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="" disabled>
                    {operatorsState === 'idle'
                      ? 'Loading eligible operators…'
                      : operatorsState === 'loading'
                        ? 'Loading eligible operators…'
                        : operatorsState === 'error'
                          ? 'Operators unavailable — verify the device secret'
                          : operators.length === 0
                            ? 'No active operators for this branch'
                            : 'Select an operator'}
                  </option>
                  {operators.map((operator) => (
                    <option key={operator.staffProfileId} value={operator.staffProfileId}>
                      {operator.displayName} — {operator.role}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kds-operator-pin">Operator PIN</Label>
                <Input
                  id="kds-operator-pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{4,8}"
                  minLength={4}
                  maxLength={8}
                  value={operatorPin}
                  onChange={(event) =>
                    setOperatorPin(event.target.value.replace(/\D/g, '').slice(0, 8))
                  }
                  className="h-11"
                  disabled={!runtime}
                />
              </div>
              <Button
                type="submit"
                disabled={
                  !runtime ||
                  !operatorStaffProfileId.trim() ||
                  !/^\d{4,8}$/.test(operatorPin) ||
                  pending !== null
                }
                className="h-11 w-full"
              >
                Verify PIN and unlock
              </Button>
            </form>
          </SectionCard>
        </div>
      </KdsShell>
    );
  }

  return (
    <KdsShell status={shellStatus} tone={shellTone} busy={busy}>
      <div className="min-w-0 space-y-4">
        <PageHeader
          eyebrow="Restaurant KDS"
          heading="Kitchen floor"
          description={
            queue
              ? `${runtime.deviceName} · ${runtime.branchName} · ${queue.stationName?.trim() || 'Kitchen station'} · business date ${queue.businessDate}`
              : `${runtime.deviceName} · ${runtime.branchName} · loading the station queue.`
          }
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill
                status="active"
                label={
                  operators.find(
                    (operator) => operator.staffProfileId === runtime.operatorStaffProfileId
                  )?.displayName ?? 'Operator active'
                }
              />
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={busy}
                onClick={() => disconnect()}
              >
                Disconnect
              </Button>
            </div>
          }
        />

        {queueError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3"
          >
            <p className="text-sm text-text-body">{queueError}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => void loadQueue(runtime, cursor.current ?? undefined)}
            >
              Retry now
            </Button>
          </div>
        ) : null}
        {lastSync ? (
          <div
            role="status"
            className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${
              queueError
                ? 'border-warning/30 bg-warning/10 text-text-body'
                : 'border-border-subtle bg-surface-sunken text-text-muted'
            }`}
          >
            <StatusPill
              status={queueError ? 'degraded' : 'synced'}
              tone={queueError ? 'warning' : 'success'}
            />
            <span>
              Last synced{' '}
              <time dateTime={lastSync.toISOString()}>{TIME_FORMATTER.format(lastSync)}</time>
              {queueError
                ? ' · Showing the last confirmed station state while recovery continues.'
                : ''}
            </span>
          </div>
        ) : null}
        {notice ? <Notice notice={notice} /> : null}
        {queue?.hasMore ? (
          <Notice
            notice={{
              tone: 'warning',
              message:
                'Queue exceeds the bounded 50-ticket view. Showing the authoritative window.',
            }}
          />
        ) : null}

        <DeliveryBoard
          sessionToken={runtime.sessionToken}
          operatorStaffProfileId={runtime.operatorStaffProfileId}
          onAuthorizationFailure={deliveryAuthorizationFailure}
        />

        {loading ? (
          <LoadingBoard />
        ) : queue ? (
          <>
            {queue.tickets.length === 0 ? (
              <div
                role="status"
                className="rounded-lg border border-border-subtle bg-surface-sunken p-4 text-sm text-text-muted"
              >
                Queue clear. No open kitchen tickets for this station.
              </div>
            ) : null}
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {LANES.map((lane) => {
                const tickets = queue.tickets.filter((ticket) => ticket.displayStatus === lane);
                return (
                  <SectionCard
                    key={lane}
                    title={lane}
                    className="min-w-0 p-4"
                    actions={
                      <StatusPill status={lane} tone={DISPLAY_TONES[lane]} label={tickets.length} />
                    }
                  >
                    {tickets.length === 0 ? (
                      <p className="text-sm text-text-muted">No {lane.toLowerCase()} tickets.</p>
                    ) : (
                      <div className="space-y-3">
                        {tickets.map((ticket) => (
                          <TicketCard
                            key={ticket.ticketId}
                            ticket={ticket}
                            tourTarget={ticket.ticketId === queue.tickets[0]?.ticketId}
                            pending={pending !== null}
                            onAction={mutate}
                            onReprint={reprint}
                          />
                        ))}
                      </div>
                    )}
                  </SectionCard>
                );
              })}
            </div>
          </>
        ) : (
          <SectionCard title="Queue unavailable">
            <p className="text-sm text-text-muted">
              No queue data is available yet. Automatic polling will retry.
            </p>
          </SectionCard>
        )}
      </div>
    </KdsShell>
  );
}

function TicketCard({
  ticket,
  tourTarget,
  pending,
  onAction,
  onReprint,
}: {
  ticket: QueueTicket;
  tourTarget: boolean;
  pending: boolean;
  onAction: (item: QueueItem) => void;
  onReprint: (ticket: QueueTicket) => void;
}) {
  const createdAt = new Date(ticket.createdAt);
  return (
    <article
      className="min-w-0 rounded-md border border-border-subtle bg-surface-raised p-3"
      data-tour={tourTarget ? 'kds-ticket' : undefined}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-3">
        <div className="min-w-0">
          <h4 className="truncate font-display text-lg font-semibold tracking-tight text-text-strong">
            Ticket {ticket.ticketNumber}
          </h4>
          <p className="font-mono text-xs text-text-muted">Order #{ticket.orderNumber}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-right font-mono text-xs tabular-nums text-text-muted">
          <time dateTime={ticket.createdAt} title={createdAt.toLocaleString()}>
            {formatAge(ticket.createdAt)}
          </time>
          <p>{TIME_FORMATTER.format(createdAt)}</p>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => onReprint(ticket)}
            aria-label={`Reprint KOT ${ticket.ticketNumber} for order ${ticket.orderNumber}`}
          >
            Reprint KOT
          </Button>
        </div>
      </div>
      <div className="divide-y divide-border-subtle">
        {ticket.items.map((item) => {
          const action = ACTIONS[item.displayStatus];
          return (
            <div key={item.orderItemId} className="min-w-0 space-y-3 py-3 last:pb-0">
              <div className="flex min-w-0 items-start gap-3">
                <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-text-strong">
                  {item.quantity}×
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold text-text-strong">{item.name}</p>
                  {item.modifierNames.length > 0 ? (
                    <p className="font-mono text-[0.6875rem] text-text-muted">
                      {item.modifierNames.join(' · ')}
                    </p>
                  ) : null}
                  <p className="font-mono text-[0.6875rem] text-text-muted">
                    Course {item.course} ·{' '}
                    {item.displayStatus === 'HELD' ? 'HOLD — DO NOT FIRE' : 'FIRE'}
                    {item.seatNumber === null ? '' : ` · Seat ${item.seatNumber}`}
                  </p>
                </div>
                <StatusPill
                  status={item.displayStatus}
                  tone={DISPLAY_TONES[item.displayStatus]}
                  className="shrink-0"
                />
              </div>
              {action ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full"
                  disabled={pending}
                  aria-label={`${action.label} ${item.name} for order ${ticket.orderNumber}`}
                  onClick={() => onAction(item)}
                >
                  {action.label}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function LoadingBoard() {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="Loading kitchen queue"
    >
      {LANES.map((lane) => (
        <SectionCard key={lane} title={lane} className="min-w-0 p-4">
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

function KdsShell({
  status,
  tone,
  busy,
  children,
}: {
  status: string;
  tone: StatusTone;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#kds-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-control bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to kitchen display
      </a>
      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card px-4 sm:px-6 xl:px-8">
          <FathomMark className="size-10" variant="brand" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-[-0.03em] text-text-strong">
              DevFathom
            </p>
            <p className="truncate text-xs text-text-muted">Restaurant KDS</p>
          </div>
          <div className="ml-auto shrink-0" aria-live="polite">
            <StatusPill status={status} tone={tone} />
          </div>
        </header>
        <main
          id="kds-main"
          aria-busy={busy}
          className="studio-canvas relative min-h-0 flex-1 overflow-y-auto"
        >
          <div className="studio-stage mx-auto min-h-full w-full max-w-[1800px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8 xl:pb-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function Notice({ notice }: { notice: NoticeState }) {
  return (
    <div
      role={notice.tone === 'success' ? 'status' : 'alert'}
      aria-live="polite"
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        notice.tone === 'danger'
          ? 'border-destructive/30 bg-destructive/10'
          : notice.tone === 'warning'
            ? 'border-warning/30 bg-warning/10'
            : notice.tone === 'success'
              ? 'border-success/30 bg-success/10'
              : 'border-border-subtle bg-surface-sunken'
      }`}
    >
      <StatusPill status={notice.tone} tone={notice.tone} />
      <p className="min-w-0 text-sm text-text-body">{notice.message}</p>
    </div>
  );
}
