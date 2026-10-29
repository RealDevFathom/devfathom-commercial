/**
 * PH-OFF / OFF-01 + OFF-02 — the pharmacy counter's device-bound command queue.
 *
 * CLIENT-SAFE and deliberately PURE: every export is either a data shape or a
 * total transition over `CounterQueueSnapshot`. No fetch, no timers, no storage
 * calls — persistence is the neutral retail-terminal local store and transport
 * belongs to the counter surface. That is what makes the correctness contract
 * testable without a browser, a server or a clock.
 *
 * The five invariants, all of them the Restaurant POS queue's invariants because
 * the offline problem is the same one — what differs is what may be composed at
 * all, which is OFF-02's business:
 *
 *  - **Stable keys.** Each command carries an id minted once at compose time and
 *    used verbatim as its idempotency key on every attempt, across reloads. The
 *    crash window (server committed, response lost) therefore resolves to ONE
 *    server-side effect.
 *  - **FIFO by persisted sequence, never by clock.** Ordering uses a per-device
 *    monotonic counter that lives in the persisted snapshot. Client-origin time
 *    is carried as metadata only.
 *  - **Device binding.** A snapshot names its device; a mismatch refuses replay
 *    outright. Queued work is never rebound to a replacement counter.
 *  - **Re-auth is not revocation.** A generic 401/403/423 PAUSES replay and keeps
 *    the queued commands; only a CONFIRMED device revocation purges.
 *  - **Nothing enters the queue the matrix denies.** `enqueueCounterCommand` runs
 *    OFF-02 before it appends, and the same table runs again on the server at
 *    replay. Composing a denied action locally is impossible, and arriving late
 *    with one does not get it applied.
 *
 * The two things this queue owns that the Restaurant one does not, because they
 * are pharmacy invariants rather than shared ones: the RECEIPT NUMBER is drawn
 * from a pre-allocated lease at compose time (§8A invariant 16 — the number is
 * issued to the customer offline and replay records it, never reassigns it), and
 * STOCK is drawn from this counter's own OFF-03 quota.
 */
import { browserUuid } from '@/lib/browser-uuid';
import type { TerminalReplayOutcome } from '@/lib/retail-terminal/replay-outcome';

import { decideOfflineAction } from './offline-action-matrix';
import type {
  CachedSnapshotState,
  OfflineActionDecision,
  OfflineDenialReason,
  PharmacyOfflineAction,
} from './offline-action-matrix';

/** The visible ceiling on queued commands held for one counter. */
export const MAX_QUEUED_COUNTER_COMMANDS = 200;

export type CounterCommandStatus = 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'QUARANTINED';

export type CounterQueuedCommand = {
  commandId: string;
  /** Always `commandId`: one stable device-scoped key per command, every attempt. */
  idempotencyKey: string;
  /** Per-device monotonic FIFO position. Never derived from a clock. */
  sequence: number;
  action: PharmacyOfflineAction;
  payload: Record<string, unknown>;
  /** Device-authentication material computed for the immutable replay body. */
  replaySignatures: CounterReplaySignatures | null;
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  /** The lease number ALREADY PRINTED for this command, or null when it printed none. */
  receiptNumber: number | null;
  status: CounterCommandStatus;
  attempts: number;
  serverRef: string | null;
  /** Set when the server refused this command outright. */
  rejection: string | null;
};

/** One reserved block of receipt numbers as the counter carries it. */
export type CounterLeaseCursor = {
  leaseId: string;
  blockStart: number;
  blockEnd: number;
  /** Next unissued number; `blockEnd + 1` once exhausted. */
  nextNumber: number;
};

/** This counter's OFF-03 ownership of one (lot, location) bucket. */
export type CounterQuota = {
  inventoryLotId: string;
  stockLocationId: string;
  quotaUnits: number;
  consumedUnits: number;
};

export type CounterReplayState = 'READY' | 'PAUSED_REAUTH' | 'STOPPED_REVOKED';

export type CounterQueueSnapshot = {
  deviceId: string;
  nextSequence: number;
  replay: CounterReplayState;
  commands: CounterQueuedCommand[];
  leases: CounterLeaseCursor[];
  quotas: CounterQuota[];
  /** OFF-04 append-only local audit trail; events are never rewritten. */
  safetyLeaseEvents: import('./offline-safety-lease').SafetyLeaseEvent[];
};

export function createCounterQueue(deviceId: string): CounterQueueSnapshot {
  return {
    deviceId,
    nextSequence: 1,
    replay: 'READY',
    commands: [],
    leases: [],
    quotas: [],
    safetyLeaseEvents: [],
  };
}

export function unsettledCommands(snapshot: CounterQueueSnapshot): CounterQueuedCommand[] {
  return snapshot.commands.filter(
    (command) => command.status !== 'ACKNOWLEDGED' && command.status !== 'QUARANTINED'
  );
}

