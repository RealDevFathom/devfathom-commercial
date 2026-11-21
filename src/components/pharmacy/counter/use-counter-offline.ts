'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  counterOfflineReadiness,
  offlinePriceCheckRows,
  offlineSaleRows,
  type CounterOfflineReadiness,
  type OfflineSaleRow,
} from '@/lib/pharmacy/counter-offline-catalogue';
import {
  counterOperatorOf,
  createCounterIndexedDbDriver,
  type CounterDraft,
  type CounterRuntimeState,
  type PharmacyCounterRuntime,
} from '@/lib/pharmacy/counter-offline-runtime';
import {
  unsettledCommands,
  type CounterQueuedCommand,
  type CounterReplaySigner,
} from '@/lib/pharmacy/counter-command-queue';
import {
  composeOfflineCashSale,
  offlineCashSellingOn,
  offlineSaleReceipt,
  offlineSaleRefusal,
  priceOfflineBill,
} from '@/lib/pharmacy/counter-offline-sale';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';
import {
  counterSaleSealer,
  counterReplaySigner,
  importCounterSigningKey,
} from '@/lib/pharmacy/counter-device-signing';
import type { OfflineSaleSealer } from '@/lib/pharmacy/offline-sale-seal';
import {
  forgetCounterEnrolment,
  indexedDbDeviceKeyBackend,
  parseCounterEnrolmentMirror,
  readCounterEnrolment,
  readCounterEnrolmentMirrorRaw,
  saveCounterEnrolment,
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
  renewCounterCredential,
  reserveCounterReceipts,
  unbindCounterBrowser,
} from '@/lib/pharmacy/counter-offline-transport';
import { sendCounterReplay } from '@/lib/pharmacy/counter-replay-transport';
import * as counterShell from '@/lib/pharmacy/counter-shell';
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

export type OfflinePayResult =
  | { ok: true; receipt: CounterReceipt; command: CounterQueuedCommand; changeMinor: number }
  | { ok: false; message: string };

/** DEV-957 phase 2: what the counter can do with its offline bills and queue. */
export type CounterOfflineActions = {
  resolveConflict?(commandId: string, reason: string): Promise<void>;
  saveDraft(draft: CounterDraft): Promise<boolean>;
  discardDraft(draftId: string): Promise<void>;
  /** Write the sale to this computer; "Paid" only once this resolves ok. */
  pay(draft: CounterDraft, cashReceivedMinor: number): Promise<OfflinePayResult>;
};

export type CounterOfflineView = {
  status: CounterOfflineStatus;
  enrolment: CounterEnrolment | null;
  /** A plain sentence when the server or the browser could not be used. */
  message: string | null;
  readiness: CounterOfflineReadiness | null;
  /** Sale-ready rows (a superset of the phase-1 offline catalogue row). */
  rows: OfflineSaleRow[];
  nowMs: number;
  /**
   * The browser says it is online but the server could not be reached at all
   * (a dropped line behind a working Wi-Fi). The counter treats it as offline.
   */
  serverUnreachable: boolean;
  /** DEV-957 phase 2: who offline sales on this counter are recorded for (signed RULES). */
  operator: { userId: string; name: string | null } | null;
  /** Offline bills being built on this computer, newest first. */
  drafts: CounterDraft[];
  /** Sales taken offline and not sent yet, oldest first. */
  queued: CounterQueuedCommand[];
  /** Null until the counter is open; then the offline bill and payment actions. */
  actions: CounterOfflineActions | null;
  /**
   * The server confirmed this counter was revoked: it can never sell again, and `kept`
   * unsent sales were moved to "Sales to reconcile" on this computer (review B2).
   */
  revokedNotice: { kept: number } | null;
  /**
   * DEV-957 phase 2 (review B1): the owner's offline cash selling switch, as the counter's
   * signed rules carry it. Off: the counter checks prices only, as after phase 1.
   */
  sellingOn: boolean;
  /** When the server stops renewing this counter's offline selling, once known. */
  credentialExpiresAt: string | null;
  /** Renewal was due and did not go through; the credential still works until it expires. */
  renewalFailed: boolean;
};

