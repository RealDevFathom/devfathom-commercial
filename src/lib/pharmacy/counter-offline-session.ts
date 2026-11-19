/**
 * DEV-957 phase 1: opening an enrolled counter's offline runtime, installing its
 * signed snapshots, and the manager's "Prepare this counter for offline".
 *
 * Transport, storage, verification and hashing are injected, so this runs the
 * same against the browser (fetch, IndexedDB, WebCrypto) and against tests.
 * Nothing here decides money, stock or receipt numbers: the server signs the
 * snapshots, reserves the receipt block and grants each quota (with its
 * database capacity guard), and the runtime only records what it was given
 * after verifying it.
 */
import type { TerminalStorageDriver } from '@/lib/retail-terminal/local-store';

import { unsettledCommands, type CounterQuota } from './counter-command-queue';
import { PharmacyCounterRuntime, type SnapshotVerifier } from './counter-offline-runtime';
import type { CounterEnrolment } from './counter-device-store';
import type { CounterSignedSnapshot } from './counter-offline-transport';
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

/** Receipt numbers a manager reserves when preparing; the server caps a block at 1,000. */
export const COUNTER_PREPARE_RECEIPT_BLOCK = 200;

export type CounterEstablishedSession = {
  sessionToken: string;
  snapshotPublicKey: string;
  device: { id: string };
  /** DEV-957 phase 2: when the server stops renewing this counter, and whether to renew now. */
  credential?: { expiresAt: string; expired: boolean; renewDue: boolean };
};

export type CounterOfflineTransport = {
  establish(): Promise<CounterEstablishedSession>;
  /** DEV-957 phase 2: rotate this counter's own secret; the new one comes back once. */
  renew?(token: string): Promise<{ secret: string; credentialExpiresAt: string }>;
  snapshots(token: string): Promise<{ snapshots: CounterSignedSnapshot[]; publicKey: string }>;
  lease(token: string, size: number): Promise<unknown>;
  quota(
    token: string,
    input: { inventoryLotId: string; stockLocationId: string; units: number }
  ): Promise<unknown>;
};

export type CounterOfflineDeps = {
  /**
   * DEV-957 phase 2: keep a renewed secret as this browser's signing key (a new
   * non-extractable WebCrypto key in its own store), then drop the string.
   */
  rekey?: (secret: string) => Promise<void>;
  driver: TerminalStorageDriver;
  verifier: SnapshotVerifier;
  transport: CounterOfflineTransport;
  payloadHash: (payload: unknown) => Promise<string>;
  now: () => number;
};

export type OpenedCounter = {
  runtime: PharmacyCounterRuntime;
  /** In memory only; null when the counter opened offline or establishment failed. */
  sessionToken: string | null;
  /** Why the server could not be used, when it could not. */
  error: unknown;
  hydrated: 'ready' | 'unrecoverable';
  /**
   * DEV-957 phase 2: the server confirmed this counter is revoked. Its local store has
   * been wiped (queued sales included: the server refuses a revoked counter's sales), and
   * `discarded` says how many unsent sales were on it.
   */
  revoked?: { discarded: number };
  /** When the server stops renewing this counter's offline selling, once known online. */
  credentialExpiresAt?: string | null;
  /** The credential could not be renewed although it was due (it still works until expiry). */
  renewalFailed?: boolean;
};

/** The server's answer code on a refused counter request, when it gave one. */
function refusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function scopeOf(enrolment: CounterEnrolment) {
  return {
    organizationId: enrolment.organizationId,
    branchId: enrolment.branchId,
    deviceId: enrolment.deviceId,
  };
}

/**
 * Online: establish the terminal session first, so the runtime trusts the
 * public key this server hands out. Offline (or when establishment fails): open
 * the stored document only, with the key it was stored with.
 */
