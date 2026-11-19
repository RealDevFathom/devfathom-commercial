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
  remainingReceiptNumbers,
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
  CounterReplaySigner,
} from './counter-command-queue';
import type { CachedSnapshotState, PharmacyOfflineSnapshotKind } from './offline-action-matrix';
import { checkEnvelope } from './offline-snapshot-envelope';
import type { EnvelopeRejection, OfflineSnapshotEnvelope } from './offline-snapshot-envelope';
import { applyRecallBulletin, checkSafetyLease } from './offline-safety-lease';
import { validateManualTenderPolicy } from './manual-payments';
import type { OfflineRecallBulletin, SafetyLeaseState } from './offline-safety-lease';

/**
 * Bump when the persisted document shape changes; an unknown record fails closed.
 * DEV-957 phase 2: version 3 adds the offline bills being built (`catalog.drafts`).
 * A version-2 document (phase 1: snapshots, leases and quotas, never a sale) is
 * upgraded in place on hydrate; nothing else is.
 */
export const COUNTER_STORE_SCHEMA_VERSION = 3;
const COUNTER_STORE_PREVIOUS_SCHEMA_VERSION = 2;

export const COUNTER_STORE_DATABASE: TerminalStoreDatabase = {
  // A distinct database name from the Restaurant POS: a device enrolled in both
  // cannot read the other's documents even before the scope check runs.
  databaseName: 'devfathom-pharmacy-counter',
  objectStoreName: 'scope-state',
  // The IndexedDB database version, which only creates the object store. It stays at 2:
  // the document's own version above is what changed, and raising this would block on
  // any counter tab still open with the old version.
  schemaVersion: 2,
};

/** Bills a counter holds at once while offline. */
export const MAX_OFFLINE_DRAFTS = 5;
/** Lines on one offline bill; the replay schema accepts at most 50. */
export const MAX_OFFLINE_DRAFT_LINES = 50;

/**
 * DEV-957 phase 2: one line of an offline bill as it is kept locally. Identifiers and
 * counts only: the name and the price are read again from the verified snapshots each
 * time the bill is shown or paid, so a stored draft can never carry a price of its own.
 */
export type CounterDraftLine = {
  inventoryLotId: string;
  stockLocationId: string;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  saleUnit: 'PACK' | 'STRIP' | 'UNIT';
  canonicalUnitsPerSaleUnit: number;
  quantity: number;
};

/** An offline bill being built, saved on every change so a reload brings it back. */
export type CounterDraft = {
  draftId: string;
  /** The cashier the counter's signed rules name (who the sale is attributed to). */
  operatorUserId: string | null;
  updatedAt: string;
  lines: CounterDraftLine[];
};

const SALE_UNITS = new Set(['PACK', 'STRIP', 'UNIT']);
const ID = /^[A-Za-z0-9_:-]{1,160}$/;

/**
 * The allowlist projection every stored draft passes through: exactly the fields above,
 * each checked, so nothing else a caller attached (a name, a price, a customer) is ever
 * written. The local store's forbidden-field guard still walks the whole document.
 */
export function projectCounterDraft(value: unknown): CounterDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.draftId !== 'string' || !ID.test(draft.draftId)) return null;
  if (draft.operatorUserId !== null && (typeof draft.operatorUserId !== 'string' || !ID.test(draft.operatorUserId)))
    return null;
  if (typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt))) return null;
  if (!Array.isArray(draft.lines) || draft.lines.length > MAX_OFFLINE_DRAFT_LINES) return null;
  const lines: CounterDraftLine[] = [];
  for (const raw of draft.lines) {
    if (!raw || typeof raw !== 'object') return null;
    const line = raw as Record<string, unknown>;
    const ids = ['inventoryLotId', 'stockLocationId', 'medicineId', 'presentationId', 'packLevelId'] as const;
    if (ids.some((key) => typeof line[key] !== 'string' || !ID.test(line[key] as string))) return null;
    if (typeof line.saleUnit !== 'string' || !SALE_UNITS.has(line.saleUnit)) return null;
    for (const key of ['canonicalUnitsPerSaleUnit', 'quantity'] as const) {
      const count = line[key];
      if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > 10_000) return null;
    }
    lines.push({
      inventoryLotId: line.inventoryLotId as string,
      stockLocationId: line.stockLocationId as string,
      medicineId: line.medicineId as string,
      presentationId: line.presentationId as string,
      packLevelId: line.packLevelId as string,
      saleUnit: line.saleUnit as CounterDraftLine['saleUnit'],
      canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit as number,
      quantity: line.quantity as number,
    });
  }
  return {
    draftId: draft.draftId,
    operatorUserId: (draft.operatorUserId as string | null) ?? null,
    updatedAt: draft.updatedAt,
    lines,
  };
}

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
  /** DEV-957 phase 2: offline bills being built (allowlist projection only). */
  drafts?: CounterDraft[];
};

