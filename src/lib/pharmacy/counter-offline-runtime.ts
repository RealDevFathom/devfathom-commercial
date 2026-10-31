/**
 * PH-OFF / OFF-01 — the pharmacy counter's offline runtime.
 *
 * The sole impure adapter between the counter surface, the neutral
 * retail-terminal local store, and the pure queue transitions. It owns three
 * jobs and delegates everything else:
 *
 *  1. **Hydrate and persist** one scope-partitioned document through the
 *     retail-terminal seam. Snapshots, the command queue, the receipt leases and
 *     the OFF-03 quotas live in that single document, so every write is atomic
 *     and the storage-minimization denylist walks all of it. A document written
 *     by another counter, another branch or another schema version fails closed.
 *  2. **Install signed snapshots.** Everything decidable without the key is
 *     decided here (scope, window, version monotonicity, payload hash); the
 *     signature itself is the injected `SnapshotVerifier` — the server and the
 *     tests use the Node Ed25519 one, a browser surface supplies a WebCrypto one.
 *     A snapshot that fails ANY of those is not stored, so the OFF-02 matrix can
 *     never read an unverified snapshot as satisfied.
 *  3. **Replay the outbox**, one command at a time, in the counter's own FIFO
 *     order, with the classification rule shared with the Restaurant POS.
 *
 * WHAT IS NOT STORED. The signing key is asymmetric, so the counter holds only a
 * public key — and the denylist would refuse anything named like a secret,
 * credential or customer field anyway. Payloads are held as composed; the
 * enforcement is the guard on every write, not a promise in a comment.
 */
import {
  assertPersistSafe,
  createMemoryDriver,
  createTerminalIndexedDbDriver,
  emptyTerminalState,
  readTerminalState,
  terminalScopeKey,
} from '@/lib/retail-terminal/local-store';
import type {
  PersistedTerminalState,
  TerminalScope,
  TerminalStorageDriver,
  TerminalStoreDatabase,
} from '@/lib/retail-terminal/local-store';
import { classifyReplayOutcome } from '@/lib/retail-terminal/replay-outcome';

import {
  applyCounterReplayOutcome,
  beginCounterReplay,
  buildCounterReplayRequest,
  createCounterQueue,
  enqueueCounterCommand,
  nextCounterReplay,
  purgeCounterQueue,
  resumeCounterAfterReauth,
} from './counter-command-queue';
import type {
  CounterCommandInput,
  CounterEnqueueResult,
  CounterLeaseCursor,
  CounterMatrixInputs,
  CounterQueueSnapshot,
  CounterQuota,
  CounterReplayRequest,
} from './counter-command-queue';
import type { CachedSnapshotState, PharmacyOfflineSnapshotKind } from './offline-action-matrix';
import { checkEnvelope } from './offline-snapshot-envelope';
import type { EnvelopeRejection, OfflineSnapshotEnvelope } from './offline-snapshot-envelope';
import { applyRecallBulletin, checkSafetyLease } from './offline-safety-lease';
import type { OfflineRecallBulletin, SafetyLeaseState } from './offline-safety-lease';

/** Bump when the persisted document shape changes; an older record fails closed. */
export const COUNTER_STORE_SCHEMA_VERSION = 2;

export const COUNTER_STORE_DATABASE: TerminalStoreDatabase = {
  // A distinct database name from the Restaurant POS: a device enrolled in both
  // cannot read the other's documents even before the scope check runs.
  databaseName: 'devfathom-pharmacy-counter',
  objectStoreName: 'scope-state',
  schemaVersion: COUNTER_STORE_SCHEMA_VERSION,
};

export function createCounterIndexedDbDriver(
  factory: IDBFactory | null = null
): TerminalStorageDriver {
  return createTerminalIndexedDbDriver(COUNTER_STORE_DATABASE, factory);
}

export { createMemoryDriver };

/** One verified snapshot exactly as the counter keeps it. */
export type StoredCounterSnapshot = {
  envelope: OfflineSnapshotEnvelope;
  signature: string;
  payload: unknown;
  /** Set only after the injected verifier accepted the envelope. */
  verified: boolean;
};

export type CounterCache = {
  /** The Ed25519 public key the counter verifies envelopes against. Not a secret. */
  snapshotPublicKey: string;
  snapshots: StoredCounterSnapshot[];
};

