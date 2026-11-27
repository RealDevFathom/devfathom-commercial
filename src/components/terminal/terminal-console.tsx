'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';

import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import {
  classifyTerminalFailure,
  sanitizePin,
  validateCoAuthorization,
  validateOperatorCredential,
  type TerminalFailure,
} from './terminal-state';

type SessionState = 'LOCKED' | 'UNLOCKED';
type DeviceHealth = 'HEALTHY' | 'NEVER_SEEN' | 'STALE' | 'REVOKED' | 'DEGRADED';
type PendingAction = 'establish' | 'lock' | 'operator' | 'approval' | null;

type TerminalRuntime = {
  deviceSecret: string;
  sessionToken: string;
  sessionId: string;
  state: SessionState;
  activeStaffProfileId: string | null;
  establishedAt: string;
  deviceId: string;
  branchId: string;
  health: DeviceHealth;
  serverTime: string;
};

type ApprovalEvidence = {
  orderNumber: number;
  id: string;
  capability: string;
  actingStaffProfileId: string;
  approvingStaffProfileId: string;
  targetType: string | null;
  targetId: string | null;
  reason: string;
  deviceId: string;
  terminalSessionId: string;
  createdAt: string;
};

type Notice = (
  TerminalFailure | { kind: 'success'; title: string; message: string; reset: 'none' }
) & { source?: 'heartbeat' };

type EstablishResponse = {
  sessionToken: string;
  session: { id: string; state: SessionState; establishedAt: string };
  device: { id: string; branchId: string };
};

type SessionResponse = {
  session: { id: string; state: SessionState; activeStaffProfileId: string | null };
};

type HeartbeatResponse = {
  session: { id: string; state: SessionState; activeStaffProfileId: string | null };
  device: { id: string; health: Exclude<DeviceHealth, 'DEGRADED'> };
  serverTime: string;
};

type OperatorOption = { staffProfileId: string; displayName: string; role: string };
type OperatorsResponse = { operators: OperatorOption[] };

type CoAuthorizationResponse = {
  coAuthorization: {
    id: string;
    capability: string;
    actingStaffProfileId: string;
    approvingStaffProfileId: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  };
};

class TerminalRequestError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string | undefined,
    readonly retryAfter: string | null
  ) {
    super('Terminal request failed');
  }
}

async function terminalRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    throw new TerminalRequestError(
      response.status,
      typeof body?.error === 'string' ? body.error : undefined,
      response.headers.get('Retry-After')
    );
  }
  return body as T;
}

