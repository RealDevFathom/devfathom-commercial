import 'server-only';

import { createHash } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  planDispatchFailure,
} from '@/lib/retail-terminal/outbox-retry';
import type { OutboxRetryPolicy } from '@/lib/retail-terminal/outbox-retry';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { decideOfflineAction } from './offline-action-matrix';
import type { OfflineActionContext, PharmacyOfflineAction } from './offline-action-matrix';
import { canonicalJson } from './offline-snapshot-envelope';

/**
 * PH-OFF / OFF-01 — the append-only offline command log and its outbox replay.
 *
 * This is the SERVER half of the counter's outbox. Everything the counter
 * composed while disconnected arrives here, in the counter's own FIFO order, and
 * is recorded before anything is applied. Three properties matter:
 *
 *  - **Idempotency by a key minted once.** The counter mints one key per command
 *    at compose time and reuses it on every attempt, across reloads. Recording is
 *    an insert with `ON CONFLICT DO NOTHING` on `(organization, device, key)`
 *    followed by a read-back: the classic crash window — server committed, the
 *    response lost — therefore resolves to ONE row and one effect. A key
 *    re-presented with a DIFFERENT payload is a conflict, never an overwrite.
 *  - **Append-only.** The identity of a recorded command (device, sequence, key,
 *    action, payload and its hash, the client-origin instant) is immutable and no
 *    row is ever deleted; only the replay bookkeeping advances, and only away
 *    from PENDING. The guard triggers in the migration hold that even for a
 *    caller that never comes through this module.
 *  - **The action matrix decides again, here.** OFF-02's table is evaluated at
 *    the counter to refuse work locally, and evaluated AGAIN on replay. A device
 *    that somehow queued a denied action does not get it applied by arriving
 *    late — the local check is a courtesy, this one is the boundary.
 *
 * Ordering is by the counter's persisted `sequence`, never by a clock:
 * `clientOriginAt` is carried as metadata and `receivedAt` is the server's own.
 */

export class PharmacyOfflineCommandError extends Error {
  constructor(
    readonly reason:
      | 'DEVICE_NOT_USABLE'
      | 'IDEMPOTENCY_CONFLICT'
      | 'SEQUENCE_CONFLICT'
      | 'SEQUENCE_OUT_OF_ORDER'
      | 'NOT_FOUND'
      | 'ALREADY_SETTLED'
      | 'ACTION_DENIED'
  ) {
    super(reason);
    this.name = 'PharmacyOfflineCommandError';
  }
}

export type OfflineCommandScope = {
  organizationId: string;
  branchId: string;
};

export type RecordOfflineCommandInput = {
  deviceId: string;
  /** The counter's per-device FIFO position. Minted on the device, never here. */
  sequence: number;
  idempotencyKey: string;
  action: PharmacyOfflineAction;
  payload: Prisma.InputJsonValue;
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: Date;
  /** The number this counter already PRINTED from its lease, if it printed one. */
  receiptNumber?: number | null;
};

// PostgreSQL stores both the command sequence and cursor as INTEGER. Reserve
// the final value for the cursor produced after accepting the last command.
export const MAX_OFFLINE_COMMAND_SEQUENCE = 2_147_483_646;
export const MAX_OFFLINE_COMMAND_CURSOR = MAX_OFFLINE_COMMAND_SEQUENCE + 1;

export function commandPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Record one replayed command, idempotently.
 *
 * Returns `replayed: true` when the key was already known — the caller must then
 * treat the stored row as the outcome rather than applying the command a second
 * time. A key that arrives with a different payload hash or a different action is
 * an IDEMPOTENCY_CONFLICT: two different commands cannot share one key.
 */