// ── Receipt-number leases (§8A invariant 16) ─────────────────────────────────

export function remainingReceiptNumbers(snapshot: CounterQueueSnapshot): number {
  return snapshot.leases.reduce(
    (total, lease) => total + Math.max(0, lease.blockEnd - lease.nextNumber + 1),
    0
  );
}

/**
 * Take the lowest unissued number from the oldest open lease, returning the
 * number and the advanced leases. Blocks are consumed in reservation order, so
 * the numbers a counter prints during one outage are contiguous and legible.
 */
export function issueReceiptNumber(
  leases: readonly CounterLeaseCursor[]
): { receiptNumber: number; leases: CounterLeaseCursor[] } | null {
  let chosen: CounterLeaseCursor | null = null;
  for (const lease of leases) {
    if (lease.nextNumber > lease.blockEnd) continue;
    if (chosen === null || lease.nextNumber < chosen.nextNumber) chosen = lease;
  }
  if (!chosen) return null;
  const receiptNumber = chosen.nextNumber;
  return {
    receiptNumber,
    leases: leases.map((lease) =>
      lease.leaseId === chosen.leaseId ? { ...lease, nextNumber: receiptNumber + 1 } : lease
    ),
  };
}

// ── Quotas (OFF-03) ──────────────────────────────────────────────────────────

export type QuotaBucketRef = { inventoryLotId: string; stockLocationId: string };

export function quotaUnitsAvailable(
  snapshot: CounterQueueSnapshot,
  bucket: QuotaBucketRef | null
): number {
  if (!bucket) return 0;
  const quota = snapshot.quotas.find(
    (candidate) =>
      candidate.inventoryLotId === bucket.inventoryLotId &&
      candidate.stockLocationId === bucket.stockLocationId
  );
  return quota ? quota.quotaUnits - quota.consumedUnits : 0;
}

