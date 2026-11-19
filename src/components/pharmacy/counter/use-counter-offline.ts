'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  counterOfflineReadiness,
  offlineCatalogueRows,
  type CounterOfflineReadiness,
  type OfflineCatalogueRow,
} from '@/lib/pharmacy/counter-offline-catalogue';
import {
  createCounterIndexedDbDriver,
  type CounterRuntimeState,
  type PharmacyCounterRuntime,
} from '@/lib/pharmacy/counter-offline-runtime';
import {
  indexedDbDeviceKeyBackend,
  parseCounterEnrolmentMirror,
  readCounterEnrolment,
  readCounterEnrolmentMirrorRaw,
  subscribeCounterEnrolment,
  type CounterEnrolment,
} from '@/lib/pharmacy/counter-device-store';
import {
  installCounterSnapshots,
  openCounterRuntime,
  type CounterOfflineDeps,
} from '@/lib/pharmacy/counter-offline-session';
import {
  CounterRequestError,
  counterSetupMessage,
  establishCounterSession,
  fetchCounterSnapshots,
  grantCounterQuota,
  reserveCounterReceipts,
} from '@/lib/pharmacy/counter-offline-transport';
import { armCounterShell } from '@/lib/pharmacy/counter-shell';
import {
  browserSnapshotPayloadHash,
  ed25519Supported,
  webCryptoSnapshotVerifier,
} from '@/lib/pharmacy/counter-snapshot-verifier';

export type CounterOfflineStatus =
  /** This browser is not an enrolled counter: online-only, exactly as before. */
  | 'unenrolled'
  /** Enrolled, but as a counter of another branch than the one selected. */
  | 'other-branch'
  | 'opening'
  | 'ready'
  /** The browser cannot verify signed snapshots, so offline mode stays off. */
  | 'unsupported'
  /** Enrolled, but this browser's stored counter data cannot be used. */
  | 'unavailable';

export type CounterOfflineView = {
  status: CounterOfflineStatus;
  enrolment: CounterEnrolment | null;
  /** A plain sentence when the server or the browser could not be used. */
  message: string | null;
  readiness: CounterOfflineReadiness | null;
  rows: OfflineCatalogueRow[];
  nowMs: number;
  /**
   * The browser says it is online but the server could not be reached at all
   * (a dropped line behind a working Wi-Fi). The counter treats it as offline.
   */
  serverUnreachable: boolean;
};

/** Browser dependencies; created on the client only. */
export function browserCounterOfflineDeps(): CounterOfflineDeps {
  return {
    driver: createCounterIndexedDbDriver(),
    verifier: webCryptoSnapshotVerifier(),
    transport: {
      establish: establishCounterSession,
      snapshots: fetchCounterSnapshots,
      lease: reserveCounterReceipts,
      quota: grantCounterQuota,
    },
    payloadHash: (payload) => browserSnapshotPayloadHash(payload),
    now: () => Date.now(),
  };
}

/** This browser's enrolment as render state (null on the server render). */
export function useCounterEnrolment(organizationId: string): CounterEnrolment | null {
  const raw = useSyncExternalStore(
    subscribeCounterEnrolment,
    readCounterEnrolmentMirrorRaw,
    () => null
  );
  return useMemo(() => {
    const parsed = parseCounterEnrolmentMirror(raw);
    return parsed && parsed.organizationId === organizationId ? parsed : null;
  }, [raw, organizationId]);
}

type Opened = {
  key: string;
  status: CounterOfflineStatus;
  message: string | null;
  state: CounterRuntimeState | null;
  unreachable?: boolean;
};

/**
 * DEV-957 phase 1: the counter's offline mode. For an enrolled counter of the
 * selected branch it opens the runtime, and while online it establishes the
 * terminal session (token kept in this hook's memory only), installs freshly
 * signed snapshots after verifying them with WebCrypto, and stores the counter
 * page for opening with no connection. Offline it reads the last verified
 * snapshots. An unenrolled browser gets `unenrolled` and nothing else happens.
 */