export async function recordOfflineCommand(
  db: ScopedDb,
  scope: OfflineCommandScope,
  input: RecordOfflineCommandInput
) {
  const device = await db.pharmacyRegisteredDevice.findFirst({
    where: {
      id: input.deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { status: true, revokedAt: true },
  });
  if (!device || device.status !== 'ACTIVE' || device.revokedAt !== null) {
    throw new PharmacyOfflineCommandError('DEVICE_NOT_USABLE');
  }

  const payloadHash = commandPayloadHash(input.payload);

  // A retry of an already-recorded command is valid even though the durable
  // cursor has moved past it. Validate that retry before attempting to claim
  // the next position.
  const existing = await db.pharmacyOfflineCommand.findFirst({
    where: {
      organizationId: scope.organizationId,
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) {
    if (
      existing.sequence !== input.sequence ||
      existing.action !== input.action ||
      existing.payloadHash !== payloadHash
    )
      throw new PharmacyOfflineCommandError('IDEMPOTENCY_CONFLICT');
    // A backfilled cursor can catch up with history after a gap is filled.
    // Advance only across this validated command at the current position;
    // future history must not skip a gap and older retries must not rewind it.
    if (existing.sequence < MAX_OFFLINE_COMMAND_CURSOR) {
      await db.pharmacyRegisteredDevice.updateMany({
        where: {
          id: input.deviceId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          status: 'ACTIVE',
          revokedAt: null,
          nextOfflineCommandSequence: existing.sequence,
        },
        data: { nextOfflineCommandSequence: { increment: 1 } },
      });
    }
    // Finding the key means this invocation did not create the command. That is
    // a replay even when the first worker crashed before its initial attempt.
    return { command: existing, replayed: true };
  }

  if (
    !Number.isInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > MAX_OFFLINE_COMMAND_SEQUENCE
  )
    throw new PharmacyOfflineCommandError('SEQUENCE_OUT_OF_ORDER');

  // Claim exactly the device's next position. The compare-and-increment is the
  // durable FIFO guard; it also serializes callers that use this helper outside
  // the transport's device-row lock. The surrounding transaction rolls this
  // advancement back if recording or applying the command fails.
  const claimed = await db.pharmacyRegisteredDevice.updateMany({
    where: {
      id: input.deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      revokedAt: null,
      nextOfflineCommandSequence: input.sequence,
    },
    data: { nextOfflineCommandSequence: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    const occupied = await db.pharmacyOfflineCommand.findFirst({
      where: {
        organizationId: scope.organizationId,
        deviceId: input.deviceId,
        sequence: input.sequence,
      },
    });
    // A concurrent identical retry can miss the initial read, then wait for
    // the winner's cursor update to commit. Read its command after losing the
    // claim so that this retry still receives the original idempotent result.
    if (occupied?.idempotencyKey === input.idempotencyKey) {
      if (occupied.action !== input.action || occupied.payloadHash !== payloadHash)
        throw new PharmacyOfflineCommandError('IDEMPOTENCY_CONFLICT');
      return { command: occupied, replayed: true };
    }
    throw new PharmacyOfflineCommandError(occupied ? 'SEQUENCE_CONFLICT' : 'SEQUENCE_OUT_OF_ORDER');
  }

  // One statement, so two concurrent replays of the same key cannot both pass a
  // read-then-write gap. The read-back afterwards is what turns "did nothing"
  // into either a legitimate replay or a conflict.
  await db.pharmacyOfflineCommand.createMany({
    data: [
      {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        sequence: input.sequence,
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        payload: input.payload,
        payloadHash,
        clientOriginAt: input.clientOriginAt,
        receiptNumber: input.receiptNumber ?? null,
      },
    ],
    skipDuplicates: true,
  });

  const stored = await db.pharmacyOfflineCommand.findFirst({
    where: {
      organizationId: scope.organizationId,
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (!stored) {
    // `skipDuplicates` swallowed a conflict on the OTHER unique key: this
    // counter already used this sequence for a different command.
    throw new PharmacyOfflineCommandError('SEQUENCE_CONFLICT');
  }
  if (
    stored.sequence !== input.sequence ||
    stored.action !== input.action ||
    stored.payloadHash !== payloadHash
  ) {
    throw new PharmacyOfflineCommandError('IDEMPOTENCY_CONFLICT');
  }

  const replayed = stored.attempts > 0 || stored.status !== 'PENDING';
  return { command: stored, replayed };
}

/**
 * Explicit operator recovery for a command that can never be replayed. The
 * cursor can only move forward and the compare-and-set prevents racing replay.
 */
export async function skipOfflineCommandSequences(
  db: ScopedDb,
  scope: OfflineCommandScope,
  deviceId: string,
  expectedSequence: number,
  nextSequence: number
) {
  if (
    !Number.isInteger(expectedSequence) ||
    !Number.isInteger(nextSequence) ||
    expectedSequence < 1 ||
    expectedSequence > MAX_OFFLINE_COMMAND_CURSOR ||
    nextSequence <= expectedSequence ||
    nextSequence > MAX_OFFLINE_COMMAND_SEQUENCE
  )
    throw new PharmacyOfflineCommandError('SEQUENCE_OUT_OF_ORDER');
  const advanced = await db.pharmacyRegisteredDevice.updateMany({
    where: {
      id: deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      revokedAt: null,
      nextOfflineCommandSequence: expectedSequence,
    },
    data: { nextOfflineCommandSequence: nextSequence },
  });
  if (advanced.count !== 1) throw new PharmacyOfflineCommandError('SEQUENCE_OUT_OF_ORDER');
  return { nextSequence };
}

/**
 * Re-evaluate OFF-02 on the server before a recorded command is applied. The
 * counter's local refusal is a courtesy to the operator; this is the boundary.
 */
export function authorizeReplayedCommand(
  action: PharmacyOfflineAction,
  context: OfflineActionContext
) {
  const decision = decideOfflineAction(action, context);
  if (!decision.allowed) throw new PharmacyOfflineCommandError('ACTION_DENIED');
  return decision;
}

/** Commands this counter still owes the server, in its own FIFO order. */
export async function pendingOfflineCommands(
  db: ScopedDb,
  scope: OfflineCommandScope,
  deviceId: string
) {
  return db.pharmacyOfflineCommand.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId,
      status: 'PENDING',
    },
    orderBy: { sequence: 'asc' },
  });
}

export type SettleOfflineCommandInput =
  | { commandId: string; outcome: 'ACCEPTED'; serverRef: string; receiptNumber?: number | null }
  | { commandId: string; outcome: 'REJECTED'; reason: string };

/**
 * Settle a recorded command. ACCEPTED records the server reference and, when the
 * counter printed one offline, the receipt number it ALREADY issued — the update
 * guard then makes that number immutable (§8A invariant 16: reconciliation never
 * renumbers a receipt already handed to a customer). REJECTED records why.
 *
 * A settled command is final: the guard refuses a second transition, so a
 * duplicate replay of an accepted command cannot flip it to rejected or back.
 */
export async function settleOfflineCommand(
  db: ScopedDb,
  scope: OfflineCommandScope,
  input: SettleOfflineCommandInput,
  now: Date
) {
  const command = await db.pharmacyOfflineCommand.findFirst({
    where: {
      id: input.commandId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, status: true, attempts: true, receiptNumber: true },
  });
  if (!command) throw new PharmacyOfflineCommandError('NOT_FOUND');
  if (command.status !== 'PENDING') throw new PharmacyOfflineCommandError('ALREADY_SETTLED');

  if (input.outcome === 'ACCEPTED') {
    return db.pharmacyOfflineCommand.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: command.id } },
      data: {
        status: 'ACCEPTED',
        settledAt: now,
        attempts: command.attempts + 1,
        nextAttemptAt: null,
        serverRef: input.serverRef,
        // Written once. An already-issued number is never replaced.
        receiptNumber: command.receiptNumber ?? input.receiptNumber ?? null,
      },
    });
  }

  return db.pharmacyOfflineCommand.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: command.id } },
    data: {
      status: 'REJECTED',
      settledAt: now,
      attempts: command.attempts + 1,
      nextAttemptAt: null,
      rejectionReason: input.reason,
    },
  });
}

