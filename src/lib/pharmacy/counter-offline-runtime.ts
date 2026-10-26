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
  createMemoryDriver,
  createTerminalIndexedDbDriver,
  emptyTerminalState,
  purgeTerminalScope,
  readTerminalState,
  writeTerminalState,
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
  | { ok: false; reason: EnvelopeRejection | 'BAD_SIGNATURE'; message: string };

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
  private activeReplay: Promise<ReplayResult> | null = null;

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
    const cache = this.cache();
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
    const previousLease = this.safetyLeaseState().lease;
    const eventType = previousLease ? 'RENEWED' : 'ISSUED';
    const recalledBatchIds = recalledLotIdsFromSnapshot(input.envelope.kind, input.payload);
    const nextState: CounterRuntimeState = {
      ...this.state,
      catalog: {
        ...cache,
        snapshots: [
          ...cache.snapshots.filter((row) => row.envelope.kind !== input.envelope.kind),
          stored,
        ],
      },
      queue: {
        ...this.queue(),
        safetyLeaseEvents: [
          ...this.queue().safetyLeaseEvents,
          {
            type: eventType,
            occurredAt: input.envelope.safetyLease.issuedAt,
            lease: input.envelope.safetyLease,
            recallVersion: input.envelope.safetyLease.recallVersion,
            recalledBatchIds,
          },
        ],
      },
    };
    await this.commit(nextState);
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
    // PRICES is a complete, signed view of every lot this counter may dispense.
    // Consequently a newer snapshot replaces (rather than unions with) the
    // previous snapshot's recall set.  Bulletins issued after that snapshot are
    // incremental until the next PRICES snapshot supersedes them.
    const prices = this.cache().snapshots.find((snapshot) => snapshot.envelope.kind === 'PRICES');
    const snapshotRecallVersion = prices?.envelope.safetyLease.recallVersion ?? 0;
    const bulletinEvents = this.queue().safetyLeaseEvents.filter(
      (event) => event.type === 'RECALL_APPLIED' && event.recallVersion > snapshotRecallVersion
    );
    const snapshotRecalledIds = prices ? recalledLotIdsFromSnapshot('PRICES', prices.payload) : [];
    return {
      lease,
      appliedRecallVersion: Math.max(
        snapshotRecallVersion,
        ...bulletinEvents.map((event) => event.recallVersion)
      ),
      recalledBatchIds: [
        ...new Set([
          ...snapshotRecalledIds,
          ...bulletinEvents.flatMap((event) => event.recalledBatchIds),
        ]),
      ],
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
    await this.commit(nextState);
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
    await this.commit({ ...this.state, queue: { ...this.queue(), leases: [...leases] } });
  }

  /** Record the OFF-03 quotas this counter was granted before going offline. */
  async adoptQuotas(quotas: readonly CounterQuota[]): Promise<void> {
    await this.commit({ ...this.state, queue: { ...this.queue(), quotas: [...quotas] } });
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
        await this.commit(nextState);
      }
    }
    const batchId = input.bucket?.inventoryLotId ?? null;
    const prices = this.payloadFor('PRICES');
    const lotIsAuthoritativelyActive =
      batchId === null ||
      (Array.isArray(prices) &&
        prices.some(
          (lot) =>
            typeof lot === 'object' &&
            lot !== null &&
            (lot as { id?: unknown }).id === batchId &&
            (lot as { manufacturingBatch?: { state?: unknown } }).manufacturingBatch?.state ===
              'ACTIVE'
        ));
    const result = enqueueCounterCommand(this.queue(), input, {
      ...matrix,
      snapshots: this.cachedSnapshotStates(),
      safetyLeaseOk: leaseCheck.ok,
      // Missing or unrecognized state is unsafe: only an explicit ACTIVE state
      // in the signed snapshot permits dispensing.
      batchRecalled:
        !lotIsAuthoritativelyActive ||
        (batchId !== null && leaseState.recalledBatchIds.includes(batchId)),
    });
    if (!result.ok) return result;
    await this.commit({ ...this.state, queue: result.snapshot });
    return result;
  }

  async resume(): Promise<void> {
    await this.commit({ ...this.state, queue: resumeCounterAfterReauth(this.queue()) });
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
      const next = nextCounterReplay(this.queue(), this.scope.deviceId);
      if (next.status !== 'READY') return { state: next.status, discarded: null };

      const request = buildCounterReplayRequest(this.queue(), next.command);
      await this.commit({
        ...this.state,
        queue: beginCounterReplay(this.queue(), next.command.commandId),
      });

      let response: CounterReplayResponse;
      try {
        response = await send(request);
      } catch {
        response = { status: 0 };
      }
      const outcome = classifyReplayOutcome(response);
      const applied = applyCounterReplayOutcome(this.queue(), {
        commandId: next.command.commandId,
        outcome,
        serverRef: response.serverRef,
      });
      const nextState = { ...this.state, queue: applied.snapshot };

      if (applied.snapshot.replay === 'STOPPED_REVOKED') {
        this.state = nextState;
        await purgeTerminalScope(this.driver, this.scope);
        return { state: 'STOPPED', discarded: applied.discarded };
      }
      await this.commit(nextState);
      if (outcome.action !== 'ACK') return { state: 'PAUSED', discarded: applied.discarded };
    }
  }

  /** Confirmed revocation outside a replay (a heartbeat said so). */
  async revoke(): Promise<{ commands: number } | null> {
    const purged = purgeCounterQueue(this.queue());
    this.state = { ...this.state, queue: purged.snapshot };
    await purgeTerminalScope(this.driver, this.scope);
    return purged.discarded;
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

  /** Publish a state transition only after its whole-document write succeeds. */
  private async commit(nextState: CounterRuntimeState): Promise<void> {
    await writeTerminalState(this.driver, nextState, COUNTER_STORE_SCHEMA_VERSION);
    this.state = nextState;
  }
}

/** Batch state travels inside the signed PRICES payload so a disconnected
 * counter can reject any lot that is not explicitly active before replay. */
function recalledLotIdsFromSnapshot(kind: PharmacyOfflineSnapshotKind, payload: unknown): string[] {
  if (kind !== 'PRICES' || !Array.isArray(payload)) return [];
  return payload.flatMap((lot) => {
    if (
      typeof lot === 'object' &&
      lot !== null &&
      typeof (lot as { id?: unknown }).id === 'string' &&
      (lot as { manufacturingBatch?: { state?: unknown } }).manufacturingBatch?.state !== 'ACTIVE'
    )
      return [(lot as { id: string }).id];
    return [];
  });
}