export function useCounterOffline(input: {
  organizationId: string;
  branchId: string;
  online: boolean;
}): CounterOfflineView {
  const { organizationId, branchId, online } = input;
  const enrolment = useCounterEnrolment(organizationId);
  const enrolledHere = enrolment !== null && enrolment.branchId === branchId;
  const [attempt, setAttempt] = useState(0);
  const openKey = enrolledHere
    ? `${enrolment.deviceId}:${online ? 'online' : 'offline'}:${attempt}`
    : '';
  const [opened, setOpened] = useState<Opened | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runtimeRef = useRef<PharmacyCounterRuntime | null>(null);
  // In memory only: the terminal session token is never persisted.
  const sessionTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const open = useCallback(
    async (enrolled: CounterEnrolment, isOnline: boolean, key: string, cancelled: () => boolean) => {
      const finish = (next: Omit<Opened, 'key'>) => {
        if (cancelled()) return;
        // The readiness clock must not lag the snapshots just installed, or a
        // list signed a moment ago would read as "not valid yet" for a minute.
        setNowMs(Date.now());
        setOpened({ key, ...next });
      };
      let record;
      try {
        record = await readCounterEnrolment(indexedDbDeviceKeyBackend(), enrolled.organizationId);
      } catch {
        record = null;
      }
      if (!record || record.deviceId !== enrolled.deviceId) {
        return finish({
          status: 'unavailable',
          message:
            "This computer's counter key is missing from the browser. A manager can enrol it again in Settings, Counter computers.",
          state: null,
        });
      }
      if (!(await ed25519Supported())) {
        return finish({
          status: 'unsupported',
          message:
            'This browser cannot check the signed price list, so offline mode is off on it. Use an up-to-date Chrome, Edge or Firefox.',
          state: null,
        });
      }
      let deps: CounterOfflineDeps;
      try {
        deps = browserCounterOfflineDeps();
      } catch {
        return finish({
          status: 'unavailable',
          message: 'This browser blocks local storage, so offline mode is off on it.',
          state: null,
        });
      }
      const counter = await openCounterRuntime(record, deps, isOnline).catch(() => null);
      if (!counter || counter.hydrated === 'unrecoverable') {
        return finish({
          status: 'unavailable',
          message:
            'The offline data on this computer belongs to another counter and was not used. A manager can enrol this computer again.',
          state: null,
        });
      }
      if (cancelled()) {
        counter.runtime.close();
        return;
      }
      runtimeRef.current?.close();
      runtimeRef.current = counter.runtime;
      sessionTokenRef.current = counter.sessionToken;
      let unreachable =
        isOnline && counter.error instanceof CounterRequestError && counter.error.status === 0;
      let message = isOnline && counter.error ? counterSetupMessage(counter.error) : null;
      if (counter.sessionToken) {
        try {
          const report = await installCounterSnapshots(counter.runtime, counter.sessionToken, deps);
          if (report.refused.length)
            message =
              'Part of the signed price list failed its check and was not used. The counter keeps the last list it checked.';
        } catch (error) {
          message = counterSetupMessage(error);
          // The line dropped between establishing and downloading the list.
          if (error instanceof CounterRequestError && error.status === 0) unreachable = true;
        }
        if (!unreachable) void armCounterShell();
      }
      finish({ status: 'ready', message, state: counter.runtime.snapshot(), unreachable });
    },
    []
  );

  useEffect(() => {
    if (!enrolledHere || !enrolment) return;
    let cancelled = false;
    void open(enrolment, online, openKey, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [enrolledHere, enrolment, online, openKey, open]);

  useEffect(
    () => () => {
      runtimeRef.current?.close();
      runtimeRef.current = null;
      sessionTokenRef.current = null;
    },
    []
  );

  const current = opened && opened.key === openKey && enrolledHere ? opened : null;
  const serverUnreachable = online && current?.unreachable === true;
  // A dropped line behind a working Wi-Fi: try the server again every minute.
  useEffect(() => {
    if (!serverUnreachable) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 60_000);
    return () => window.clearTimeout(timer);
  }, [serverUnreachable]);
  const readiness = useMemo(
    () => (current?.state ? counterOfflineReadiness(current.state, nowMs) : null),
    [current, nowMs]
  );
  const rows = useMemo(
    () => (current?.state ? offlineCatalogueRows(current.state, nowMs) : []),
    [current, nowMs]
  );
  const idle = { message: null, readiness: null, rows: [], nowMs, serverUnreachable: false };
  if (!enrolment) return { status: 'unenrolled', enrolment: null, ...idle };
  if (!enrolledHere) return { status: 'other-branch', enrolment, ...idle };
  return {
    status: current?.status ?? 'opening',
    enrolment,
    message: current?.message ?? null,
    readiness,
    rows,
    nowMs,
    serverUnreachable,
  };
}
