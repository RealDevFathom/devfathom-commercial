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
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  /** The lease number ALREADY PRINTED for this command, or null when it printed none. */
  receiptNumber: number | null;
  status: CounterCommandStatus;
  attempts: number;
  serverRef: string | null;
  /** Set when the server refused this command outright. */
  rejection: string | null;
  /**
   * DEV-957 phase 2 (hardening 4): the hash of the seal this sale was signed with when it
   * was taken (the seal itself travels in `payload.seal`). The next sale names it.
   */
  sealHash?: string;
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
  /** DEV-957 phase 2 (hardening 4): the seal hash of the last sale taken here (the chain head). */
  lastSealHash?: string | null;
  /**
   * DEV-957 phase 2: one copy of each signed price list a waiting sale was priced from,
   * keyed by its payload hash. A queued sale keeps only the envelope and signature, so a
   * sale never stores a whole price list of its own; the payload is put back when it is sent.
   */
  snapshotArchive?: ArchivedSnapshotPayload[];
};

export type ArchivedSnapshotPayload = { payloadHash: string; payload: unknown };

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
): { receiptNumber: number; leaseId: string; leases: CounterLeaseCursor[] } | null {
  let chosen: CounterLeaseCursor | null = null;
  for (const lease of leases) {
    if (lease.nextNumber > lease.blockEnd) continue;
    if (chosen === null || lease.nextNumber < chosen.nextNumber) chosen = lease;
  }
  if (!chosen) return null;
  const receiptNumber = chosen.nextNumber;
  return {
    receiptNumber,
    leaseId: chosen.leaseId,
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

/** One draw per bucket: two lines of the same lot and location add up. */
function mergeDraws(
  buckets: ReadonlyArray<QuotaBucketRef & { units: number }>
): Array<QuotaBucketRef & { units: number }> {
  const merged = new Map<string, QuotaBucketRef & { units: number }>();
  for (const bucket of buckets) {
    const key = `${bucket.inventoryLotId}:${bucket.stockLocationId}`;
    const prior = merged.get(key);
    merged.set(key, {
      inventoryLotId: bucket.inventoryLotId,
      stockLocationId: bucket.stockLocationId,
      units: (prior?.units ?? 0) + bucket.units,
    });
  }
  return [...merged.values()];
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
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  /** The bucket this command draws stock from, and how much. */
  bucket?: QuotaBucketRef | null;
  requestedUnits?: number;
  /**
   * DEV-957 phase 2: a bill with several lines draws from several buckets. Each one must
   * hold enough of this counter's quota, and each is debited in the same returned
   * snapshot (or none is). Takes the place of `bucket` and `requestedUnits`.
   */
  buckets?: ReadonlyArray<QuotaBucketRef & { units: number }>;
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
      reason: OfflineDenialReason | 'DEVICE_MISMATCH' | 'DEVICE_REVOKED' | 'QUEUE_FULL' | 'SEAL_FAILED' | 'SELLING_OFF';
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

  // DEV-957 phase 2: several buckets are summed per bucket and the matrix judges the
  // tightest one, so a bill is refused when ANY of its lots is short.
  const draws = input.buckets ? mergeDraws(input.buckets) : null;
  const tightest = draws
    ? draws.reduce<{ bucket: QuotaBucketRef; units: number } | null>((worst, draw) => {
        const slack = quotaUnitsAvailable(snapshot, draw) - draw.units;
        if (!worst) return { bucket: draw, units: draw.units };
        return slack < quotaUnitsAvailable(snapshot, worst.bucket) - worst.units
          ? { bucket: draw, units: draw.units }
          : worst;
      }, null)
    : null;
  const requestedUnits = tightest ? tightest.units : (input.requestedUnits ?? 0);
  const decision = decideOfflineAction(input.action, {
    nowMs: matrix.nowMs,
    snapshots: matrix.snapshots,
    receiptNumbersRemaining: remainingReceiptNumbers(snapshot),
    quotaUnitsAvailable: quotaUnitsAvailable(
      snapshot,
      tightest ? tightest.bucket : (input.bucket ?? null)
    ),
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

  if (draws && draws.some((draw) => !Number.isSafeInteger(draw.units) || draw.units <= 0)) {
    return {
      ok: false,
      reason: 'QUOTA_EXCEEDED',
      message: 'Every line needs a whole number of units.',
      decision,
    };
  }

  let leases = snapshot.leases;
  let receiptNumber: number | null = null;
  let leaseId: string | null = null;
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
    leaseId = issued.leaseId;
    leases = issued.leases;
  }

  const quotas = !decision.rule.requires.includes('STOCK_QUOTA')
    ? snapshot.quotas
    : draws
      ? draws.reduce((held, draw) => consumeQuota(held, draw, draw.units), snapshot.quotas)
      : input.bucket && requestedUnits > 0
        ? consumeQuota(snapshot.quotas, input.bucket, requestedUnits)
        : snapshot.quotas;

  // DEV-957 phase 2: the leased receipt names the block its number was drawn from, so
  // the server checks the number against exactly that lease at replay.
  const leasedReceipt = input.payload.leasedReceipt;
  const payload =
    leaseId && leasedReceipt && typeof leasedReceipt === 'object' && !Array.isArray(leasedReceipt)
      ? { ...input.payload, leasedReceipt: { ...leasedReceipt, leaseId } }
      : input.payload;

  const commandId = newId();
  const command: CounterQueuedCommand = {
    commandId,
    idempotencyKey: commandId,
    sequence: snapshot.nextSequence,
    action: input.action,
    payload,
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

/**
 * Signs the final, server-validated replay objects after the queue has assigned
 * its receipt number, sequence and idempotency key. The device credential stays
 * in the live enrollment/session adapter and is never persisted in the outbox.
 */
export type CounterReplaySigner = (
  body: Record<string, unknown>,
  leasedReceipt: Record<string, unknown>
) => Promise<CounterReplaySignatures> | CounterReplaySignatures;

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

// ── Signed price lists kept once (DEV-957 phase 2) ───────────────────────────

type CarriedSnapshot = { envelope?: { payloadHash?: unknown }; payload?: unknown };

function carried(value: unknown): CarriedSnapshot[] {
  return Array.isArray(value) ? (value as CarriedSnapshot[]) : [];
}

/**
 * Move the payloads of the price lists a queued sale carries into the shared archive,
 * leaving the sale with each envelope and signature only. Payloads are keyed by the hash
 * the signed envelope names, so one copy serves every sale priced from that list.
 */
export function archiveCommandSnapshots(
  snapshot: CounterQueueSnapshot,
  command: CounterQueuedCommand
): { snapshot: CounterQueueSnapshot; command: CounterQueuedCommand } {
  const archive = [...(snapshot.snapshotArchive ?? [])];
  const snapshots = carried(command.payload.snapshots).map((row) => {
    const hash = row.envelope?.payloadHash;
    if (typeof hash !== 'string' || row.payload === undefined) return row;
    if (!archive.some((entry) => entry.payloadHash === hash))
      archive.push({ payloadHash: hash, payload: row.payload });
    const reference: CarriedSnapshot = { ...row };
    delete reference.payload;
    return reference;
  });
  const compact = { ...command, payload: { ...command.payload, snapshots } };
  return {
    command: compact,
    snapshot: {
      ...snapshot,
      snapshotArchive: archive,
      commands: snapshot.commands.map((row) => (row.commandId === command.commandId ? compact : row)),
    },
  };
}

/** The carried price lists with their payloads put back from the archive. */
function withArchivedPayloads(snapshot: CounterQueueSnapshot, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return carried(value).map((row) => {
    if (row.payload !== undefined) return row;
    const hash = row.envelope?.payloadHash;
    const kept = (snapshot.snapshotArchive ?? []).find((entry) => entry.payloadHash === hash);
    if (!kept) throw new Error('A queued sale is missing the price list it was priced from.');
    return { ...row, payload: kept.payload };
  });
}

/**
 * Drop archived price lists no sale the server has not acknowledged refers to any more
 * (a sale it refused still needs its list, for a manager to settle it).
 */
export function pruneSnapshotArchive(snapshot: CounterQueueSnapshot): CounterQueueSnapshot {
  if (!snapshot.snapshotArchive?.length) return snapshot;
  const needed = new Set(
    snapshot.commands.filter((command) => command.status !== 'ACKNOWLEDGED').flatMap((command) =>
      carried(command.payload.snapshots).map((row) => row.envelope?.payloadHash)
    )
  );
  const kept = snapshot.snapshotArchive.filter((entry) => needed.has(entry.payloadHash));
  return kept.length === snapshot.snapshotArchive.length
    ? snapshot
    : { ...snapshot, snapshotArchive: kept };
}

export async function buildCounterReplayRequest(
  snapshot: CounterQueueSnapshot,
  command: CounterQueuedCommand,
  sign: CounterReplaySigner
): Promise<CounterReplayRequest> {
  const leasedReceipt = command.payload.leasedReceipt;
  if (!leasedReceipt || typeof leasedReceipt !== 'object' || Array.isArray(leasedReceipt)) {
    throw new Error('A queued pharmacy sale cannot replay without its leased receipt.');
  }
  // Local queue metadata is not part of the strict replay wire contract.
  const finalReceipt = {
    ...leasedReceipt,
    receiptNumber: command.receiptNumber,
    originalSaleAt: command.clientOriginAt,
  };
  const body: Record<string, unknown> = {
    sequence: command.sequence,
    idempotencyKey: command.idempotencyKey,
    action: command.action,
    leasedReceipt: finalReceipt,
    snapshots: withArchivedPayloads(snapshot, command.payload.snapshots),
    lines: command.payload.lines,
    amountMinor: command.payload.amountMinor,
    ...(command.action === 'MANUAL_OTC_SALE'
      ? { manualCapture: command.payload.manualCapture }
      : { cashReceivedMinor: command.payload.cashReceivedMinor }),
    // DEV-957 phase 2 (hardening 4): the seal signed when the sale was taken.
    ...(command.payload.seal !== undefined ? { seal: command.payload.seal } : {}),
  };
  const signatures = await sign(body, finalReceipt);
  return {
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'Idempotency-Key': command.idempotencyKey,
      'X-Command-Signature': signatures.command,
      'X-Receipt-Signature': signatures.receipt,
    },
    body,
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
