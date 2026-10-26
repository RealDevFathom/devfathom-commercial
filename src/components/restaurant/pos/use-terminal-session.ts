'use client';

import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { browserUuid } from '@/lib/browser-uuid';
import type { TerminalRequestOptions } from './checkout-panel';
import type { OperatorSwitchInput } from './operator-switch';

export type TerminalSessionRequest = <T>(
  path: string,
  options?: TerminalRequestOptions & { idempotencyKey?: string }
) => Promise<T>;

export type Runtime = {
  organizationId: string;
  branchId: string;
  deviceId: string;
  deviceName: string;
  sessionToken: string;
  sessionId: string;
  state: 'LOCKED' | 'UNLOCKED';
  branchName: string;
  operator: OperatorOption | null;
  composerProof?: string;
};
type OperatorOption = {
  staffProfileId: string;
  displayName: string;
  role: string;
  canApprove: boolean;
};
export type PosNotice = { tone: 'success' | 'warning' | 'danger' | 'neutral'; message: string };
type EstablishResponse = {
  sessionToken: string;
  session: {
    id: string;
    state: 'LOCKED' | 'UNLOCKED';
    activeStaffProfileId?: string | null;
    establishedAt: string;
  };
  device: {
    id: string;
    organizationId: string;
    branchId: string;
    name: string;
    branchName: string;
  };
  operator?: OperatorOption;
};
type SessionResponse = {
  composerProof?: string;
  session: { id: string; state: 'LOCKED' | 'UNLOCKED'; activeStaffProfileId: string | null };
};
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function isDefinitiveMutationFailure(error: unknown) {
  return (
    error instanceof RequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function isDemoAccessExpiredError(error: unknown) {
  return (
    error instanceof RequestError &&
    error.status === 401 &&
    /^Demo access has expired(?:[.;]|$)/i.test(error.message)
  );
}

export function messageFrom(body: unknown) {
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

export async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new RequestError(response.status, messageFrom(body));
  if (body === undefined || (body === null && (init.method ?? 'GET').toUpperCase() !== 'GET'))
    throw new Error('Server response was unreadable. Retry the same command.');
  return body as T;
}

export function authHeaders(runtime: Runtime, json = false): HeadersInit {
  return {
    'X-Terminal-Session': runtime.sessionToken,
    ...(runtime.composerProof ? { 'X-POS-Composer-Proof': runtime.composerProof } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

// POS alone supplies storage/menu callbacks. Other consumers establish only terminal context.
export type TerminalSessionLifecycle = {
  onEstablish?: (runtime: Runtime) => Promise<boolean>;
  onReady?: (runtime: Runtime) => Promise<void>;
  onUnlock?: (runtime: Runtime) => Promise<void>;
  onLock?: () => void;
  onSwitch?: () => void;
  onClear?: () => void;
};
export function useTerminalSession({
  demo = false,
  autoEstablish = true,
  lifecycleRef,
}: {
  demo?: boolean;
  autoEstablish?: boolean;
  lifecycleRef?: RefObject<TerminalSessionLifecycle>;
} = {}) {
  const emptyLifecycle = useRef<TerminalSessionLifecycle>({});
  const lifecycle = lifecycleRef ?? emptyLifecycle;
  const [runtime, setRuntimeState] = useState<Runtime | null>(null);
  const [enrollmentState, setEnrollmentState] = useState<
    'checking' | 'ready' | 'missing' | 'unrecoverable'
  >('checking');
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [operatorId, setOperatorId] = useState('');
  const [operatorDirectoryState, setOperatorDirectoryState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [operatorPin, setOperatorPin] = useState('');

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<PosNotice | null>(null);
  const [online, setOnline] = useState(true);
  const establishing = useRef(false);
  const changing = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());
  const runtimeBoundary = useRef<Runtime | null>(null);
  const setRuntime = useCallback((next: Runtime | null) => {
    runtimeBoundary.current = next;
    setRuntimeState(next);
  }, []);
  const clearTerminalState = useCallback(() => {
    setRuntime(null);
    setOperators([]);
    setOperatorId('');
    setOperatorPin('');
    setOperatorDirectoryState('idle');
    idempotencyKeys.current.clear();
    lifecycle.current.onClear?.();
  }, [setRuntime, lifecycle]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const loadOperators = useCallback(async (activeRuntime: Runtime) => {
    setOperatorDirectoryState('loading');
    try {
      const data = await request<{ operators: OperatorOption[] }>(
        '/api/restaurant/terminal/operators',
        { headers: authHeaders(activeRuntime) }
      );
      if (runtimeBoundary.current !== activeRuntime) return;
      setOperators(data.operators);
      setOperatorId((current) =>
        data.operators.some((operator) => operator.staffProfileId === current)
          ? current
          : (data.operators[0]?.staffProfileId ?? '')
      );
      setOperatorDirectoryState('ready');
    } catch {
      if (runtimeBoundary.current !== activeRuntime) return;
      setOperators([]);
      setOperatorId('');
      setOperatorDirectoryState('error');
    }
  }, []);

  const checkoutRequest = useCallback<TerminalSessionRequest>(
    async <T>(
      path: string,
      options: TerminalRequestOptions & { idempotencyKey?: string } = {}
    ): Promise<T> => {
      const runtime = runtimeBoundary.current;
      if (
        !runtime ||
        runtime.state !== 'UNLOCKED' ||
        !runtime.operator ||
        changing.current ||
        !navigator.onLine
      ) {
        throw new RequestError(401, 'An unlocked terminal session is required.');
      }
      const mutation = options.method === 'POST';
      const intent =
        options.intent ??
        `${options.method ?? 'GET'}:${path}:${JSON.stringify(options.body ?? {})}`;
      let idempotencyKey: string | null = null;
      if (mutation) {
        idempotencyKey =
          options.idempotencyKey ?? idempotencyKeys.current.get(intent) ?? browserUuid();
        idempotencyKeys.current.set(intent, idempotencyKey);
      }
      try {
        const data = await request<T>(path, {
          method: options.method,
          headers: {
            ...authHeaders(runtime, options.body !== undefined),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        if (mutation) idempotencyKeys.current.delete(intent);
        return data;
      } catch (error) {
        if (mutation && isDefinitiveMutationFailure(error)) {
          idempotencyKeys.current.delete(intent);
        }
        if (demo && isDemoAccessExpiredError(error)) {
          clearTerminalState();
          setEnrollmentState('missing');
          setNotice({
            tone: 'danger',
            message: 'Demo access expired. Reopen the restaurant demo.',
          });
        } else if (
          error instanceof RequestError &&
          ((error.status === 403 && /device.+revoked/i.test(error.message)) ||
            (error.status === 401 && /session|device/i.test(error.message)))
        ) {
          clearTerminalState();
          setNotice({ tone: 'danger', message: `Terminal access ended: ${error.message}` });
        }
        throw error;
      }
    },
    [clearTerminalState, demo]
  );

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof RequestError) {
        if (demo && isDemoAccessExpiredError(error)) {
          clearTerminalState();
          setEnrollmentState('missing');
          setNotice({
            tone: 'danger',
            message: 'Demo access expired. Reopen the restaurant demo.',
          });
          return;
        }
        const revoked = error.status === 403 && /device.+revoked/i.test(error.message);
        if (revoked) clearTerminalState();
        if (error.status === 401 && /session|device/i.test(error.message)) {
          clearTerminalState();
        }
        setNotice({
          tone: error.status === 403 ? 'danger' : 'warning',
          message: revoked
            ? `Device revoked: ${error.message}`
            : error.status === 403
              ? `Permission denied: ${error.message}`
              : error.message,
        });
        return;
      }
      setNotice({
        tone: 'warning',
        message: 'Network request failed. Retry this action.',
      });
    },
    [clearTerminalState, demo]
  );

  const establish = useCallback(async () => {
    if (establishing.current || pending || changing.current) return;
    establishing.current = true;
    changing.current = true;
    setPending('establish');
    setNotice(null);
    try {
      const data = await request<EstablishResponse>(
        demo ? '/demo/restaurants/device-session' : '/api/restaurant/terminal/establish',
        {
          method: 'POST',
          ...(demo
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'POS' }),
              }
            : {}),
        }
      );
      const established: Runtime = {
        organizationId: data.device.organizationId,
        branchId: data.device.branchId,
        deviceId: data.device.id,
        deviceName: data.device.name,
        sessionToken: data.sessionToken,
        sessionId: data.session.id,
        state: data.session.state,
        branchName: data.device.branchName,
        operator: data.operator ?? null,
      };
      if ((await lifecycle.current.onEstablish?.(established)) === false) return;
      setRuntime(established);
      setEnrollmentState('ready');
      setNotice({
        tone: 'success',
        message: data.operator
          ? `Demo terminal ready as ${data.operator.displayName}.`
          : 'Device session established. Unlock to continue.',
      });
      await loadOperators(established);
      if (established.state === 'UNLOCKED') await lifecycle.current.onReady?.(established);
    } catch (error) {
      setEnrollmentState('missing');
      handleError(error);
    } finally {
      establishing.current = false;
      changing.current = false;
      setPending(null);
    }
  }, [demo, handleError, loadOperators, pending, setRuntime, lifecycle]);

  useEffect(() => {
    if (autoEstablish && enrollmentState === 'checking') queueMicrotask(() => void establish());
  }, [autoEstablish, enrollmentState, establish]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !runtime ||
      !operatorId.trim() ||
      !/^\d{4,8}$/.test(operatorPin) ||
      pending ||
      changing.current
    )
      return;
    changing.current = true;
    setPending('unlock');
    setNotice(null);
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/unlock', {
        method: 'POST',
        headers: authHeaders(runtime, true),
        body: JSON.stringify({
          staffProfileId: operatorId.trim(),
          type: 'PIN',
          secret: operatorPin,
        }),
      });
      const unlocked: Runtime = {
        ...runtime,
        state: data.session.state,
        composerProof: data.composerProof,
        operator:
          operators.find(
            (operator) => operator.staffProfileId === data.session.activeStaffProfileId
          ) ?? null,
      };
      setRuntime(unlocked);

      setOperatorPin('');
      setNotice({ tone: 'success', message: 'Terminal unlocked.' });
      await lifecycle.current.onUnlock?.(unlocked);
    } catch (error) {
      setOperatorPin('');
      handleError(error);
    } finally {
      changing.current = false;
      setPending(null);
    }
  }

  async function lock() {
    if (!runtime || pending || changing.current) return;
    changing.current = true;
    setPending('lock');
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/lock', {
        method: 'POST',
        headers: authHeaders(runtime),
      });
      const locked: Runtime = { ...runtime, state: data.session.state, operator: null };
      delete locked.composerProof;
      setRuntime(locked);
      setOperatorId('');
      setOperators([]);
      setOperatorPin('');
      lifecycle.current.onLock?.();
      idempotencyKeys.current.clear();
      setNotice({ tone: 'success', message: 'Terminal locked.' });
      await loadOperators(locked);
    } catch (error) {
      handleError(error);
    } finally {
      changing.current = false;
      setPending(null);
    }
  }

  async function switchOperator(input: OperatorSwitchInput) {
    if (!runtime || pending || changing.current) return false;
    changing.current = true;
    setPending('switch');
    setNotice(null);
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/switch', {
        method: 'POST',
        headers: authHeaders(runtime, true),
        body: JSON.stringify(input),
      });
      const switched: Runtime = {
        ...runtime,
        state: data.session.state,
        composerProof: data.composerProof,
        operator:
          operators.find(
            (operator) => operator.staffProfileId === data.session.activeStaffProfileId
          ) ?? null,
      };
      setRuntime(switched);
      lifecycle.current.onSwitch?.();
      setNotice({
        tone: 'success',
        message: 'Operator switched. New actions use the incoming identity.',
      });
      return true;
    } catch (error) {
      handleError(error);
      return false;
    } finally {
      changing.current = false;
      setPending(null);
    }
  }

  return {
    runtime,
    setRuntime,
    runtimeBoundary,
    enrollmentState,
    setEnrollmentState,
    operators,
    operatorId,
    setOperatorId,
    operatorDirectoryState,
    operatorPin,
    setOperatorPin,
    pending,
    setPending,
    notice,
    setNotice,
    online,
    idempotencyKeys,
    loadOperators,
    checkoutRequest,
    handleError,
    clearTerminalState,
    establish,
    unlock,
    lock,
    switchOperator,
  };
}