/** Browser dependencies; created on the client only. */
export function browserCounterOfflineDeps(enrolment?: CounterEnrolment): CounterOfflineDeps {
  return {
    driver: createCounterIndexedDbDriver(),
    verifier: webCryptoSnapshotVerifier(),
    transport: {
      establish: establishCounterSession,
      snapshots: fetchCounterSnapshots,
      lease: reserveCounterReceipts,
      quota: grantCounterQuota,
      renew: renewCounterCredential,
    },
    // DEV-957 phase 2: a renewed secret becomes this browser's new non-extractable
    // signing key at once; the string is dropped when this returns.
    ...(enrolment
      ? {
          rekey: async (secret: string) => {
            const signingKey = await importCounterSigningKey(secret);
            await saveCounterEnrolment(indexedDbDeviceKeyBackend(), { ...enrolment, signingKey });
          },
        }
      : {}),
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
  credentialExpiresAt?: string | null;
  renewalFailed?: boolean;
};

/** Best-effort; the counter-shell module is absent in some test doubles. */
async function clearShell(): Promise<void> {
  try {
    await counterShell.clearCounterShell();
  } catch {
    // Nothing stored, or service workers blocked.
  }
}

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
  const signerRef = useRef<CounterReplaySigner | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const [revokedNotice, setRevokedNotice] = useState<{ kept: number } | null>(null);
  /** How `open` reports a confirmed revocation; kept outside the effect's own state. */
  const revokedRef = useRef<((notice: { kept: number }) => void) | null>(null);
  /**
   * DEV-957 phase 2 (hardening 4): seals each sale at the moment of sale with this
   * counter's non-extractable key. In memory only; the key never leaves its store.
   */
  const sealerRef = useRef<OfflineSaleSealer | null>(null);
  useEffect(() => {
    revokedRef.current = setRevokedNotice;
  }, []);
  /** Publish the runtime's current document after one of its transitions. */
  const refresh = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setOpened((current) => (current ? { ...current, state: runtime.snapshot() } : current));
  }, []);

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
      if (cancelled()) return;
      sealerRef.current =
        record && record.deviceId === enrolled.deviceId ? counterSaleSealer(record.signingKey) : null;
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
        deps = browserCounterOfflineDeps(enrolled);
      } catch {
        return finish({
          status: 'unavailable',
          message: 'This browser blocks local storage, so offline mode is off on it.',
          state: null,
        });
      }
      const counter = await openCounterRuntime(record, deps, isOnline).catch(() => null);
      if (counter?.revoked) {
        // DEV-957 phase 2: the server confirmed the revoke. The counter's offline data is
        // gone (its unsent sales were kept for reconciling); the key, the cookie and the
        // stored page go too, and nothing can be sold here.
        counter.runtime.close();
        sealerRef.current = null;
        // Said first: forgetting the enrolment below re-renders this counter as unenrolled.
        revokedRef.current?.(counter.revoked);
        await forgetCounterEnrolment(indexedDbDeviceKeyBackend(), enrolled.organizationId).catch(
          () => undefined
        );
        await unbindCounterBrowser().catch(() => undefined);
        await clearShell();
        return;
      }
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
        const token = counter.sessionToken;
        const sign = counterReplaySigner(record.signingKey, enrolled, enrolled.deviceId);
        signerRef.current = sign;
        const queue = counter.runtime.snapshot().queue;
        if (queue?.commands.some((c) => c.status !== 'ACKNOWLEDGED')) {
          try {
            if (queue.replay === 'PAUSED_REAUTH') await counter.runtime.resume();
            const outcome = await counter.runtime.replay(
              (request) =>
                cancelled() ? Promise.resolve({ status: 0 }) : sendCounterReplay(token, request),
              sign
            );
            if (cancelled()) return;
            if (outcome.state === 'STOPPED') {
              revokedRef.current?.({ kept: outcome.discarded?.commands ?? 0 });
              await forgetCounterEnrolment(indexedDbDeviceKeyBackend(), enrolled.organizationId);
              await unbindCounterBrowser().catch(() => undefined);
              await clearShell();
              return;
            }
            if (
              outcome.state === 'PAUSED' &&
              counter.runtime.snapshot().queue?.replay === 'PAUSED_REAUTH'
            )
              message = 'Sign in again to send the waiting receipts from this counter.';
          } catch {
            message =
              'Sending stopped before this counter could confirm the result. The receipts are kept for retry.';
          }
        }
        const previousOperator = counterOperatorOf(
          counter.runtime.snapshot().catalog?.snapshots ?? []
        )?.userId;
        try {
          const report = await installCounterSnapshots(counter.runtime, counter.sessionToken, deps);
          // DEV-957 phase 2 (shared till): another person is signed in on this counter now.
          // The runtime already dropped the previous person's unfinished bills; their
          // stored page goes before this person's is stored.
          const operator = counterOperatorOf(counter.runtime.snapshot().catalog?.snapshots ?? []);
          if (previousOperator && operator && previousOperator !== operator.userId)
            await clearShell();
          if (report.refused.length)
            message =
              'Part of the signed price list failed its check and was not used. The counter keeps the last list it checked.';
        } catch (error) {
          message = counterSetupMessage(error);
          // The line dropped between establishing and downloading the list.
          if (error instanceof CounterRequestError && error.status === 0) unreachable = true;
        }
        if (!unreachable) void counterShell.armCounterShell();
      }
      if (counter.renewalFailed && !message)
        message =
          "This counter's credential could not be renewed just now. It keeps working until it expires; the counter tries again when it next opens online.";
      finish({
        status: 'ready',
        message,
        state: counter.runtime.snapshot(),
        unreachable,
        credentialExpiresAt: counter.credentialExpiresAt ?? null,
        renewalFailed: counter.renewalFailed ?? false,
      });
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
    const head = current?.state?.queue?.commands.find((c) => c.status !== 'ACKNOWLEDGED');
    if (!serverUnreachable && !(online && head && head.status !== 'QUARANTINED')) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 60_000);
    return () => window.clearTimeout(timer);
  }, [serverUnreachable, online, current]);
  const state = current?.state ?? null;
  const sellingOn = state ? offlineCashSellingOn(state) : false;
  // Review round 2: with offline cash selling off nothing is set aside, so the price check
  // lists the signed price list itself and "prepared" means only that it holds one.
  const rows = useMemo(
    () =>
      current?.state
        ? sellingOn
          ? offlineSaleRows(current.state, nowMs)
          : offlinePriceCheckRows(current.state, nowMs)
        : [],
    [current, nowMs, sellingOn]
  );
  const readiness = useMemo(() => {
    if (!current?.state) return null;
    const ready = counterOfflineReadiness(current.state, nowMs);
    return sellingOn
      ? ready
      : { ...ready, itemsAvailable: rows.length, prepared: ready.snapshotsReady };
  }, [current, nowMs, sellingOn, rows.length]);
  const operator = useMemo(
    () => (state ? counterOperatorOf(state.catalog?.snapshots ?? []) : null),
    [state]
  );
  const drafts = useMemo(
    () =>
      [...(state?.catalog?.drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state]
  );
  const queued = useMemo(
    () =>
      state?.queue ? unsettledCommands(state.queue).sort((a, b) => a.sequence - b.sequence) : [],
    [state]
  );
  const ready = current?.status === 'ready' && state !== null;
  const enrolmentName = enrolment?.name ?? '';
  const actions = useMemo<CounterOfflineActions | null>(() => {
    if (!ready) return null;
    return {
      ...(online && !serverUnreachable && sessionTokenRef.current
        ? {
            async resolveConflict(commandId: string, reason: string) {
              const runtime = runtimeRef.current;
              const token = sessionTokenRef.current;
              const signer = signerRef.current;
              if (!runtime || !token || !signer)
                throw new Error('Reconnect and sign in as a manager to review this receipt.');
              await runtime.resolveConflict(
                commandId,
                (request) => sendCounterReplay(token, request, reason),
                signer
              );
              refresh();
              setAttempt((value) => value + 1);
            },
          }
        : {}),
      async saveDraft(draft) {
        const runtime = runtimeRef.current;
        if (!runtime) return false;
        const saved = await runtime.saveDraft(draft).catch(() => false);
        refresh();
        return saved;
      },
      async discardDraft(draftId) {
        const runtime = runtimeRef.current;
        if (!runtime) return;
        await runtime.discardDrafts(draftId).catch(() => undefined);
        refresh();
      },
      async pay(draft, cashReceivedMinor) {
        const runtime = runtimeRef.current;
        if (!runtime) return { ok: false, message: offlineSaleRefusal('STORAGE') };
        const snapshot = runtime.snapshot();
        const at = Date.now();
        const sellable = offlineSaleRows(snapshot, at);
        const composed = composeOfflineCashSale({
          state: snapshot,
          rows: sellable,
          draft,
          cashReceivedMinor,
          nowMs: at,
        });
        if (!composed.ok) return composed;
        const sealer = sealerRef.current;
        if (!sealer) return { ok: false, message: offlineSaleRefusal('SEAL_FAILED') };
        // Priced before the write: the write debits the quota the rows are read from.
        const bill = priceOfflineBill(draft, sellable);
        let result;
        try {
          result = await runtime.enqueue(composed.input, composed.matrix, {
            draftId: draft.draftId,
            // Sealed now, at the moment of sale, over the whole sale (hardening 4).
            sealer,
            lineTotalsMinor: composed.lineTotalsMinor,
          });
        } catch {
          // Not written: the bill stays, no number or unit was used.
          return { ok: false, message: offlineSaleRefusal('STORAGE') };
        } finally {
          refresh();
        }
        if (!result.ok) return { ok: false, message: offlineSaleRefusal(result.reason) };
        const signed = counterOperatorOf(runtime.snapshot().catalog?.snapshots ?? []);
        const rules = runtime.payloadFor('RULES') as { branchName?: unknown } | null;
        return {
          ok: true,
          command: result.command,
          changeMinor: composed.changeMinor,
          receipt: offlineSaleReceipt({
            bill,
            receiptNumber: result.command.receiptNumber!,
            soldAt: result.command.clientOriginAt,
            cashReceivedMinor,
            counterName: enrolmentName,
            branchName:
              typeof rules?.branchName === 'string' && rules.branchName
                ? rules.branchName
                : 'Branch',
            cashierName: signed?.name ?? null,
            commandId: result.command.commandId,
          }),
        };
      },
    };
  }, [ready, refresh, enrolmentName, online, serverUnreachable]);
  const idle = {
    message: null,
    readiness: null,
    rows: [],
    nowMs,
    serverUnreachable: false,
    operator: null,
    drafts: [],
    queued: [],
    actions: null,
    revokedNotice,
    sellingOn: false,
    credentialExpiresAt: null,
    renewalFailed: false,
  };
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
    operator,
    drafts,
    queued,
    actions,
    revokedNotice,
    sellingOn,
    credentialExpiresAt: current?.credentialExpiresAt ?? null,
    renewalFailed: current?.renewalFailed ?? false,
  };
}