export type CounterRuntimeState = PersistedTerminalState<CounterQueueSnapshot, CounterCache>;

/** The cryptographic half of snapshot verification, injected. */
export interface SnapshotVerifier {
  verify(input: {
    envelope: OfflineSnapshotEnvelope;
    signature: string;
    publicKey: string;
  }): Promise<boolean> | boolean;
}

export type InstallSnapshotResult =
  | { ok: true; snapshot: StoredCounterSnapshot }
  | { ok: false; reason: EnvelopeRejection | 'BAD_SIGNATURE' | 'DEVICE_REVOKED'; message: string };

export type CounterReplayResponse = {
  status: number;
  serverMessage?: string;
  retryAfter?: string | null;
  serverRef?: string | null;
};

type ReplayResult = {
  state: 'IDLE' | 'PAUSED' | 'STOPPED' | 'REFUSED';
  discarded: { commands: number } | null;
};

export class PharmacyCounterRuntime {
  private state: CounterRuntimeState;
  private persistedState: CounterRuntimeState | undefined;
  private activeReplay: Promise<ReplayResult> | null = null;
  /**
   * Enqueue is a read-modify-write of the one persisted counter document. Keep
   * those transitions in invocation order so two UI events cannot allocate
   * from the same lease/quota snapshot while the first write is in flight.
   */
  private enqueueTail: Promise<void> = Promise.resolve();

  constructor(
    readonly scope: TerminalScope,
    private readonly driver: TerminalStorageDriver,
    private readonly verifier: SnapshotVerifier,
    snapshotPublicKey: string
  ) {
    this.state = emptyTerminalState<CounterQueueSnapshot, CounterCache>(
      scope,
      COUNTER_STORE_SCHEMA_VERSION
    );
    this.state.queue = createCounterQueue(scope.deviceId);
    this.state.catalog = { snapshotPublicKey, snapshots: [] };
  }

  snapshot(): CounterRuntimeState {
    return this.state;
  }

  /**
   * Load this counter's document. A queue that names another device is
   * `unrecoverable` rather than adopted — queued money and stock work is never
   * rebound to a replacement counter.
   */
  async hydrate(): Promise<'ready' | 'unrecoverable'> {
    const result = await readTerminalState<CounterQueueSnapshot, CounterCache>(
      this.driver,
      this.scope,
      COUNTER_STORE_SCHEMA_VERSION
    );
    if (result.status === 'unrecoverable') return 'unrecoverable';
    if (result.status === 'ok') {
      if (result.state.queue && result.state.queue.deviceId !== this.scope.deviceId) {
        return 'unrecoverable';
      }
      this.state = {
        ...result.state,
        queue: result.state.queue ?? createCounterQueue(this.scope.deviceId),
        catalog: result.state.catalog ?? this.cache(),
      };
      this.persistedState = result.state;
    } else {
      // Hydration can be repeated on a long-lived runtime. If another context
      // revoked and removed this counter, do not keep exposing its stale
      // leases, quotas, or verified snapshots from an earlier hydration.
      const snapshotPublicKey = this.cache().snapshotPublicKey;
      this.state = emptyTerminalState<CounterQueueSnapshot, CounterCache>(
        this.scope,
        COUNTER_STORE_SCHEMA_VERSION
      );
      this.state.queue = createCounterQueue(this.scope.deviceId);
      this.state.catalog = { snapshotPublicKey, snapshots: [] };
      this.persistedState = undefined;
    }
    return 'ready';
  }

  /**
   * Verify and install one signed snapshot. Ordered so the cheap, key-free
   * checks run first and the signature check runs last — and so a snapshot that
   * fails any of them is NOT stored, which is what lets the OFF-02 matrix treat
   * "present in the cache" as "verified and in window".
   */
  async installSnapshot(input: {
    envelope: OfflineSnapshotEnvelope;
    signature: string;
    payload: unknown;
    payloadHash: string;
    nowMs: number;
  }): Promise<InstallSnapshotResult> {
    return this.installSnapshotTransition(input, false);
  }

