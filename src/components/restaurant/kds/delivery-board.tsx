'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';

type DeliveryStatus = 'PENDING' | 'DISPATCHED';
type Delivery = {
  fulfillmentId: string;
  orderNumber: number;
  status: DeliveryStatus;
  customerName: string;
  addressLabel: string | null;
  locality: string;
  promisedAt: string;
  deliveryFee: string;
  updatedAt: string;
  paymentMode: 'PREPAID' | 'COD' | null;
  dispatchable: boolean;
  rejection: string | null;
};

type QueuePayload = { serverTime: string; deliveries: Delivery[] };

class DeliveryRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly terminalAccessDenied = false
  ) {
    super(message);
  }
}

function safeMessage(value: unknown) {
  return typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
    ? value.error.slice(0, 240)
    : 'Delivery request failed without a safe server message.';
}

async function deliveryRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new DeliveryRequestError(
      response.status,
      safeMessage(body),
      response.headers.get('X-Terminal-Access') === 'denied'
    );
  return body as T;
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function DeliveryBoard({
  sessionToken,
  operatorStaffProfileId,
  onAuthorizationFailure,
}: {
  sessionToken: string;
  operatorStaffProfileId: string;
  onAuthorizationFailure: (reason: string) => void;
}) {
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    delivery: Delivery;
    status: 'DISPATCHED' | 'DELIVERED';
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await deliveryRequest<QueuePayload>('/api/restaurant/kds/delivery/queue', {
        headers: { 'X-Terminal-Session': sessionToken },
      });
      setQueue(next);
      setError(null);
    } catch (caught) {
      if (
        caught instanceof DeliveryRequestError &&
        (caught.status === 401 || caught.terminalAccessDenied)
      ) {
        onAuthorizationFailure(caught.message);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Delivery handoff refresh failed.');
    } finally {
      setLoading(false);
    }
  }, [onAuthorizationFailure, sessionToken]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(poll, 10_000);
    };
    const online = () => void load();
    void poll();
    window.addEventListener('online', online);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', online);
    };
  }, [load]);

  async function transition() {
    if (!confirm || pending) return;
    const intent = `${confirm.status}:${confirm.delivery.fulfillmentId}`;
    const key = retryKeys.current.get(intent) ?? browserUuid();
    retryKeys.current.set(intent, key);
    setPending(intent);
    setNotice(null);
    try {
      await deliveryRequest('/api/restaurant/kds/delivery/transition', {
        method: 'POST',
        headers: {
          'X-Terminal-Session': sessionToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          fulfillmentId: confirm.delivery.fulfillmentId,
          status: confirm.status,
          operatorStaffProfileId,
        }),
      });
      retryKeys.current.delete(intent);
      setNotice(confirm.status === 'DISPATCHED' ? 'Delivery dispatched.' : 'Delivery completed.');
      setConfirm(null);
      await load();
    } catch (caught) {
      if (caught instanceof DeliveryRequestError && caught.status < 500)
        retryKeys.current.delete(intent);
      if (
        caught instanceof DeliveryRequestError &&
        (caught.status === 401 || caught.terminalAccessDenied)
      ) {
        onAuthorizationFailure(caught.message);
      } else {
        setError(
          caught instanceof DeliveryRequestError
            ? caught.message
            : 'Network request failed. Delivery was not queued offline; retry while connected.'
        );
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionCard
      title="Delivery handoff"
      actions={
        <StatusPill
          status={error ? (queue ? 'stale' : 'error') : 'connected'}
          tone={error ? 'warning' : 'success'}
        />
      }
      className="min-w-0"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Connected-only dispatch and completion after the kitchen pass.
        </p>
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3"
          >
            <p className="text-sm text-text-body">{error}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending !== null}
              onClick={() => void load()}
            >
              Retry delivery sync
            </Button>
          </div>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-text-body"
          >
            {notice}
          </p>
        ) : null}
        <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
          <DialogContent showCloseButton={pending === null} initialFocus={confirmButton}>
            <DialogHeader>
              <DialogTitle>
                Confirm {confirm?.status === 'DISPATCHED' ? 'dispatch' : 'delivery completion'}
              </DialogTitle>
              <DialogDescription>
                Order #{confirm?.delivery.orderNumber} for {confirm?.delivery.customerName}. This
                action records the server-confirmed handoff state.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending !== null}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                ref={confirmButton}
                type="button"
                className="min-h-11"
                disabled={pending !== null}
                onClick={() => void transition()}
              >
                {pending ? 'Confirming…' : 'Confirm transition'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {loading && !queue ? (
          <div
            aria-label="Loading delivery handoff"
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : queue?.deliveries.length === 0 ? (
          <p
            role="status"
            className="rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm text-text-muted"
          >
            No deliveries are waiting for dispatch or completion.
          </p>
        ) : queue ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {queue.deliveries.map((delivery) => {
              const promisedAt = new Date(delivery.promisedAt);
              const nextStatus = delivery.status === 'PENDING' ? 'DISPATCHED' : 'DELIVERED';
              return (
                <article
                  key={delivery.fulfillmentId}
                  className="min-w-0 rounded-md border border-border-subtle bg-surface-raised p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-display text-lg font-semibold text-text-strong">
                        Order #{delivery.orderNumber}
                      </h3>
                      <p className="truncate text-sm font-semibold text-text-body">
                        {delivery.customerName}
                      </p>
                    </div>
                    <StatusPill
                      status={delivery.status}
                      tone={delivery.status === 'PENDING' ? 'warning' : 'info'}
                    />
                  </div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="font-mono text-xs text-text-muted">AREA</dt>
                    <dd className="min-w-0 truncate text-text-body">
                      {[delivery.addressLabel, delivery.locality].filter(Boolean).join(' · ')}
                    </dd>
                    <dt className="font-mono text-xs text-text-muted">PROMISE</dt>
                    <dd className="text-text-body">
                      <time dateTime={delivery.promisedAt}>{time.format(promisedAt)}</time>
                    </dd>
                    <dt className="font-mono text-xs text-text-muted">FEE</dt>
                    <dd className="font-mono tabular-nums text-text-body">
                      {delivery.deliveryFee}
                    </dd>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill
                      status={delivery.paymentMode ?? 'payment blocked'}
                      tone={delivery.paymentMode ? 'success' : 'danger'}
                    />
                  </div>
                  {delivery.rejection ? (
                    <p className="mt-3 text-sm text-destructive">{delivery.rejection}</p>
                  ) : null}
                  <Button
                    type="button"
                    className="mt-4 min-h-11 w-full"
                    variant={nextStatus === 'DELIVERED' ? 'outline' : 'default'}
                    disabled={
                      pending !== null || (delivery.status === 'PENDING' && !delivery.dispatchable)
                    }
                    onClick={() => setConfirm({ delivery, status: nextStatus })}
                    aria-label={`${nextStatus === 'DISPATCHED' ? 'Dispatch' : 'Mark delivered'} order ${delivery.orderNumber}`}
                  >
                    {nextStatus === 'DISPATCHED' ? 'Dispatch order' : 'Mark delivered'}
                  </Button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-text-muted">
            Delivery handoff is unavailable. Retry while connected.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