export async function openCounterRuntime(
  enrolment: CounterEnrolment,
  deps: CounterOfflineDeps,
  online: boolean
): Promise<OpenedCounter> {
  let sessionToken: string | null = null;
  let publicKey = '';
  let error: unknown = null;
  let credentialExpiresAt: string | null = null;
  let renewalFailed = false;
  if (online) {
    try {
      let established = await deps.transport.establish();
      if (established.device.id !== enrolment.deviceId) throw new Error('device_mismatch');
      credentialExpiresAt = established.credential?.expiresAt ?? null;
      // DEV-957 phase 2: renew the secret while it is still valid, then start a session
      // with the new one (the old session names the old secret and stops working).
      if (established.credential?.renewDue && deps.transport.renew && deps.rekey) {
        try {
          const renewed = await deps.transport.renew(established.sessionToken);
          await deps.rekey(renewed.secret);
          established = await deps.transport.establish();
          if (established.device.id !== enrolment.deviceId) throw new Error('device_mismatch');
          credentialExpiresAt = established.credential?.expiresAt ?? renewed.credentialExpiresAt;
        } catch (failure) {
          if (refusalCode(failure) === 'device_revoked') throw failure;
          renewalFailed = true;
        }
      }
      sessionToken = established.sessionToken;
      publicKey = established.snapshotPublicKey;
    } catch (failure) {
      error = failure;
    }
  }
  const runtime = new PharmacyCounterRuntime(
    scopeOf(enrolment),
    deps.driver,
    deps.verifier,
    publicKey
  );
  // DEV-957 phase 2 (remote revoke): only the server's own word that this counter is
  // revoked wipes it. Nothing can be queued afterwards: the document is gone, the queue
  // reads STOPPED_REVOKED in memory, and the caller forgets the enrolment and its key.
  if (refusalCode(error) === 'device_revoked') {
    // Read first, so the counter can say how many unsent sales the revoke cost.
    await runtime.hydrate().catch(() => 'unrecoverable');
    const discarded = (await runtime.revoke().catch(() => null))?.commands ?? 0;
    return {
      runtime,
      sessionToken: null,
      error,
      hydrated: 'ready',
      revoked: { discarded },
      credentialExpiresAt,
    };
  }
  const hydrated = await runtime.hydrate();
  // A document this runtime cannot read (another counter's queue, another
  // schema, corrupt) must never be overwritten by a lease or a snapshot: with
  // no session nothing can be reserved or installed, and the caller shows
  // recovery guidance instead.
  if (hydrated === 'unrecoverable')
    return { runtime, sessionToken: null, error: new Error('unrecoverable_document'), hydrated };
  return { runtime, sessionToken, error, hydrated, credentialExpiresAt, renewalFailed };
}

export type SnapshotInstallReport = {
  installed: PharmacyOfflineSnapshotKind[];
  refused: Array<{ kind: string; reason: string }>;
};

function quotasFrom(payload: unknown): CounterQuota[] | null {
  if (!Array.isArray(payload)) return null;
  const quotas: CounterQuota[] = [];
  for (const row of payload) {
    if (!row || typeof row !== 'object') return null;
    const { inventoryLotId, stockLocationId, quotaUnits, consumedUnits } = row as Record<
      string,
      unknown
    >;
    if (
      typeof inventoryLotId !== 'string' ||
      typeof stockLocationId !== 'string' ||
      !Number.isSafeInteger(quotaUnits) ||
      !Number.isSafeInteger(consumedUnits) ||
      (consumedUnits as number) < 0 ||
      (consumedUnits as number) > (quotaUnits as number)
    )
      return null;
    quotas.push({
      inventoryLotId,
      stockLocationId,
      quotaUnits: quotaUnits as number,
      consumedUnits: consumedUnits as number,
    });
  }
  return quotas;
}

/**
 * Fetch fresh signed snapshots and install each one the runtime verifies. A
 * refused snapshot (bad signature, tampered payload, outside its window, other
 * counter) is not stored and is reported. The counter's quota ledger follows
 * the signed LOT_BALANCES only while no sale is waiting to be sent, so a local
 * debit is never undone by an older server figure.
 */