function consumeQuota(
  quotas: readonly CounterQuota[],
  bucket: QuotaBucketRef,
  units: number
): CounterQuota[] {
  return quotas.map((quota) =>
    quota.inventoryLotId === bucket.inventoryLotId &&
    quota.stockLocationId === bucket.stockLocationId
      ? { ...quota, consumedUnits: quota.consumedUnits + units }
      : quota
  );
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export type CounterCommandInput = {
  deviceId: string;
  action: PharmacyOfflineAction;
  payload: Record<string, unknown>;
  /** Required by the pharmacy counter replay route for a deliverable sale. */
  replaySignatures?: CounterReplaySignatures;
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  /** The bucket this command draws stock from, and how much. */
  bucket?: QuotaBucketRef | null;
  requestedUnits?: number;
  requestedCreditMinor?: number;
  /** Defaults true for sale actions, keeping older callers fail closed. */
  medicineSale?: boolean;
};

/** What the matrix needs that the queue does not itself hold. */
export type CounterMatrixInputs = {
  nowMs: number;
  snapshots: readonly CachedSnapshotState[];
  cachedCreditRemainingMinor: number;
  controlledMedicinesPermittedOffline: boolean;
  originalSaleAvailable: boolean;
  deviceUsable: boolean;
  safetyLeaseOk?: boolean;
  batchRecalled?: boolean;
};

export type CounterEnqueueResult =
  | { ok: true; snapshot: CounterQueueSnapshot; command: CounterQueuedCommand }
  | {
      ok: false;
      reason: OfflineDenialReason | 'DEVICE_MISMATCH' | 'DEVICE_REVOKED' | 'QUEUE_FULL';
      message: string;
      decision: OfflineActionDecision | null;
    };

function defaultId(): string {
  return browserUuid();
}

/**
 * Compose one command at a disconnected counter.
 *
 * The OFF-02 decision runs FIRST and its refusal is returned as a value, not
 * thrown, so the counter surface can show the operator exactly which rule
 * stopped them. Only once the decision allows does anything mutate: the receipt
 * number is drawn from the lease, the quota is debited and the command is
 * appended — all in one returned snapshot, so a refusal never half-spends a
 * number or a unit.
 */
export function enqueueCounterCommand(
  snapshot: CounterQueueSnapshot,
  input: CounterCommandInput,
  matrix: CounterMatrixInputs,
  newId: () => string = defaultId
): CounterEnqueueResult {
  if (input.deviceId !== snapshot.deviceId) {
    return {
      ok: false,
      reason: 'DEVICE_MISMATCH',
      message: 'This work was composed on a different counter and cannot be queued here.',
      decision: null,
    };
  }
  if (snapshot.replay === 'STOPPED_REVOKED') {
    return {
      ok: false,
      reason: 'DEVICE_REVOKED',
      message: 'This counter has been revoked and can no longer take work.',
      decision: null,
    };
  }
  if (unsettledCommands(snapshot).length >= MAX_QUEUED_COUNTER_COMMANDS) {
    return {
      ok: false,
      reason: 'QUEUE_FULL',
      message: `This counter is holding ${MAX_QUEUED_COUNTER_COMMANDS} unsent commands. Reconnect before composing another.`,
      decision: null,
    };
  }

  const requestedUnits = input.requestedUnits ?? 0;
  const decision = decideOfflineAction(input.action, {
    nowMs: matrix.nowMs,
    snapshots: matrix.snapshots,
    receiptNumbersRemaining: remainingReceiptNumbers(snapshot),
    quotaUnitsAvailable: quotaUnitsAvailable(snapshot, input.bucket ?? null),
    requestedUnits,
    requestedCreditMinor: input.requestedCreditMinor ?? 0,
    cachedCreditRemainingMinor: matrix.cachedCreditRemainingMinor,
    controlledMedicinesPermittedOffline: matrix.controlledMedicinesPermittedOffline,
    originalSaleAvailable: matrix.originalSaleAvailable,
    deviceUsable: matrix.deviceUsable,
    medicineSale: input.medicineSale ?? true,
    safetyLeaseOk: matrix.safetyLeaseOk,
    batchRecalled: matrix.batchRecalled,
  });
  if (!decision.allowed) {
    return { ok: false, reason: decision.reason, message: decision.message, decision };
  }

  let leases = snapshot.leases;
  let receiptNumber: number | null = null;
  if (decision.rule.requires.includes('RECEIPT_NUMBER')) {
    const issued = issueReceiptNumber(leases);
    // `decideOfflineAction` already refused an empty runway; this is the
    // belt-and-braces branch that keeps the type honest.
    if (!issued) {
      return {
        ok: false,
        reason: 'NO_RECEIPT_NUMBER',
        message: 'This counter has used every pre-allocated receipt number.',
        decision,
      };
    }
    receiptNumber = issued.receiptNumber;
    leases = issued.leases;
  }

  const quotas =
    decision.rule.requires.includes('STOCK_QUOTA') && input.bucket && requestedUnits > 0
      ? consumeQuota(snapshot.quotas, input.bucket, requestedUnits)
      : snapshot.quotas;

  const commandId = newId();
  const command: CounterQueuedCommand = {
    commandId,
    idempotencyKey: commandId,
    sequence: snapshot.nextSequence,
    action: input.action,
    payload: input.payload,
    replaySignatures: input.replaySignatures ?? null,
    clientOriginAt: input.clientOriginAt,
    receiptNumber,
    status: 'PENDING',
    attempts: 0,
    serverRef: null,
    rejection: null,
  };

  return {
    ok: true,
    command,
    snapshot: {
      ...snapshot,
      nextSequence: snapshot.nextSequence + 1,
      leases,
      quotas,
      commands: [...snapshot.commands, command],
    },
  };
}

// ── FIFO replay selection ────────────────────────────────────────────────────

export type NextCounterReplay =
  | { status: 'READY'; command: CounterQueuedCommand }
  | { status: 'IDLE' }
  | { status: 'PAUSED'; reason: 'REAUTH' }
  | { status: 'STOPPED'; reason: 'DEVICE_REVOKED' }
  | { status: 'REFUSED'; reason: 'DEVICE_MISMATCH' };

/**
 * The next command to send: the lowest-sequence command that is not yet
 * acknowledged or quarantined. `deviceId` is the counter replay is being
 * attempted on — a mismatch refuses, so queued work is never rebound.
 */
export function nextCounterReplay(
  snapshot: CounterQueueSnapshot,
  deviceId: string
): NextCounterReplay {
  if (deviceId !== snapshot.deviceId) return { status: 'REFUSED', reason: 'DEVICE_MISMATCH' };
  if (snapshot.replay === 'STOPPED_REVOKED') {
    return { status: 'STOPPED', reason: 'DEVICE_REVOKED' };
  }
  if (snapshot.replay === 'PAUSED_REAUTH') return { status: 'PAUSED', reason: 'REAUTH' };

  const next = [...unsettledCommands(snapshot)].sort((a, b) => a.sequence - b.sequence)[0];
  return next ? { status: 'READY', command: next } : { status: 'IDLE' };
}

/** The replay request for one queued command. The key is the command id, always. */
export type CounterReplaySignatures = {
  command: string;
  receipt: string;
};

export type CounterReplayRequest = {
  path: string;
  method: 'POST';
  headers: {
    'Idempotency-Key': string;
    'X-Command-Signature': string;
    'X-Receipt-Signature': string;
  };
  body: Record<string, unknown>;
};

export function buildCounterReplayRequest(
  _snapshot: CounterQueueSnapshot,
  command: CounterQueuedCommand
): CounterReplayRequest {
  if (!command.replaySignatures) {
    throw new Error('A queued pharmacy sale cannot replay without command and receipt signatures.');
  }
  const leasedReceipt = command.payload.leasedReceipt;
  const payload =
    leasedReceipt && typeof leasedReceipt === 'object' && !Array.isArray(leasedReceipt)
      ? {
          ...command.payload,
          leasedReceipt: { ...leasedReceipt, receiptNumber: command.receiptNumber },
        }
      : command.payload;
  return {
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'Idempotency-Key': command.idempotencyKey,
      'X-Command-Signature': command.replaySignatures.command,
      'X-Receipt-Signature': command.replaySignatures.receipt,
    },
    body: {
      ...payload,
      sequence: command.sequence,
      idempotencyKey: command.idempotencyKey,
      action: command.action,
    },
  };
}