/**
 * A transient failure: the command stays PENDING with its key intact and is
 * rescheduled by the shared retail-terminal backoff policy, or dead-lettered once
 * the attempts run out. Reusing that planner is what keeps the pharmacy outbox
 * and the restaurant outbox on one retry rule instead of two.
 */
export async function deferOfflineCommand(
  db: ScopedDb,
  scope: OfflineCommandScope,
  input: { commandId: string; error: string },
  now: Date,
  policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY
) {
  const command = await db.pharmacyOfflineCommand.findFirst({
    where: {
      id: input.commandId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, status: true, attempts: true, nextAttemptAt: true },
  });
  if (!command) throw new PharmacyOfflineCommandError('NOT_FOUND');
  if (command.status !== 'PENDING') throw new PharmacyOfflineCommandError('ALREADY_SETTLED');

  const patch = planDispatchFailure(
    {
      id: command.id,
      status: 'PENDING',
      attempts: command.attempts,
      nextAttemptAt: command.nextAttemptAt,
    },
    now,
    input.error,
    policy
  );

  return db.pharmacyOfflineCommand.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: command.id } },
    data:
      patch.status === 'DEAD'
        ? {
            status: 'DEAD',
            settledAt: now,
            attempts: patch.attempts,
            nextAttemptAt: null,
            rejectionReason: `Replay abandoned after ${patch.attempts} attempts.`,
            lastError: patch.lastError,
          }
        : {
            attempts: patch.attempts,
            nextAttemptAt: patch.nextAttemptAt,
            lastError: patch.lastError,
          },
  });
}