/** The cashier the counter's verified RULES snapshot names, if any. */
export function counterOperatorOf(
  snapshots: readonly StoredCounterSnapshot[]
): { userId: string; name: string | null } | null {
  const rules = snapshots.find((stored) => stored.envelope.kind === 'RULES' && stored.verified);
  const operator =
    rules?.payload && typeof rules.payload === 'object'
      ? (rules.payload as { operator?: unknown }).operator
      : null;
  if (!operator || typeof operator !== 'object') return null;
  const { userId, name } = operator as { userId?: unknown; name?: unknown };
  if (typeof userId !== 'string' || !userId) return null;
  return { userId, name: typeof name === 'string' && name.trim() ? name.trim() : null };
}

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

/**
 * DEV-712: reserve one more block of receipt numbers for this counter. The surface supplies
 * the transport (`POST /api/pharmacy/counter/lease`); the server answers with the lease row.
 */
export type CounterLeaseReserver = (size: number) => Promise<unknown>;

/** Renew when fewer than this many reserved numbers are left. */
export const COUNTER_LEASE_LOW_WATER = 20;
/** Numbers reserved per renewal; the server caps a block at 1,000. */
export const COUNTER_LEASE_RENEWAL_SIZE = 100;
/** How often the background renewal re-checks the runway while the counter is open. */
export const COUNTER_LEASE_RENEWAL_INTERVAL_MS = 60_000;

export type LeaseRenewalResult = {
  status: 'SUFFICIENT' | 'RENEWED' | 'FAILED' | 'STOPPED';
  /** Unissued reserved numbers after this attempt. */
  remaining: number;
};

/** The server's lease row, checked before it is trusted as this counter's runway. */
function leaseCursor(value: unknown, deviceId: string): CounterLeaseCursor | null {
  if (!value || typeof value !== 'object') return null;
  const lease = value as Record<string, unknown>;
  const { id, blockStart, blockEnd, nextNumber } = lease;
  if (
    typeof id !== 'string' ||
    !id ||
    lease.deviceId !== deviceId ||
    !Number.isSafeInteger(blockStart) ||
    !Number.isSafeInteger(blockEnd) ||
    !Number.isSafeInteger(nextNumber)
  )
    return null;
  const start = blockStart as number;
  const end = blockEnd as number;
  const next = nextNumber as number;
  if (start <= 0 || end < start || next < start || next > end + 1) return null;
  return { leaseId: id, blockStart: start, blockEnd: end, nextNumber: next };
}

type ReplayResult = {
  state: 'IDLE' | 'PAUSED' | 'STOPPED' | 'REFUSED';
  discarded: { commands: number } | null;
};

export class PharmacyCounterRuntime {
  private state: CounterRuntimeState;
  private activeReplay: Promise<ReplayResult> | null = null;
  private activeLeaseRenewal: Promise<LeaseRenewalResult> | null = null;
  /**
   * #554: the tail of the single-flight transition chain. Every read-compute-
   * write of the persisted document runs behind it, so two overlapping calls
   * (two quick sales, a sale during replay) never derive from the same snapshot
   * — which would hand out the same receipt/sequence and let the later
   * whole-document write erase the earlier command.
   */
  private transitions: Promise<unknown> = Promise.resolve();

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
  hydrate(): Promise<'ready' | 'unrecoverable'> {
    return this.exclusive(() => this.hydrateNow());
  }