function transportHeaders(runtime: TerminalRuntime, json = false): HeadersInit {
  return {
    Authorization: `Bearer ${runtime.deviceSecret}`,
    'X-Terminal-Session': runtime.sessionToken,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

type ApprovalOrder = { id: string; businessDate: string; orderNumber: number };

function ApprovalOrderField({
  runtime,
  selected,
  onSelect,
  disabled,
}: {
  runtime: TerminalRuntime;
  selected: ApprovalOrder | null;
  onSelect: (order: ApprovalOrder | null) => void;
  disabled: boolean;
}) {
  const [orders, setOrders] = useState<ApprovalOrder[] | null>(null);
  const [error, setError] = useState(false);
  const { deviceSecret, sessionToken } = runtime;
  useEffect(() => {
    let cancelled = false;
    terminalRequest<{ orders: ApprovalOrder[] }>('/api/restaurant/orders/open-orders', {
      method: 'GET',
      headers: { Authorization: `Bearer ${deviceSecret}`, 'X-Terminal-Session': sessionToken },
    })
      .then((data) => {
        if (!cancelled) setOrders(data.orders);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceSecret, sessionToken]);
  return (
    <div className="space-y-2">
      <Label htmlFor="approval-order">Order to void</Label>
      <StudioSelect
        id="approval-order"
        className="h-11 rounded-control"
        value={selected?.id ?? ''}
        disabled={disabled || !orders?.length}
        required
        onChange={(event) =>
          onSelect(orders?.find((order) => order.id === event.target.value) ?? null)
        }
      >
        <option value="" disabled>
          {error
            ? 'Orders unavailable. Reopen manager approval to retry.'
            : !orders
              ? 'Loading orders…'
              : orders.length
                ? 'Select an open order'
                : 'No open orders for this branch'}
        </option>
        {orders?.map((order) => (
          <option key={order.id} value={order.id}>
            Order {order.orderNumber} · {order.businessDate}
          </option>
        ))}
      </StudioSelect>
    </div>
  );
}

function noticeTone(kind: Notice['kind']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (kind === 'success') return 'success';
  if (kind === 'locked' || kind === 'network') return 'warning';
  if (kind === 'error') return 'neutral';
  return 'danger';
}

function terminalStatus(
  runtime: TerminalRuntime | null,
  sessionInvalid: boolean,
  notice: Notice | null
): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (notice?.kind === 'revoked') return { label: 'Device revoked', tone: 'danger' };
  if (!runtime) return { label: 'Enrollment required', tone: 'neutral' };
  if (sessionInvalid) return { label: 'Session ended', tone: 'danger' };
  if (runtime.health === 'DEGRADED' || runtime.health === 'STALE') {
    return { label: 'Connection degraded', tone: 'warning' };
  }
  if (runtime.state === 'LOCKED') return { label: 'Terminal locked', tone: 'warning' };
  return { label: 'Terminal ready', tone: 'success' };
}

function NoticePanel({ notice }: { notice: Notice }) {
  const danger = ['unauthorized', 'forbidden', 'revoked'].includes(notice.kind);
  return (
    <div
      id="terminal-notice"
      role={notice.kind === 'success' ? 'status' : 'alert'}
      className={`flex items-start gap-3 rounded-lg border p-4 ${
        danger
          ? 'border-destructive/30 bg-destructive/10'
          : notice.kind === 'locked' || notice.kind === 'network'
            ? 'border-warning/30 bg-warning/10'
            : notice.kind === 'success'
              ? 'border-success/30 bg-success/10'
              : 'border-border-default bg-surface-sunken'
      }`}
    >
      <StatusPill status={notice.kind} tone={noticeTone(notice.kind)} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-strong">{notice.title}</p>
        <p className="mt-1 text-sm leading-6 text-text-body">{notice.message}</p>
      </div>
    </div>
  );
}

export function TerminalConsole() {
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(null);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [heartbeatPending, setHeartbeatPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [operatorId, setOperatorId] = useState('');
  const [operatorPin, setOperatorPin] = useState('');
  const [operatorError, setOperatorError] = useState<string | null>(null);
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [operatorsState, setOperatorsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [actionMode, setActionMode] = useState<'switch' | 'approval'>('switch');
  const [approvingId, setApprovingId] = useState('');
  const [approvingPin, setApprovingPin] = useState('');
  const [approvalOrder, setApprovalOrder] = useState<ApprovalOrder | null>(null);
  const [reason, setReason] = useState('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalEvidence | null>(null);
  const mutationVersion = useRef(0);
  const activeOperator = operators.find(
    (operator) => operator.staffProfileId === runtime?.activeStaffProfileId
  );

  const clearCredentialInputs = () => {
    setApprovalOrder(null);
    setOperatorId('');
    setOperatorPin('');
    setApprovingId('');
    setApprovingPin('');
  };

  const handleError = useCallback((error: unknown, source?: Notice['source']) => {
    const failure =
      error instanceof TerminalRequestError
        ? classifyTerminalFailure(error.status, error.serverMessage, error.retryAfter)
        : classifyTerminalFailure(0);
    setNotice(source ? { ...failure, source } : failure);
    if (failure.reset === 'device') {
      setRuntime(null);
      setSessionInvalid(false);
      setApproval(null);
      setOperators([]);
      setOperatorsState('idle');
    } else if (failure.reset === 'session') {
      setSessionInvalid(true);
    } else if (failure.kind === 'network') {
      setRuntime((current) => (current ? { ...current, health: 'DEGRADED' } : current));
    }
  }, []);

  const establish = async (secret: string) => {
    setPending('establish');
    setNotice(null);
    try {
      const data = await terminalRequest<EstablishResponse>('/api/restaurant/terminal/establish', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      setRuntime({
        deviceSecret: secret,
        sessionToken: data.sessionToken,
        sessionId: data.session.id,
        state: data.session.state,
        activeStaffProfileId: null,
        establishedAt: data.session.establishedAt,
        deviceId: data.device.id,
        branchId: data.device.branchId,
        health: 'HEALTHY',
        serverTime: data.session.establishedAt,
      });
      setOperators([]);
      setOperatorsState('loading');
      setSessionInvalid(false);
      setApproval(null);
      setNotice({
        kind: 'success',
        title: 'Device enrolled',
        message: 'Device-authenticated session established. Unlock it with an operator PIN.',
        reset: 'none',
      });
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  };

  const refreshHeartbeat = useCallback(
    async (announce: boolean, reconciledOperatorId?: string) => {
      if (!runtime || sessionInvalid || heartbeatPending || (pending && !reconciledOperatorId)) {
        return;
      }
      const version = mutationVersion.current;
      setHeartbeatPending(true);
      try {
        const data = await terminalRequest<HeartbeatResponse>(
          '/api/restaurant/terminal/heartbeat',
          { method: 'POST', headers: transportHeaders(runtime) }
        );
        if (mutationVersion.current !== version && !reconciledOperatorId) return;
        setRuntime((current) =>
          current
            ? {
                ...current,
                sessionId: data.session.id,
                state: data.session.state,
                activeStaffProfileId: data.session.activeStaffProfileId,
                deviceId: data.device.id,
                health: data.device.health,
                serverTime: data.serverTime,
              }
            : current
        );
        setNotice((current) => {
          if (current && current.source !== 'heartbeat') return current;
          return announce
            ? {
                kind: 'success',
                title: 'Server status refreshed',
                message: 'Device and terminal session were revalidated.',
                reset: 'none',
              }
            : null;
        });
      } catch (error) {
        if (mutationVersion.current === version || reconciledOperatorId) {
          handleError(error, 'heartbeat');
        }
      } finally {
        setHeartbeatPending(false);
      }
    },
    [handleError, heartbeatPending, pending, runtime, sessionInvalid]
  );

  useEffect(() => {
    if (!runtime || sessionInvalid) return;
    const interval = window.setInterval(() => void refreshHeartbeat(false), 60_000);
    return () => window.clearInterval(interval);
  }, [refreshHeartbeat, runtime, sessionInvalid]);

  const operatorDeviceId = runtime?.deviceId;
  const operatorSessionToken = runtime?.sessionToken;
  const operatorDeviceSecret = runtime?.deviceSecret;

  useEffect(() => {
    if (!operatorDeviceId || !operatorSessionToken || !operatorDeviceSecret || sessionInvalid)
      return;
    let cancelled = false;
    terminalRequest<OperatorsResponse>('/api/restaurant/terminal/operators', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${operatorDeviceSecret}`,
        'X-Terminal-Session': operatorSessionToken,
      },
    })
      .then((data) => {
        if (cancelled) return;
        setOperators(data.operators);
        setOperatorsState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setOperators([]);
        setOperatorsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [operatorDeviceId, operatorDeviceSecret, operatorSessionToken, sessionInvalid]);

  const submitEnrollment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const secret = enrollmentSecret.trim();
    setEnrollmentSecret('');
    if (!secret) {
      setEnrollmentError('Enter the one-time device enrollment secret.');
      return;
    }
    setEnrollmentError(null);
    void establish(secret);
  };

  const lockTerminal = async () => {
    if (!runtime || pending) return;
    mutationVersion.current += 1;
    clearCredentialInputs();
    setPending('lock');
    setNotice(null);
    try {
      const data = await terminalRequest<SessionResponse>('/api/restaurant/terminal/lock', {
        method: 'POST',
        headers: transportHeaders(runtime),
      });
      setRuntime((current) =>
        current
          ? {
              ...current,
              state: data.session.state,
              activeStaffProfileId: data.session.activeStaffProfileId,
            }
          : current
      );
      setNotice({
        kind: 'success',
        title: 'Terminal locked',
        message: 'Acting operator was cleared. A PIN is required to resume work.',
        reset: 'none',
      });
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  };

  const submitOperator = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runtime || pending || heartbeatPending) return;
    const error = validateOperatorCredential(operatorId, operatorPin);
    const incomingOperatorId = operatorId.trim();
    const pin = operatorPin;
    setOperatorPin('');
    if (error) {
      setOperatorError(error);
      return;
    }
    setOperatorError(null);
    mutationVersion.current += 1;
    clearCredentialInputs();
    setPending('operator');
    setNotice(null);
    const wasLocked = runtime.state === 'LOCKED';
    try {
      const data = await terminalRequest<SessionResponse>(
        `/api/restaurant/terminal/${wasLocked ? 'unlock' : 'switch'}`,
        {
          method: 'POST',
          headers: transportHeaders(runtime, true),
          body: JSON.stringify({
            staffProfileId: incomingOperatorId,
            type: 'PIN',
            secret: pin,
          }),
        }
      );
      setRuntime((current) =>
        current
          ? {
              ...current,
              state: data.session.state,
              activeStaffProfileId: data.session.activeStaffProfileId,
            }
          : current
      );
      setNotice({
        kind: 'success',
        title: wasLocked ? 'Terminal unlocked' : 'Operator switched',
        message: 'Incoming operator credential verified. Acting identity is now bound.',
        reset: 'none',
      });
    } catch (requestError) {
      const ambiguousSwitch = !wasLocked && !(requestError instanceof TerminalRequestError);
      handleError(requestError, ambiguousSwitch ? 'heartbeat' : undefined);
      if (ambiguousSwitch) {
        await refreshHeartbeat(false, incomingOperatorId);
      }
    } finally {
      setPending(null);
    }
  };

  const submitApproval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runtime || !runtime.activeStaffProfileId || pending || heartbeatPending) return;
    if (!approvalOrder) return;
    const error = validateCoAuthorization({
      actingStaffProfileId: runtime.activeStaffProfileId,
      approvingStaffProfileId: approvingId,
      pin: approvingPin,
      capability: 'orders:void',
      reason,
      targetType: 'Order',
      targetId: approvalOrder.id,
    });
    const pin = approvingPin;
    setApprovingPin('');
    if (error) {
      setApprovalError(error);
      return;
    }
    setApprovalError(null);
    setPending('approval');
    setNotice(null);
    const payload = {
      approvingStaffProfileId: approvingId.trim(),
      type: 'PIN' as const,
      secret: pin,
      capability: 'orders:void',
      targetType: 'Order',
      targetId: approvalOrder.id,
      reason: reason.trim(),
    };
    try {
      const data = await terminalRequest<CoAuthorizationResponse>(
        '/api/restaurant/terminal/co-authorize',
        {
          method: 'POST',
          headers: transportHeaders(runtime, true),
          body: JSON.stringify(payload),
        }
      );
      setApproval({
        ...data.coAuthorization,
        orderNumber: approvalOrder.orderNumber,
        reason: payload.reason,
        deviceId: runtime.deviceId,
        terminalSessionId: runtime.sessionId,
      });
      setApprovingId('');
      setApprovalOrder(null);
      setReason('');
      setNotice({
        kind: 'success',
        title: 'Manager approval recorded',
        message: 'Approver was added to the evidence. Acting operator remains unchanged.',
        reset: 'none',
      });
    } catch (requestError) {
      handleError(requestError);
    } finally {
      setPending(null);
    }
  };

  const status = terminalStatus(runtime, sessionInvalid, notice);
  const evidenceRows = approval
    ? [
        [
          'Acting staff',
          operators.find((operator) => operator.staffProfileId === approval.actingStaffProfileId)
            ?.displayName ?? 'Staff name unavailable',
        ],
        [
          'Approving manager',
          operators.find((operator) => operator.staffProfileId === approval.approvingStaffProfileId)
            ?.displayName ?? 'Manager name unavailable',
        ],
        ['Capability / action', approval.capability],
        ['Order', String(approval.orderNumber)],
        ['Reason', approval.reason],
        ['Server timestamp', approval.createdAt],
      ]
    : [];

  return (
    <div className="studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#terminal-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-control bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to terminal controls
      </a>

      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card px-4 sm:px-6 xl:px-8">
          <FathomMark className="size-10" variant="brand" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-[-0.03em] text-text-strong">
              DevFathom
            </p>
            <p className="truncate text-xs text-text-muted">Restaurant terminal</p>
          </div>
          <div className="ml-auto shrink-0" aria-live="polite">
            <StatusPill status={status.label} tone={status.tone} />
          </div>
        </header>

        <main id="terminal-main" className="studio-canvas relative min-h-0 flex-1 overflow-y-auto">
          <div className="studio-stage mx-auto min-h-full w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8 xl:pb-8">
            <PageHeader
              eyebrow="Restaurant / counter"
              heading={runtime ? 'Counter terminal' : 'Enroll terminal'}
              description={
                <span className="text-text-body">
                  {runtime
                    ? 'Device-authenticated operator control. Server state remains authoritative.'
                    : 'Paste the one-time secret issued during device enrollment to open a locked session.'}
                </span>
              }
              actions={
                runtime ? (
                  sessionInvalid ? (
                    <Button
                      size="lg"
                      className="h-11 px-4"
                      disabled={pending !== null}
                      onClick={() => void establish(runtime.deviceSecret)}
                    >
                      {pending === 'establish' ? (
                        <Loader2 aria-hidden className="animate-spin" />
                      ) : (
                        <KeyRound aria-hidden />
                      )}
                      Re-establish session
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="lg"
                      className="h-11 px-4"
                      disabled={pending !== null || heartbeatPending}
                      onClick={() => void refreshHeartbeat(true)}
                    >
                      {heartbeatPending ? (
                        <Loader2 aria-hidden className="animate-spin" />
                      ) : (
                        <RefreshCw aria-hidden />
                      )}
                      Check server status
                    </Button>
                  )
                ) : undefined
              }
            />

            <div className="space-y-6">
              {notice ? <NoticePanel notice={notice} /> : null}

              {!runtime ? (
                <SectionCard className="mx-auto max-w-2xl p-6 sm:p-8">
                  <div className="max-w-xl">
                    <KeyRound className="size-7 text-accent-brand" aria-hidden />
                    <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-text-strong">
                      Complete device enrollment
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-text-muted">
                      Secret stays only in this open terminal session. It is never written to
                      browser storage or sent to web-login services.
                    </p>
                  </div>
                  <form className="mt-6 space-y-5" onSubmit={submitEnrollment}>
                    <div className="space-y-2">
                      <Label htmlFor="enrollment-secret">One-time enrollment secret</Label>
                      <Input
                        id="enrollment-secret"
                        type="password"
                        value={enrollmentSecret}
                        onChange={(event) => setEnrollmentSecret(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-11 font-mono"
                        aria-invalid={enrollmentError ? true : undefined}
                        aria-describedby={enrollmentError ? 'enrollment-error' : undefined}
                        disabled={pending !== null}
                      />
                      {enrollmentError ? (
                        <p id="enrollment-error" className="text-sm text-destructive">
                          {enrollmentError}
                        </p>
                      ) : (
                        <p className="text-xs leading-5 text-text-muted">
                          Issued once by restaurant device administration.
                        </p>
                      )}
                    </div>
                    <Button
                      type="submit"
                      className="h-11 w-full px-5 sm:w-auto"
                      disabled={pending !== null}
                    >
                      {pending === 'establish' ? (
                        <Loader2 aria-hidden className="animate-spin" />
                      ) : (
                        <ShieldCheck aria-hidden />
                      )}
                      Establish locked session
                    </Button>
                  </form>
                </SectionCard>
              ) : (
                <>
                  <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <SectionCard className="p-6">
                      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle pb-5">
                        <div>
                          <p className="font-mono text-[10px] font-semibold tracking-[0.16em] text-text-muted uppercase">
                            Live server state
                          </p>
                          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-text-strong">
                            Terminal state
                          </h2>
                        </div>
                        <StatusPill
                          status={runtime.state}
                          tone={runtime.state === 'UNLOCKED' ? 'success' : 'warning'}
                        />
                      </div>

                      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-5 py-6 sm:grid-cols-2">
                        {[
                          ['Device health', runtime.health],
                          [
                            'Acting operator',
                            activeOperator
                              ? `${activeOperator.displayName} — ${activeOperator.role}`
                              : 'None — locked',
                          ],
                          ['Server timestamp', runtime.serverTime],
                        ].map(([label, value]) => (
                          <div key={label} className="min-w-0">
                            <dt className="font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
                              {label}
                            </dt>
                            <dd className="mt-1 break-all font-mono text-xs leading-5 text-text-strong">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>

                      <div className="border-t border-border-subtle pt-5">
                        {runtime.state === 'UNLOCKED' ? (
                          <Button
                            variant="outline"
                            size="lg"
                            className="h-11 w-full px-4 sm:w-auto"
                            disabled={pending !== null || sessionInvalid}
                            onClick={() => void lockTerminal()}
                          >
                            {pending === 'lock' ? (
                              <Loader2 aria-hidden className="animate-spin" />
                            ) : (
                              <Lock aria-hidden />
                            )}
                            Lock terminal
                          </Button>
                        ) : (
                          <p className="text-sm leading-6 text-text-muted">
                            No acting operator. Unlock requires the incoming operator’s own PIN.
                          </p>
                        )}
                      </div>
                    </SectionCard>

                    <SectionCard className="p-6">
                      {runtime.state === 'LOCKED' ? (
                        <>
                          <div>
                            <p className="font-mono text-[10px] font-semibold tracking-[0.16em] text-text-muted uppercase">
                              Operator control
                            </p>
                            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-text-strong">
                              Unlock terminal
                            </h2>
                            <p className="mt-2 text-sm leading-6 text-text-muted">
                              Incoming operator becomes the acting identity after server
                              verification.
                            </p>
                          </div>
                          <form className="mt-6 space-y-5" onSubmit={submitOperator}>
                            <div className="space-y-2">
                              <Label htmlFor="unlock-operator">Operator</Label>
                              <StudioSelect
                                id="unlock-operator"
                                value={operatorId}
                                onChange={(event) => setOperatorId(event.target.value)}
                                className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                                aria-invalid={operatorError ? true : undefined}
                                aria-describedby={operatorError ? 'operator-error' : undefined}
                                disabled={
                                  pending !== null ||
                                  heartbeatPending ||
                                  sessionInvalid ||
                                  operatorsState !== 'ready' ||
                                  operators.length === 0
                                }
                              >
                                <option value="" disabled>
                                  {operatorsState === 'loading'
                                    ? 'Loading eligible operators…'
                                    : operatorsState === 'error'
                                      ? 'Operators unavailable — check connection'
                                      : operators.length === 0
                                        ? 'No eligible operators for this branch'
                                        : 'Select an operator'}
                                </option>
                                {operators.map((operator) => (
                                  <option
                                    key={operator.staffProfileId}
                                    value={operator.staffProfileId}
                                  >
                                    {operator.displayName} — {operator.role}
                                  </option>
                                ))}
                              </StudioSelect>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="unlock-pin">Operator PIN</Label>
                              <Input
                                id="unlock-pin"
                                type="password"
                                inputMode="numeric"
                                pattern="[0-9]{4,8}"
                                minLength={4}
                                maxLength={8}
                                value={operatorPin}
                                onChange={(event) =>
                                  setOperatorPin(sanitizePin(event.target.value))
                                }
                                autoComplete="off"
                                className="h-11 font-mono text-lg tracking-[0.3em]"
                                aria-invalid={operatorError ? true : undefined}
                                aria-describedby={operatorError ? 'operator-error' : undefined}
                                disabled={pending !== null || heartbeatPending || sessionInvalid}
                              />
                              {operatorError ? (
                                <p id="operator-error" className="text-sm text-destructive">
                                  {operatorError}
                                </p>
                              ) : (
                                <p className="text-xs text-text-muted">
                                  4–8 digits. Cleared after every attempt.
                                </p>
                              )}
                            </div>
                            <Button
                              type="submit"
                              className="h-11 w-full px-5 sm:w-auto"
                              disabled={pending !== null || heartbeatPending || sessionInvalid}
                            >
                              {pending === 'operator' ? (
                                <Loader2 aria-hidden className="animate-spin" />
                              ) : (
                                <UserRoundCheck aria-hidden />
                              )}
                              Verify and unlock
                            </Button>
                          </form>
                        </>
                      ) : (
                        <>
                          <div>
                            <p className="font-mono text-[10px] font-semibold tracking-[0.16em] text-text-muted uppercase">
                              Authorized actions
                            </p>
                            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-text-strong">
                              Operator control
                            </h2>
                          </div>

                          <div
                            className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2"
                            role="group"
                            aria-label="Operator action"
                          >
                            <Button
                              type="button"
                              variant={actionMode === 'switch' ? 'secondary' : 'outline'}
                              className="h-11"
                              aria-pressed={actionMode === 'switch'}
                              disabled={pending !== null || heartbeatPending || sessionInvalid}
                              onClick={() => {
                                setApprovalOrder(null);
                                setActionMode('switch');
                              }}
                            >
                              Switch operator
                            </Button>
                            <Button
                              type="button"
                              variant={actionMode === 'approval' ? 'secondary' : 'outline'}
                              className="h-11"
                              aria-pressed={actionMode === 'approval'}
                              disabled={pending !== null || heartbeatPending || sessionInvalid}
                              onClick={() => setActionMode('approval')}
                            >
                              Manager approval
                            </Button>
                          </div>

                          {actionMode === 'switch' ? (
                            <form className="mt-6 space-y-5" onSubmit={submitOperator}>
                              <div className="space-y-2">
                                <Label htmlFor="switch-operator">Incoming operator</Label>
                                <StudioSelect
                                  id="switch-operator"
                                  value={operatorId}
                                  onChange={(event) => setOperatorId(event.target.value)}
                                  className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                                  aria-invalid={operatorError ? true : undefined}
                                  aria-describedby={operatorError ? 'operator-error' : undefined}
                                  disabled={
                                    pending !== null ||
                                    heartbeatPending ||
                                    sessionInvalid ||
                                    operatorsState !== 'ready' ||
                                    operators.length === 0
                                  }
                                >
                                  <option value="" disabled>
                                    {operatorsState === 'loading'
                                      ? 'Loading eligible operators…'
                                      : operatorsState === 'error'
                                        ? 'Operators unavailable — check connection'
                                        : operators.length === 0
                                          ? 'No eligible operators for this branch'
                                          : 'Select an operator'}
                                  </option>
                                  {operators.map((operator) => (
                                    <option
                                      key={operator.staffProfileId}
                                      value={operator.staffProfileId}
                                    >
                                      {operator.displayName} — {operator.role}
                                    </option>
                                  ))}
                                </StudioSelect>
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="switch-pin">Incoming operator PIN</Label>
                                <Input
                                  id="switch-pin"
                                  type="password"
                                  inputMode="numeric"
                                  pattern="[0-9]{4,8}"
                                  minLength={4}
                                  maxLength={8}
                                  value={operatorPin}
                                  onChange={(event) =>
                                    setOperatorPin(sanitizePin(event.target.value))
                                  }
                                  autoComplete="off"
                                  className="h-11 font-mono text-lg tracking-[0.3em]"
                                  aria-invalid={operatorError ? true : undefined}
                                  aria-describedby={operatorError ? 'operator-error' : undefined}
                                  disabled={pending !== null || heartbeatPending || sessionInvalid}
                                />
                                {operatorError ? (
                                  <p id="operator-error" className="text-sm text-destructive">
                                    {operatorError}
                                  </p>
                                ) : (
                                  <p className="text-xs text-text-muted">
                                    4–8 digits. Cleared after every attempt.
                                  </p>
                                )}
                              </div>
                              <Button
                                type="submit"
                                className="h-11 w-full px-5 sm:w-auto"
                                disabled={pending !== null || heartbeatPending || sessionInvalid}
                              >
                                {pending === 'operator' ? (
                                  <Loader2 aria-hidden className="animate-spin" />
                                ) : (
                                  <UserRoundCheck aria-hidden />
                                )}
                                Verify incoming operator
                              </Button>
                            </form>
                          ) : (
                            <form className="mt-6 space-y-5" onSubmit={submitApproval}>
                              <p className="rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm leading-6 text-text-body">
                                Acting operator stays{' '}
                                <span className="font-semibold text-text-strong">
                                  {activeOperator
                                    ? `${activeOperator.displayName} — ${activeOperator.role}`
                                    : 'the current operator'}
                                </span>
                                . Manager identity is added to the approval evidence.
                              </p>
                              <div className="grid gap-5 sm:grid-cols-2">
                                <div className="space-y-2">
                                  <Label htmlFor="approving-manager">Approving manager</Label>
                                  <StudioSelect
                                    id="approving-manager"
                                    value={approvingId}
                                    onChange={(event) => setApprovingId(event.target.value)}
                                    className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                                    aria-invalid={approvalError ? true : undefined}
                                    aria-describedby={approvalError ? 'approval-error' : undefined}
                                    disabled={
                                      pending !== null ||
                                      heartbeatPending ||
                                      sessionInvalid ||
                                      operatorsState !== 'ready' ||
                                      operators.length === 0
                                    }
                                  >
                                    <option value="" disabled>
                                      {operatorsState === 'loading'
                                        ? 'Loading eligible managers…'
                                        : operatorsState === 'error'
                                          ? 'Managers unavailable — check connection'
                                          : operators.length === 0
                                            ? 'No eligible managers for this branch'
                                            : 'Select a manager'}
                                    </option>
                                    {operators
                                      .filter(
                                        (operator) =>
                                          operator.staffProfileId !== runtime.activeStaffProfileId
                                      )
                                      .map((operator) => (
                                        <option
                                          key={operator.staffProfileId}
                                          value={operator.staffProfileId}
                                        >
                                          {operator.displayName} — {operator.role}
                                        </option>
                                      ))}
                                  </StudioSelect>
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor="approving-pin">Manager PIN</Label>
                                  <Input
                                    id="approving-pin"
                                    type="password"
                                    inputMode="numeric"
                                    pattern="[0-9]{4,8}"
                                    minLength={4}
                                    maxLength={8}
                                    value={approvingPin}
                                    onChange={(event) =>
                                      setApprovingPin(sanitizePin(event.target.value))
                                    }
                                    autoComplete="off"
                                    className="h-11 font-mono text-lg tracking-[0.3em]"
                                    aria-invalid={approvalError ? true : undefined}
                                    aria-describedby={approvalError ? 'approval-error' : undefined}
                                    disabled={
                                      pending !== null || heartbeatPending || sessionInvalid
                                    }
                                  />
                                </div>
                              </div>
                              <ApprovalOrderField
                                key={runtime.sessionId}
                                runtime={runtime}
                                selected={approvalOrder}
                                onSelect={setApprovalOrder}
                                disabled={pending !== null || heartbeatPending || sessionInvalid}
                              />
                              <div className="space-y-2">
                                <Label htmlFor="approval-reason">Reason</Label>
                                <Textarea
                                  id="approval-reason"
                                  value={reason}
                                  onChange={(event) => setReason(event.target.value)}
                                  className="min-h-24"
                                  aria-invalid={approvalError ? true : undefined}
                                  aria-describedby={approvalError ? 'approval-error' : undefined}
                                  disabled={pending !== null || heartbeatPending || sessionInvalid}
                                />
                                {approvalError ? (
                                  <p id="approval-error" className="text-sm text-destructive">
                                    {approvalError}
                                  </p>
                                ) : (
                                  <p className="text-xs text-text-muted">
                                    Manager PIN is cleared after every attempt.
                                  </p>
                                )}
                              </div>
                              <Button
                                type="submit"
                                className="h-11 w-full px-5 sm:w-auto"
                                disabled={
                                  !approvalOrder ||
                                  pending !== null ||
                                  heartbeatPending ||
                                  sessionInvalid
                                }
                              >
                                {pending === 'approval' ? (
                                  <Loader2 aria-hidden className="animate-spin" />
                                ) : (
                                  <ShieldCheck aria-hidden />
                                )}
                                Verify and record approval
                              </Button>
                              {!approval ? (
                                <p className="text-sm text-text-muted">
                                  No manager approval recorded in this session yet.
                                </p>
                              ) : null}
                            </form>
                          )}
                        </>
                      )}
                    </SectionCard>
                  </div>

                  {approval ? (
                    <SectionCard className="p-6">
                      <div className="flex items-start gap-3 border-b border-border-subtle pb-5">
                        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
                        <div>
                          <h2 className="font-display text-xl font-semibold tracking-tight text-text-strong">
                            Last manager approval
                          </h2>
                          <p className="mt-1 text-sm text-text-muted">
                            Exact L3 evidence retained for this open terminal session.
                          </p>
                        </div>
                      </div>
                      <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-5 pt-6 sm:grid-cols-2 lg:grid-cols-3">
                        {evidenceRows.map(([label, value]) => (
                          <div key={label} className="min-w-0">
                            <dt className="font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
                              {label}
                            </dt>
                            <dd className="mt-1 break-words whitespace-pre-wrap font-mono text-xs leading-5 text-text-strong">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </SectionCard>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