  private async installSnapshotTransition(
    input: {
      envelope: OfflineSnapshotEnvelope;
      signature: string;
      payload: unknown;
      payloadHash: string;
      nowMs: number;
    },
    rejectMissing: boolean
  ): Promise<InstallSnapshotResult> {
    try {
      return await this.installSnapshotOnce(input, rejectMissing);
    } catch (error) {
      if (error instanceof CounterStorageConflictError) {
        // Verification may take long enough for another context to publish a
        // newer snapshot. Re-read and repeat every check rather than applying
        // a replacement derived from the stale document. Once a CAS has
        // conflicted, however, absence is a revocation boundary rather than a
        // fresh scope that this in-flight installation may recreate.
        return this.installSnapshotTransition(input, true);
      }
      throw error;
    }
  }

  private async installSnapshotOnce(
    input: {
      envelope: OfflineSnapshotEnvelope;
      signature: string;
      payload: unknown;
      payloadHash: string;
      nowMs: number;
    },
    rejectMissing: boolean
  ): Promise<InstallSnapshotResult> {
    const durable = await readTerminalState<CounterQueueSnapshot, CounterCache>(
      this.driver,
      this.scope,
      COUNTER_STORE_SCHEMA_VERSION
    );
    if (durable.status === 'unrecoverable') throw new Error(durable.message);
    if (durable.status === 'ok' && durable.state.queue?.replay === 'STOPPED_REVOKED') {
      this.adoptRevokedState(durable.state);
      return {
        ok: false,
        reason: 'DEVICE_REVOKED',
        message: 'This counter has been revoked and cannot install snapshots.',
      };
    }
    if (durable.status === 'empty' && rejectMissing) {
      const snapshotPublicKey = this.cache().snapshotPublicKey;
      this.state = emptyTerminalState<CounterQueueSnapshot, CounterCache>(
        this.scope,
        COUNTER_STORE_SCHEMA_VERSION
      );
      this.state.queue = createCounterQueue(this.scope.deviceId);
      this.state.catalog = { snapshotPublicKey, snapshots: [] };
      this.persistedState = undefined;
      return {
        ok: false,
        reason: 'DEVICE_REVOKED',
        message: 'This counter was removed while the snapshot was being installed.',
      };
    }

    const expectedState = durable.status === 'ok' ? durable.state : undefined;
    const sourceState: CounterRuntimeState =
      durable.status === 'ok'
        ? {
            ...durable.state,
            queue: durable.state.queue ?? createCounterQueue(this.scope.deviceId),
            catalog: durable.state.catalog ?? this.cache(),
          }
        : {
            ...emptyTerminalState<CounterQueueSnapshot, CounterCache>(
              this.scope,
              COUNTER_STORE_SCHEMA_VERSION
            ),
            queue: createCounterQueue(this.scope.deviceId),
            catalog: { snapshotPublicKey: this.cache().snapshotPublicKey, snapshots: [] },
          };
    const cache = sourceState.catalog ?? { snapshotPublicKey: '', snapshots: [] };
    const held = cache.snapshots.find((stored) => stored.envelope.kind === input.envelope.kind);
    const envelopeCheck = checkEnvelope({
      envelope: input.envelope,
      scope: this.scope,
      nowMs: input.nowMs,
      heldVersion: held?.envelope.version ?? null,
      payloadHash: input.payloadHash,
    });
    if (!envelopeCheck.ok) {
      return { ok: false, reason: envelopeCheck.reason, message: envelopeCheck.message };
    }

    const signatureOk = await this.verifier.verify({
      envelope: input.envelope,
      signature: input.signature,
      publicKey: cache.snapshotPublicKey,
    });
    if (!signatureOk) {
      return {
        ok: false,
        reason: 'BAD_SIGNATURE',
        message: 'This snapshot failed signature verification and will not be used.',
      };
    }

    const stored: StoredCounterSnapshot = {
      envelope: input.envelope,
      signature: input.signature,
      payload: input.payload,
      verified: true,
    };
    const queue = sourceState.queue ?? createCounterQueue(this.scope.deviceId);
    const leases = cache.snapshots.map((snapshot) => snapshot.envelope.safetyLease);
    const previousLease =
      leases.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0] ?? null;
    const eventType = previousLease ? 'RENEWED' : 'ISSUED';
    const nextState: CounterRuntimeState = {
      ...sourceState,
      catalog: {
        ...cache,
        snapshots: [
          ...cache.snapshots.filter((row) => row.envelope.kind !== input.envelope.kind),
          stored,
        ],
      },
      queue: {
        ...queue,
        safetyLeaseEvents: [
          ...queue.safetyLeaseEvents,
          {
            type: eventType,
            occurredAt: input.envelope.safetyLease.issuedAt,
            lease: input.envelope.safetyLease,
            recallVersion: input.envelope.safetyLease.recallVersion,
            recalledBatchIds: [],
          },
        ],
      },
    };
    await this.commit(nextState, expectedState);
    return { ok: true, snapshot: stored };
  }

  /** The matrix's view of the cache: kind, verified, and the signed expiry. */
  cachedSnapshotStates(): CachedSnapshotState[] {
    return this.cache().snapshots.map((stored) => ({
      kind: stored.envelope.kind,
      verified: stored.verified,
      expiresAtMs: Date.parse(stored.envelope.expiresAt),
    }));
  }

  payloadFor(kind: PharmacyOfflineSnapshotKind): unknown {
    return this.cache().snapshots.find((stored) => stored.envelope.kind === kind)?.payload ?? null;
  }

  safetyLeaseState(): SafetyLeaseState {
    const leases = this.cache().snapshots.map((snapshot) => snapshot.envelope.safetyLease);
    const lease = leases.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0] ?? null;
    const recallEvents = this.queue().safetyLeaseEvents.filter(
      (event) => event.type === 'RECALL_APPLIED'
    );
    return {
      lease,
      appliedRecallVersion: Math.max(0, ...recallEvents.map((event) => event.recallVersion)),
      recalledBatchIds: [...new Set(recallEvents.flatMap((event) => event.recalledBatchIds))],
    };
  }

  /** Apply the reconnect bulletin before allowing another sale. */
  async applyRecallBulletin(bulletin: OfflineRecallBulletin): Promise<boolean> {
    const current = this.safetyLeaseState();
    const applied = applyRecallBulletin(current, bulletin);
    if (!applied || !applied.lease) return false;
    const nextState: CounterRuntimeState = {
      ...this.state,
      queue: {
        ...this.queue(),
        safetyLeaseEvents: [
          ...this.queue().safetyLeaseEvents,
          {
            type: 'RECALL_APPLIED',
            occurredAt: bulletin.issuedAt,
            lease: applied.lease,
            recallVersion: bulletin.recallVersion,
            recalledBatchIds: bulletin.recalledBatchIds,
          },
        ],
      },
    };
    await this.commit(nextState, this.persistedState);
    return true;
  }

  counterStatus(nowMs: number) {
    const state = this.safetyLeaseState();
    const check = checkSafetyLease(state, nowMs);
    return {
      safetyLease: state.lease,
      safetyLeaseStatus: check.ok ? ('ACTIVE' as const) : check.reason,
      appliedRecallVersion: state.appliedRecallVersion,
    };
  }

  /** Record the receipt-number blocks this counter reserved before going offline. */
  async adoptLeases(leases: readonly CounterLeaseCursor[]): Promise<void> {
    await this.commit(
      { ...this.state, queue: { ...this.queue(), leases: [...leases] } },
      this.persistedState
    );
  }

  /** Record the OFF-03 quotas this counter was granted before going offline. */
  async adoptQuotas(quotas: readonly CounterQuota[]): Promise<void> {
    await this.commit(
      { ...this.state, queue: { ...this.queue(), quotas: [...quotas] } },
      this.persistedState
    );
  }

  /**
   * Compose one command. The OFF-02 decision is evaluated against the CACHED
   * snapshot states rather than anything the caller supplies, so a surface
   * cannot talk the matrix into accepting a snapshot the runtime never verified.
   */
  async enqueue(
    input: CounterCommandInput,
    matrix: Omit<CounterMatrixInputs, 'snapshots'>
  ): Promise<CounterEnqueueResult> {
    const result = this.enqueueTail.then(() => this.enqueueTransition(input, matrix));
    // A failed persistence attempt must reject its caller without poisoning the
    // queue: a later attempt still gets to evaluate the last published state.
    this.enqueueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async enqueueTransition(
    input: CounterCommandInput,
    matrix: Omit<CounterMatrixInputs, 'snapshots'>
  ): Promise<CounterEnqueueResult> {
    try {
      return await this.enqueueTransitionOnce(input, matrix);
    } catch (error) {
      if (error instanceof CounterStorageConflictError) {
        return this.enqueueTransition(input, matrix);
      }
      throw error;
    }
  }

  private async enqueueTransitionOnce(
    input: CounterCommandInput,
    matrix: Omit<CounterMatrixInputs, 'snapshots'>
  ): Promise<CounterEnqueueResult> {
    // Refresh before deriving identifiers. The compare-and-swap in commit then
    // closes the gap between this read and the write across tabs/processes.
    const durable = await readTerminalState<CounterQueueSnapshot, CounterCache>(
      this.driver,
      this.scope,
      COUNTER_STORE_SCHEMA_VERSION
    );
    if (durable.status === 'unrecoverable') {
      throw new Error(durable.message);
    }
    if (durable.status === 'ok') {
      this.state = {
        ...durable.state,
        queue: durable.state.queue ?? createCounterQueue(this.scope.deviceId),
        catalog: durable.state.catalog ?? this.cache(),
      };
      this.persistedState = durable.state;
    } else {
      // A missing document may mean another tab confirmed revocation and
      // purged this scope. Discard every hydrated lease, snapshot and quota so
      // this tab cannot recreate the revoked counter from stale live state.
      const snapshotPublicKey = this.cache().snapshotPublicKey;
      this.state = emptyTerminalState<CounterQueueSnapshot, CounterCache>(
        this.scope,
        COUNTER_STORE_SCHEMA_VERSION
      );
      this.state.queue = createCounterQueue(this.scope.deviceId);
      this.state.catalog = { snapshotPublicKey, snapshots: [] };
      this.persistedState = undefined;
    }
    if (this.queue().replay === 'STOPPED_REVOKED') {
      return {
        ok: false,
        reason: 'DEVICE_REVOKED',
        message: 'This counter has been revoked and cannot queue offline work.',
        decision: null,
      };
    }
    const leaseState = this.safetyLeaseState();
    const leaseCheck = checkSafetyLease(leaseState, matrix.nowMs);
    if (!leaseCheck.ok && leaseCheck.reason === 'EXPIRED') {
      const alreadyLogged = this.queue().safetyLeaseEvents.some(
        (event) => event.type === 'EXPIRED' && event.lease.expiresAt === leaseState.lease?.expiresAt
      );
      if (leaseState.lease && !alreadyLogged) {
        const nextState: CounterRuntimeState = {
          ...this.state,
          queue: {
            ...this.queue(),
            safetyLeaseEvents: [
              ...this.queue().safetyLeaseEvents,
              {
                type: 'EXPIRED',
                occurredAt: new Date(matrix.nowMs).toISOString(),
                lease: leaseState.lease,
                recallVersion: leaseState.appliedRecallVersion,
                recalledBatchIds: [],
              },
            ],
          },
        };
        await this.commit(nextState, this.persistedState);
      }
    }
    const batchId = input.bucket?.inventoryLotId ?? null;
    const result = enqueueCounterCommand(this.queue(), input, {
      ...matrix,
      snapshots: this.cachedSnapshotStates(),
      safetyLeaseOk: leaseCheck.ok,
      batchRecalled: batchId !== null && leaseState.recalledBatchIds.includes(batchId),
    });
    if (!result.ok) return result;
    await this.commit({ ...this.state, queue: result.snapshot }, this.persistedState);
    return result;
  }

  async resume(): Promise<void> {
    await this.commit(
      { ...this.state, queue: resumeCounterAfterReauth(this.queue()) },
      this.persistedState
    );
  }

  replay(
    send: (request: CounterReplayRequest) => Promise<CounterReplayResponse>
  ): Promise<ReplayResult> {
    if (this.activeReplay) return this.activeReplay;
    const replay = this.runReplay(send);
    this.activeReplay = replay;
    const clear = () => {
      if (this.activeReplay === replay) this.activeReplay = null;
    };
    void replay.then(clear, clear);
    return replay;
  }

  private async runReplay(
    send: (request: CounterReplayRequest) => Promise<CounterReplayResponse>
  ): Promise<ReplayResult> {
    for (;;) {
      if ((await this.hydrate()) === 'unrecoverable') {
        return { state: 'REFUSED', discarded: null };
      }
      const next = nextCounterReplay(this.queue(), this.scope.deviceId);
      if (next.status !== 'READY') return { state: next.status, discarded: null };

      const request = buildCounterReplayRequest(this.queue(), next.command);
      try {
        await this.commit(
          {
            ...this.state,
            queue: beginCounterReplay(this.queue(), next.command.commandId),
          },
          this.persistedState
        );
      } catch (error) {
        if (error instanceof CounterStorageConflictError) continue;
        throw error;
      }

      let response: CounterReplayResponse;
      try {
        response = await send(request);
      } catch {
        response = { status: 0 };
      }
      const outcome = classifyReplayOutcome(response);
      if (outcome.action === 'PURGE') {
        // Revocation must purge the latest durable document, including work
        // queued in another context while this request was in flight.
        return { state: 'STOPPED', discarded: await this.revoke() };
      }
      for (;;) {
        if ((await this.hydrate()) === 'unrecoverable') {
          return { state: 'REFUSED', discarded: null };
        }
        if (this.queue().replay === 'STOPPED_REVOKED') {
          return { state: 'STOPPED', discarded: null };
        }
        const command = this.queue().commands.find(
          (command) => command.commandId === next.command.commandId
        );
        // Another replay may already have settled this command. A late retry
        // or re-auth response must not return it to the pending queue.
        if (!command || command.status === 'ACKNOWLEDGED' || command.status === 'QUARANTINED') {
          break;
        }
        const applied = applyCounterReplayOutcome(this.queue(), {
          commandId: next.command.commandId,
          outcome,
          serverRef: response.serverRef,
        });
        try {
          await this.commit({ ...this.state, queue: applied.snapshot }, this.persistedState);
          break;
        } catch (error) {
          if (!(error instanceof CounterStorageConflictError)) throw error;
        }
      }
      if (outcome.action !== 'ACK') return { state: 'PAUSED', discarded: null };
    }
  }

  /** Confirmed revocation outside a replay (a heartbeat said so). */
  async revoke(): Promise<{ commands: number } | null> {
    for (;;) {
      const durable = await readTerminalState<CounterQueueSnapshot, CounterCache>(
        this.driver,
        this.scope,
        COUNTER_STORE_SCHEMA_VERSION
      );
      if (durable.status === 'unrecoverable') throw new Error(durable.message);
      if (durable.status === 'ok' && durable.state.queue?.replay === 'STOPPED_REVOKED') {
        this.adoptRevokedState(durable.state);
        return null;
      }
      const source = durable.status === 'ok' ? durable.state : this.state;
      const purged = purgeCounterQueue(source.queue ?? createCounterQueue(this.scope.deviceId));
      const tombstone: CounterRuntimeState = {
        ...source,
        catalog: { snapshotPublicKey: '', snapshots: [] },
        queue: purged.snapshot,
      };
      try {
        await this.commit(tombstone, durable.status === 'ok' ? durable.state : undefined);
        return purged.discarded;
      } catch (error) {
        if (!(error instanceof CounterStorageConflictError)) throw error;
      }
    }
  }

  close(): void {
    this.driver.close();
  }

  private queue(): CounterQueueSnapshot {
    return this.state.queue ?? createCounterQueue(this.scope.deviceId);
  }

  private cache(): CounterCache {
    return this.state.catalog ?? { snapshotPublicKey: '', snapshots: [] };
  }

  private adoptRevokedState(state: CounterRuntimeState): void {
    this.state = {
      ...state,
      catalog: state.catalog ?? {
        snapshotPublicKey: this.cache().snapshotPublicKey,
        snapshots: [],
      },
      queue: state.queue ?? purgeCounterQueue(createCounterQueue(this.scope.deviceId)).snapshot,
    };
    this.persistedState = state;
  }

  /** Publish a state transition only after its whole-document write succeeds. */
  private async commit(
    nextState: CounterRuntimeState,
    expectedState: CounterRuntimeState | undefined
  ): Promise<void> {
    // Keep the storage seam's fail-closed validation, but use a transaction CAS
    // to prevent a stale tab overwriting a newer whole document.
    if (nextState.schemaVersion !== COUNTER_STORE_SCHEMA_VERSION) {
      throw new CounterStorageConflictError();
    }
    assertPersistSafe(nextState);
    const written = await this.driver.compareAndSwap(
      terminalScopeKey(this.scope),
      expectedState,
      nextState
    );
    if (!written) throw new CounterStorageConflictError();
    this.state = nextState;
    this.persistedState = nextState;
  }
}

class CounterStorageConflictError extends Error {
  constructor() {
    super('Counter state changed in another browser context. Retry the operation.');
    this.name = 'CounterStorageConflictError';
  }
}