// ── Applying an outcome ──────────────────────────────────────────────────────

export type ApplyCounterReplayResult = {
  snapshot: CounterQueueSnapshot;
  /** Set only on a confirmed-revocation purge. */
  discarded: { commands: number } | null;
};

function mapCommand(
  snapshot: CounterQueueSnapshot,
  commandId: string,
  update: (command: CounterQueuedCommand) => CounterQueuedCommand
): CounterQueueSnapshot {
  return {
    ...snapshot,
    commands: snapshot.commands.map((command) =>
      command.commandId === commandId ? update(command) : command
    ),
  };
}

/** Mark a command in flight. The key is untouched — every attempt reuses it. */
export function beginCounterReplay(
  snapshot: CounterQueueSnapshot,
  commandId: string
): CounterQueueSnapshot {
  return mapCommand(snapshot, commandId, (command) => ({
    ...command,
    status: 'IN_FLIGHT',
    attempts: command.attempts + 1,
  }));
}

/**
 * Fold one classified outcome back into the queue.
 *
 * ACK records the server reference and completes the command; the receipt number
 * it printed is left exactly as it was. RETRY returns it to PENDING with its key
 * intact — that is the crash-window guarantee. REVIEW and QUARANTINE both set it
 * aside for the operator, because a pharmacy command carries money and stock and
 * must never loop against the server. PAUSE stops replay without touching data.
 * PURGE clears the queue and reports what was lost.
 */
export function applyCounterReplayOutcome(
  snapshot: CounterQueueSnapshot,
  input: { commandId: string; outcome: TerminalReplayOutcome; serverRef?: string | null }
): ApplyCounterReplayResult {
  const { outcome } = input;

  if (outcome.action === 'PURGE') return purgeCounterQueue(snapshot);

  if (outcome.action === 'PAUSE') {
    return {
      snapshot: {
        ...mapCommand(snapshot, input.commandId, (command) => ({ ...command, status: 'PENDING' })),
        replay: 'PAUSED_REAUTH',
      },
      discarded: null,
    };
  }

  if (outcome.action === 'RETRY') {
    return {
      snapshot: mapCommand(snapshot, input.commandId, (command) => ({
        ...command,
        status: 'PENDING',
      })),
      discarded: null,
    };
  }

  if (outcome.action === 'REVIEW' || outcome.action === 'QUARANTINE') {
    return {
      snapshot: mapCommand(snapshot, input.commandId, (command) => ({
        ...command,
        status: 'QUARANTINED',
        rejection: outcome.message,
      })),
      discarded: null,
    };
  }

  return {
    snapshot: mapCommand(snapshot, input.commandId, (command) => ({
      ...command,
      status: 'ACKNOWLEDGED',
      // Written once: a duplicate acknowledgement of the same key (the lost-
      // response replay) keeps the first server reference.
      serverRef: command.serverRef ?? input.serverRef ?? null,
    })),
    discarded: null,
  };
}

/** Re-authentication succeeded: resume FIFO replay with every command intact. */
export function resumeCounterAfterReauth(snapshot: CounterQueueSnapshot): CounterQueueSnapshot {
  if (snapshot.replay === 'STOPPED_REVOKED') return snapshot;
  return { ...snapshot, replay: 'READY' };
}

/**
 * Confirmed device revocation. Queued device-bound work is discarded — it can
 * never be replayed by this counter and must not be rebound to another — and the
 * snapshot is left in a state where `nextCounterReplay` sends nothing at all.
 * The leases are dropped with it: a revoked counter must not keep printing from
 * a block it no longer owns.
 */
export function purgeCounterQueue(snapshot: CounterQueueSnapshot): ApplyCounterReplayResult {
  const discarded = { commands: unsettledCommands(snapshot).length };
  return {
    snapshot: {
      ...snapshot,
      replay: 'STOPPED_REVOKED',
      commands: [],
      leases: [],
      quotas: [],
    },
    discarded,
  };
}