  private async hydrateNow(): Promise<'ready' | 'unrecoverable'> {
    let result = await readTerminalState<CounterQueueSnapshot, CounterCache>(
      this.driver,
      this.scope,
      COUNTER_STORE_SCHEMA_VERSION
    );
    if (
      result.status === 'unrecoverable' &&
      result.reason === 'SCHEMA_VERSION' &&
      result.foundSchemaVersion === COUNTER_STORE_PREVIOUS_SCHEMA_VERSION
    ) {
      // DEV-957 phase 2: a phase-1 document gains an empty draft list and is written back
      // at the new version. Its queue, leases, quotas and snapshots are kept as they are.
      const previous = await readTerminalState<CounterQueueSnapshot, CounterCache>(
        this.driver,
        this.scope,
        COUNTER_STORE_PREVIOUS_SCHEMA_VERSION
      );
      if (previous.status !== 'ok') return 'unrecoverable';
      if (previous.state.queue && previous.state.queue.deviceId !== this.scope.deviceId)
        return 'unrecoverable';
      const upgraded: CounterRuntimeState = {
        ...previous.state,
        schemaVersion: COUNTER_STORE_SCHEMA_VERSION,
        catalog: previous.state.catalog
          ? { ...previous.state.catalog, drafts: [] }
          : previous.state.catalog,
      };
      await writeTerminalState(this.driver, upgraded, COUNTER_STORE_SCHEMA_VERSION);
      result = { status: 'ok', state: upgraded, revision: 0 };
    }
    if (result.status === 'unrecoverable') return 'unrecoverable';
    if (result.status === 'ok') {
      if (result.state.queue && result.state.queue.deviceId !== this.scope.deviceId) {
        return 'unrecoverable';
      }
      const catalog = result.state.catalog ?? this.cache();
      this.state = {
        ...result.state,
        queue: result.state.queue ?? createCounterQueue(this.scope.deviceId),
        catalog: {
          ...catalog,
          // Only what passes the projection is ever read back.
          drafts: (catalog.drafts ?? [])
            .map(projectCounterDraft)
            .filter((draft): draft is CounterDraft => draft !== null),
        },
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
  installSnapshot(input: {
    envelope: OfflineSnapshotEnvelope;
    signature: string;
    payload: unknown;
    payloadHash: string;
    nowMs: number;
  }): Promise<InstallSnapshotResult> {
    return this.exclusive(() => this.installSnapshotNow(input));
  }

  private async installSnapshotNow(input: {
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
    const snapshots = [
      ...cache.snapshots.filter((row) => row.envelope.kind !== input.envelope.kind),
      stored,
    ];
    // DEV-957 phase 2 (shared till): a price list signed for another cashier means another
    // person is signed in on this counter, so the previous person's unfinished bills go.
    const operator = counterOperatorOf(snapshots)?.userId ?? null;
    const drafts =
      input.envelope.kind === 'RULES'
        ? (cache.drafts ?? []).filter((draft) => draft.operatorUserId === operator)
        : (cache.drafts ?? []);
    const nextState: CounterRuntimeState = {
      ...this.state,
      catalog: { ...cache, snapshots, drafts },
      queue: {
        ...this.queue(),
        safetyLeaseEvents: [
          ...this.queue().safetyLeaseEvents,
          {
            type: eventType,
            occurredAt: input.envelope.safetyLease.issuedAt,
            lease: input.envelope.safetyLease,
            recallVersion: input.envelope.safetyLease.recallVersion,
            recalledBatchIds: input.envelope.safetyLease.recalledBatchIds,
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
    const recallEvents = this.queue().safetyLeaseEvents.filter(
      (event) => event.type === 'RECALL_APPLIED'
    );
    // #519: the signed lease carries the server's recall set at issue; a lot
    // recalled by any cached lease or applied bulletin stays blocked offline.
    return {
      lease,
      appliedRecallVersion: Math.max(0, ...recallEvents.map((event) => event.recallVersion)),
      recalledBatchIds: [
        ...new Set([
          ...leases.flatMap((cached) => cached.recalledBatchIds ?? []),
          ...recallEvents.flatMap((event) => event.recalledBatchIds),
        ]),
      ],
    };
  }

  /** Apply the reconnect bulletin before allowing another sale. */
  applyRecallBulletin(bulletin: OfflineRecallBulletin): Promise<boolean> {
    return this.exclusive(() => this.applyRecallBulletinNow(bulletin));
  }

  private async applyRecallBulletinNow(bulletin: OfflineRecallBulletin): Promise<boolean> {
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
  adoptLeases(leases: readonly CounterLeaseCursor[]): Promise<void> {
    return this.exclusive(() =>
      this.commit({ ...this.state, queue: { ...this.queue(), leases: [...leases] } })
    );
  }

  /**
   * DEV-712: top up the receipt-number runway before it runs out, so a cashier is never
   * stopped mid-shift by an exhausted lease. Single-flight; a failure (offline, no manager
   * session, a refused device) keeps every block already held and never throws, so it can
   * run in the background. A new block is appended; numbers already issued never move.
   */
  renewReceiptLeases(
    reserve: CounterLeaseReserver,
    options: { lowWater?: number; size?: number } = {}
  ): Promise<LeaseRenewalResult> {
    if (this.activeLeaseRenewal) return this.activeLeaseRenewal;
    const renewal = this.runLeaseRenewal(reserve, options);
    this.activeLeaseRenewal = renewal;
    const clear = () => {
      if (this.activeLeaseRenewal === renewal) this.activeLeaseRenewal = null;
    };
    void renewal.then(clear, clear);
    return renewal;
  }

  private async runLeaseRenewal(
    reserve: CounterLeaseReserver,
    options: { lowWater?: number; size?: number }
  ): Promise<LeaseRenewalResult> {
    const lowWater = options.lowWater ?? COUNTER_LEASE_LOW_WATER;
    const size = options.size ?? COUNTER_LEASE_RENEWAL_SIZE;
    const remaining = () => remainingReceiptNumbers(this.queue());
    if (this.queue().replay === 'STOPPED_REVOKED') return { status: 'STOPPED', remaining: 0 };
    if (remaining() >= lowWater) return { status: 'SUFFICIENT', remaining: remaining() };
    let lease: CounterLeaseCursor | null;
    try {
      lease = leaseCursor(await reserve(size), this.scope.deviceId);
    } catch {
      lease = null;
    }
    if (!lease) return { status: 'FAILED', remaining: remaining() };
    const block = lease;
    return this.exclusive(async (): Promise<LeaseRenewalResult> => {
      // A heartbeat may have revoked and purged this counter while the request was out.
      if (this.queue().replay === 'STOPPED_REVOKED') return { status: 'STOPPED', remaining: 0 };
      const held = this.queue().leases;
      if (held.some((existing) => existing.leaseId === block.leaseId))
        return { status: 'RENEWED', remaining: remaining() };
      // Blocks never overlap; one that does is not this counter's to print from.
      if (
        held.some(
          (existing) =>
            block.blockStart <= existing.blockEnd && existing.blockStart <= block.blockEnd
        )
      )
        return { status: 'FAILED', remaining: remaining() };
      await this.commit({ ...this.state, queue: { ...this.queue(), leases: [...held, block] } });
      return { status: 'RENEWED', remaining: remaining() };
    });
  }

  /** Record the OFF-03 quotas this counter was granted before going offline. */
  adoptQuotas(quotas: readonly CounterQuota[]): Promise<void> {
    return this.exclusive(() =>
      this.commit({ ...this.state, queue: { ...this.queue(), quotas: [...quotas] } })
    );
  }

  /**
   * Compose one command. The OFF-02 decision is evaluated against the CACHED
   * snapshot states rather than anything the caller supplies, so a surface
   * cannot talk the matrix into accepting a snapshot the runtime never verified.
   *
   * #554: serialized behind every other transition, so a second sale composed
   * while the first is still being written draws the NEXT receipt number and
   * sequence from the first one's committed queue instead of reusing them.
   */
  enqueue(
    input: CounterCommandInput,
    matrix: Omit<CounterMatrixInputs, 'snapshots'>,
    options: { draftId?: string } = {}
  ): Promise<CounterEnqueueResult> {
    return this.exclusive(() => this.enqueueNow(input, matrix, options));
  }

  private async enqueueNow(
    input: CounterCommandInput,
    matrix: Omit<CounterMatrixInputs, 'snapshots'>,
    options: { draftId?: string }
  ): Promise<CounterEnqueueResult> {
    let queuedInput = input;
    if (input.action === 'MANUAL_OTC_SALE') {
      // Only the verified RULES snapshot supplies policy. Never accept a
      // caller-provided skip flag as permission to omit the reference.
      const rules = this.payloadFor('RULES') as { manualMerchantPolicies?: unknown } | null;
      try {
        const manualCapture = validateManualTenderPolicy(rules?.manualMerchantPolicies, input.payload.manualCapture);
        // Sign the normalized name the replay schema will verify, including
        // when an operator entered surrounding whitespace.
        queuedInput = { ...input, payload: { ...input.payload, manualCapture } };
      }
      catch { return { ok: false, reason: 'DENIED_OFFLINE', decision: null,
        message: 'Check payer name, transaction reference and signed branch merchant details before queuing payment.' }; }
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
        await this.commit(nextState);
      }
    }
    const batchIds = [
      ...(input.bucket ? [input.bucket.inventoryLotId] : []),
      ...(input.buckets ?? []).map((bucket) => bucket.inventoryLotId),
    ];
    const result = enqueueCounterCommand(this.queue(), queuedInput, {
      ...matrix,
      snapshots: this.cachedSnapshotStates(),
      safetyLeaseOk: leaseCheck.ok,
      batchRecalled: batchIds.some((batchId) => leaseState.recalledBatchIds.includes(batchId)),
    });
    if (!result.ok) return result;
    // DEV-957 phase 2: the bill that became this sale is gone in the same write, so a
    // reload shows the sale queued and never the same bill again.
    const drafts = options.draftId
      ? (this.cache().drafts ?? []).filter((row) => row.draftId !== options.draftId)
      : this.cache().drafts;
    await this.commit({
      ...this.state,
      queue: result.snapshot,
      catalog: { ...this.cache(), ...(drafts ? { drafts } : {}) },
    });
    return result;
  }

  /** DEV-957 phase 2: the offline bills this counter is building, newest first. */
  drafts(): CounterDraft[] {
    return [...(this.cache().drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Save one offline bill (replacing the stored copy with the same id). An empty bill is
   * removed. Only the allowlist projection is written; a bill that does not pass it, or
   * one more than MAX_OFFLINE_DRAFTS, is refused and nothing changes.
   */
  saveDraft(draft: CounterDraft): Promise<boolean> {
    return this.exclusive(async () => {
      const projected = projectCounterDraft(draft);
      if (!projected) return false;
      if (this.queue().replay === 'STOPPED_REVOKED') return false;
      const others = (this.cache().drafts ?? []).filter((row) => row.draftId !== projected.draftId);
      if (projected.lines.length && others.length >= MAX_OFFLINE_DRAFTS) return false;
      const drafts = projected.lines.length ? [...others, projected] : others;
      await this.commit({ ...this.state, catalog: { ...this.cache(), drafts } });
      return true;
    });
  }

  /** Drop offline bills: one, or every one (sign-out, another person signed in). */
  discardDrafts(draftId?: string): Promise<void> {
    return this.exclusive(async () => {
      const drafts = draftId
        ? (this.cache().drafts ?? []).filter((row) => row.draftId !== draftId)
        : [];
      await this.commit({ ...this.state, catalog: { ...this.cache(), drafts } });
    });
  }

  resume(): Promise<void> {
    return this.exclusive(() =>
      this.commit({ ...this.state, queue: resumeCounterAfterReauth(this.queue()) })
    );
  }

  replay(
    send: (request: CounterReplayRequest) => Promise<CounterReplayResponse>,
    sign: CounterReplaySigner
  ): Promise<ReplayResult> {
    if (this.activeReplay) return this.activeReplay;
    const replay = this.runReplay(send, sign);
    this.activeReplay = replay;
    const clear = () => {
      if (this.activeReplay === replay) this.activeReplay = null;
    };
    void replay.then(clear, clear);
    return replay;
  }

  private async runReplay(
    send: (request: CounterReplayRequest) => Promise<CounterReplayResponse>,
    sign: CounterReplaySigner
  ): Promise<ReplayResult> {
    for (;;) {
      const next = nextCounterReplay(this.queue(), this.scope.deviceId);
      if (next.status !== 'READY') return { state: next.status, discarded: null };

      let request: CounterReplayRequest;
      try {
        request = await buildCounterReplayRequest(this.queue(), next.command, sign);
      } catch {
        return this.exclusive(async (): Promise<ReplayResult> => {
          const current = nextCounterReplay(this.queue(), this.scope.deviceId);
          if (current.status !== 'READY') return { state: current.status, discarded: null };
          const applied = applyCounterReplayOutcome(this.queue(), {
            commandId: next.command.commandId,
            outcome: {
              action: 'PAUSE',
              reason: 'REAUTH',
              message: 'Replay signing requires the enrolled device credential.',
            },
          });
          await this.commit({ ...this.state, queue: applied.snapshot });
          return { state: 'PAUSED', discarded: null };
        });
      }
      // Signing may yield to a heartbeat that revokes this counter and purges
      // its storage. Never send or persist the stale command after that purge.
      const stopped = await this.exclusive(async (): Promise<ReplayResult | null> => {
        const current = nextCounterReplay(this.queue(), this.scope.deviceId);
        if (current.status !== 'READY') return { state: current.status, discarded: null };
        await this.commit({
          ...this.state,
          queue: beginCounterReplay(this.queue(), next.command.commandId),
        });
        return null;
      });
      if (stopped) return stopped;

      let response: CounterReplayResponse;
      try {
        response = await send(request);
      } catch {
        response = { status: 0 };
      }
      const outcome = classifyReplayOutcome(response);
      // Apply the outcome to the queue as it is NOW — a sale enqueued while the
      // request was in flight must survive this whole-document write.
      const settled = await this.exclusive(async (): Promise<ReplayResult | null> => {
        // A heartbeat may have revoked this counter and purged its storage while
        // the request was in flight. Revocation is final: never write the stale
        // result back over the purged scope.
        if (this.queue().replay === 'STOPPED_REVOKED') {
          return { state: 'STOPPED', discarded: null };
        }
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
        return null;
      });
      if (settled) return settled;
    }
  }

  /** Confirmed revocation outside a replay (a heartbeat said so). */
  revoke(): Promise<{ commands: number } | null> {
    return this.exclusive(async () => {
      const purged = purgeCounterQueue(this.queue());
      this.state = { ...this.state, queue: purged.snapshot };
      await purgeTerminalScope(this.driver, this.scope);
      return purged.discarded;
    });
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

  /**
   * #554: run one read-compute-write transition after every earlier one has
   * settled. A failed transition does not wedge the chain; its error is still
   * returned to its own caller. Transitions must not call `exclusive` again.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(task);
    this.transitions = run.catch(() => undefined);
    return run;
  }

  /** Publish a state transition only after its whole-document write succeeds. Callers
   * hold the transition chain (`exclusive`), so the write never races another one. */
  private async commit(nextState: CounterRuntimeState): Promise<void> {
    await writeTerminalState(this.driver, nextState, COUNTER_STORE_SCHEMA_VERSION);
    this.state = nextState;
  }
}

/**
 * DEV-712: keep a counter's receipt-number runway topped up in the background: once now, then
 * on every interval and whenever the browser comes back online. Returns a stop function.
 */
export function startReceiptLeaseRenewal(
  runtime: Pick<PharmacyCounterRuntime, 'renewReceiptLeases'>,
  reserve: CounterLeaseReserver,
  options: {
    intervalMs?: number;
    lowWater?: number;
    size?: number;
    onResult?: (result: LeaseRenewalResult) => void;
  } = {}
): () => void {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void runtime
      .renewReceiptLeases(reserve, { lowWater: options.lowWater, size: options.size })
      .then((result) => {
        if (!stopped) options.onResult?.(result);
      });
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? COUNTER_LEASE_RENEWAL_INTERVAL_MS);
  const online = typeof window === 'undefined' ? null : window;
  online?.addEventListener('online', run);
  return () => {
    stopped = true;
    clearInterval(timer);
    online?.removeEventListener('online', run);
  };
}