export async function installCounterSnapshots(
  runtime: PharmacyCounterRuntime,
  sessionToken: string,
  deps: CounterOfflineDeps
): Promise<SnapshotInstallReport> {
  const { snapshots } = await deps.transport.snapshots(sessionToken);
  const report: SnapshotInstallReport = { installed: [], refused: [] };
  for (const snapshot of snapshots) {
    const kind = String(snapshot?.envelope?.kind ?? 'UNKNOWN');
    let result;
    try {
      result = await runtime.installSnapshot({
        envelope: snapshot.envelope,
        signature: snapshot.signature,
        payload: snapshot.payload,
        payloadHash: await deps.payloadHash(snapshot.payload),
        nowMs: deps.now(),
      });
    } catch {
      report.refused.push({ kind, reason: 'STORAGE' });
      continue;
    }
    if (result.ok) report.installed.push(snapshot.envelope.kind);
    else report.refused.push({ kind, reason: result.reason });
  }
  if (report.installed.includes('LOT_BALANCES')) {
    const state = runtime.snapshot();
    const quotas = quotasFrom(runtime.payloadFor('LOT_BALANCES'));
    if (quotas && state.queue && unsettledCommands(state.queue).length === 0)
      await runtime.adoptQuotas(quotas);
  }
  return report;
}

export type PrepareGrant = { inventoryLotId: string; stockLocationId: string; units: number };

export type PrepareReport = {
  receipts: 'RESERVED' | 'ALREADY_HELD' | 'FAILED';
  receiptNumbersLeft: number;
  granted: number;
  refused: Array<{ grant: PrepareGrant; error: unknown }>;
  snapshots: SnapshotInstallReport | null;
};

/**
 * "Prepare this counter for offline": reserve a receipt block when fewer than a
 * block's worth of numbers are left, grant each chosen quota one by one (each
 * through the manager-only route and the capacity guard), then refresh the
 * signed snapshots so the counter carries the new quotas.
 */
export async function prepareCounterForOffline(
  runtime: PharmacyCounterRuntime,
  sessionToken: string,
  deps: CounterOfflineDeps,
  input: { receiptBlock?: number; grants: readonly PrepareGrant[] }
): Promise<PrepareReport> {
  const size = input.receiptBlock ?? COUNTER_PREPARE_RECEIPT_BLOCK;
  const renewal = await runtime.renewReceiptLeases((blockSize) => deps.transport.lease(sessionToken, blockSize), {
    lowWater: size,
    size,
  });
  const report: PrepareReport = {
    receipts:
      renewal.status === 'RENEWED'
        ? 'RESERVED'
        : renewal.status === 'SUFFICIENT'
          ? 'ALREADY_HELD'
          : 'FAILED',
    receiptNumbersLeft: renewal.remaining,
    granted: 0,
    refused: [],
    snapshots: null,
  };
  for (const grant of input.grants) {
    if (!Number.isSafeInteger(grant.units) || grant.units <= 0) continue;
    try {
      await deps.transport.quota(sessionToken, grant);
      report.granted += 1;
    } catch (error) {
      report.refused.push({ grant, error });
    }
  }
  report.snapshots = await installCounterSnapshots(runtime, sessionToken, deps);
  return report;
}

/**
 * DEV-957 phase 2 (shared till): forget every offline bill being built on this computer,
 * for sign-out. Queued sales are kept: they are money already taken and must still be
 * sent. Never throws; a computer that is not a counter has nothing to forget.
 */
export async function discardCounterDrafts(
  enrolment: CounterEnrolment | null,
  driver: TerminalStorageDriver
): Promise<void> {
  if (!enrolment) return;
  try {
    // Never verifies anything: it only reads the stored document and rewrites its drafts.
    const runtime = new PharmacyCounterRuntime(scopeOf(enrolment), driver, { verify: () => false }, '');
    try {
      if ((await runtime.hydrate()) === 'ready' && runtime.drafts().length > 0)
        await runtime.discardDrafts();
    } finally {
      runtime.close();
    }
  } catch {
    // Storage blocked or unreadable: nothing to forget there.
  }
}
