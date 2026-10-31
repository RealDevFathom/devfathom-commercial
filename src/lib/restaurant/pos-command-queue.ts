/**
 * M9-L1 — the POS terminal's device-bound offline draft queue and replay classifier.
 *
 * CLIENT-SAFE, and deliberately PURE: every export is either a data shape or a
 * total state transition over `PosQueueSnapshot`. No fetch, no timers, no storage
 * calls — persistence belongs to `pos-client-store.ts` and transport belongs to the
 * POS surface (L3). That is what makes the correctness contract testable without a
 * browser, a server or a clock.
 *
 * The promise this implements is the NARROW one from M9 §3.3: locally composed NEW
 * order drafts survive a transient disconnect and replay as ordinary M4 commands.
 * Tenders, refunds, drawers, close, customer/loyalty and edits to an order the
 * server already owns are connected-only and never enter this queue.
 *
 * The five invariants worth stating out loud:
 *
 *  - **Stable keys.** Each command carries a UUID minted once at compose time and
 *    used verbatim as its `Idempotency-Key` on every attempt, across reloads. The
 *    crash window (server committed, response lost) therefore resolves to ONE
 *    server-side effect (criterion 3).
 *  - **FIFO by persisted sequence, never by clock.** Ordering uses a per-device
 *    monotonic counter that lives in the persisted snapshot. Client-origin time is
 *    carried as metadata only (M9 amendment §2.3).
 *  - **Resume at the first unacknowledged command.** A partially applied draft
 *    (open acknowledged, add-item lost) resumes at the add-item, and the server
 *    order id captured from the open is threaded into the later commands.
 *  - **Device binding.** A snapshot names its device; a mismatch refuses replay
 *    outright. Queued work is never rebound to a replacement device.
 *  - **Re-auth is not revocation.** A generic 401/403/423 PAUSES replay and keeps
 *    the (non-sensitive) drafts; only a CONFIRMED device revocation — as judged by
 *    the existing terminal failure classifier — purges and reports the discarded
 *    count (M9 amendment §2.2, criterion 4).
 */
import { browserUuid } from '@/lib/browser-uuid';
import type { TerminalReplayOutcome } from '@/lib/retail-terminal/replay-outcome';

/**
 * The replay classifier is the neutral retail-terminal seam (PRD §11), shared
 * with the Pharmacy counter's outbox: the pause-vs-purge rule must be one rule,
 * not two. Re-exported here so every M9 importer keeps its existing import.
 */
export { classifyReplayOutcome, parseRetryAfterMs } from '@/lib/retail-terminal/replay-outcome';
export type { TerminalReplayOutcome as PosReplayOutcome } from '@/lib/retail-terminal/replay-outcome';

import type { PosCatalogSnapshot, PosOrderChannel } from './pos-client-store';
import { findCatalogItem } from './pos-client-store';

/** The visible ceiling on submitted drafts held for one device (M9 §3.5). */
export const MAX_QUEUED_DRAFTS = 50;

// ── Command shapes (the M4 contract, reused verbatim) ────────────────────────

export type PosCommandKind = 'OPEN_ORDER' | 'ADD_ITEM' | 'FIRE';

export type PosOpenOrderBody = {
  channel: PosOrderChannel;
  customerId?: string;
  publicationId?: string | null;
  tableIds?: string[];
  coverCount?: number | null;
  sectionId?: string | null;
  serverStaffProfileId?: string | null;
};

export type PosAddItemBody = {
  menuItemId: string;
  quantity: number;
  course?: number;
  seatNumber?: number | null;
  modifierOptionIds?: string[];
  /**
   * The catalog price the operator saw when composing. LOCAL ONLY: it drives the
   * provisional total and the stale-price review, and `buildReplayRequest` strips
   * it, because the server prices every line and its M4 body is `.strict()`.
   */
  quotedUnitPrice: string | null;
};

export type PosFireBody = { course?: number };

export type PosCommandStatus = 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED';

type CommandBase = {
  commandId: string;
  /** Always `commandId`: one stable device-scoped key per command, for every attempt. */
  idempotencyKey: string;
  status: PosCommandStatus;
  attempts: number;
  /** The id the server returned for this command; set once, on acknowledgement. */
  serverRef: string | null;
};

export type PosQueuedCommand =
  | (CommandBase & { kind: 'OPEN_ORDER'; body: PosOpenOrderBody })
  | (CommandBase & { kind: 'ADD_ITEM'; body: PosAddItemBody })
  | (CommandBase & { kind: 'FIRE'; body: PosFireBody });

// ── Draft and snapshot shapes ────────────────────────────────────────────────

export type PosDraftStatus = 'QUEUED' | 'REPLAYING' | 'NEEDS_REVIEW' | 'QUARANTINED' | 'COMPLETED';

export type PosDraftReviewReason =
  | 'CATALOG_CONFLICT'
  | 'PRICE_CHANGED'
  | 'ITEM_UNAVAILABLE'
  | 'CHANNEL_CLOSED'
  | 'COMPOSER_UNVERIFIED'
  | 'REJECTED';

export type PosDraftReview = {
  reason: PosDraftReviewReason;
  message: string;
  /** The command that raised it, when the trigger was a replay response. */
  atCommandId: string | null;
};

export type PosQueuedDraft = {
  draftId: string;
  /** The device that composed it. Replay is refused on any other device. */
  deviceId: string;
  /** The staff profile that composed it. Replay is refused for another operator. */
  composerStaffProfileId: string;
  /** Server-signed binding of composer, tenant, branch, device, and terminal session. */
  composerProof: string;
  /** Per-device monotonic FIFO position. Never derived from a clock. */
  sequence: number;
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  /** The catalog version the operator composed against (stale detection). */
  catalogVersion: string;
  status: PosDraftStatus;
  /** The server order id captured from the acknowledged OPEN_ORDER. */
  serverOrderId: string | null;
  commands: PosQueuedCommand[];
  review: PosDraftReview | null;
};

export type PosReplayState = 'READY' | 'PAUSED_REAUTH' | 'STOPPED_REVOKED';

export type PosQueueSnapshot = {
  deviceId: string;
  nextSequence: number;
  replay: PosReplayState;
  drafts: PosQueuedDraft[];
};

export function createQueueSnapshot(deviceId: string): PosQueueSnapshot {
  return { deviceId, nextSequence: 1, replay: 'READY', drafts: [] };
}

/** Drafts still occupying the ceiling: everything the operator has not resolved. */
export function pendingDrafts(snapshot: PosQueueSnapshot): PosQueuedDraft[] {
  return snapshot.drafts.filter((draft) => draft.status !== 'COMPLETED');
}

export function countQueuedCommands(snapshot: PosQueueSnapshot): number {
  return snapshot.drafts.reduce(
    (total, draft) =>
      total + draft.commands.filter((command) => command.status !== 'ACKNOWLEDGED').length,
    0
  );
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export type PosDraftInput = {
  deviceId: string;
  composerStaffProfileId: string;
  composerProof: string;
  catalogVersion: string;
  /** Client-origin UTC instant, metadata only. */
  clientOriginAt: string;
  open: PosOpenOrderBody;
  lines: PosAddItemBody[];
  /** Fire the whole order (`true`) or a single course, on submit. */
  fire?: PosFireBody | null;
};

export type EnqueueResult =
  | { ok: true; snapshot: PosQueueSnapshot; draft: PosQueuedDraft }
  | {
      ok: false;
      reason:
        | 'QUEUE_FULL'
        | 'DEVICE_MISMATCH'
        | 'EMPTY_DRAFT'
        | 'DEVICE_REVOKED'
        | 'DELIVERY_CONNECTED_ONLY';
      message: string;
    };

function defaultId(): string {
  return browserUuid();
}

/**
 * Turn a locally composed draft into queued commands with stable keys. Refuses at
 * the visible 50-draft ceiling and refuses a draft composed on another device. The
 * refusal is a value, not a throw, so the POS surface can show it (criterion 3).
 */
export function enqueueDraft(
  snapshot: PosQueueSnapshot,
  input: PosDraftInput,
  newId: () => string = defaultId
): EnqueueResult {
  if (input.open.channel === 'DELIVERY') {
    return {
      ok: false,
      reason: 'DELIVERY_CONNECTED_ONLY',
      message: 'Delivery orders require a connection and cannot be saved to the offline queue.',
    };
  }
  if (input.deviceId !== snapshot.deviceId) {
    return {
      ok: false,
      reason: 'DEVICE_MISMATCH',
      message: 'This draft was composed on a different terminal and cannot be queued here.',
    };
  }
  if (snapshot.replay === 'STOPPED_REVOKED') {
    // A revoked device submits zero later commands (criterion 4), so accepting more
    // local work would only manufacture data the operator can never send.
    return {
      ok: false,
      reason: 'DEVICE_REVOKED',
      message: 'This device has been revoked and can no longer take orders.',
    };
  }
  if (input.lines.length === 0) {
    return { ok: false, reason: 'EMPTY_DRAFT', message: 'Add at least one item before sending.' };
  }
  if (pendingDrafts(snapshot).length >= MAX_QUEUED_DRAFTS) {
    return {
      ok: false,
      reason: 'QUEUE_FULL',
      message: `This terminal is holding ${MAX_QUEUED_DRAFTS} unsent orders. Reconnect or discard queued work before sending another.`,
    };
  }

  // One UUID per command, minted once and reused as the Idempotency-Key forever.
  const base = (): CommandBase => {
    const commandId = newId();
    return {
      commandId,
      idempotencyKey: commandId,
      status: 'PENDING',
      attempts: 0,
      serverRef: null,
    };
  };

  const commands: PosQueuedCommand[] = [
    { ...base(), kind: 'OPEN_ORDER', body: input.open },
    ...input.lines.map((line): PosQueuedCommand => ({ ...base(), kind: 'ADD_ITEM', body: line })),
  ];
  if (input.fire) commands.push({ ...base(), kind: 'FIRE', body: input.fire });

  const draft: PosQueuedDraft = {
    draftId: newId(),
    deviceId: input.deviceId,
    composerStaffProfileId: input.composerStaffProfileId,
    composerProof: input.composerProof,
    sequence: snapshot.nextSequence,
    clientOriginAt: input.clientOriginAt,
    catalogVersion: input.catalogVersion,
    status: 'QUEUED',
    serverOrderId: null,
    commands,
    review: null,
  };

  return {
    ok: true,
    draft,
    snapshot: {
      ...snapshot,
      nextSequence: snapshot.nextSequence + 1,
      drafts: [...snapshot.drafts, draft],
    },
  };
}

// ── FIFO replay selection ────────────────────────────────────────────────────

export type NextReplay =
  | { status: 'READY'; draft: PosQueuedDraft; command: PosQueuedCommand }
  | { status: 'IDLE' }
  | { status: 'PAUSED'; reason: 'REAUTH' }
  | { status: 'STOPPED'; reason: 'DEVICE_REVOKED' }
  | { status: 'REFUSED'; reason: 'DEVICE_MISMATCH' }
  | {
      status: 'REFUSED';
      reason: 'OPERATOR_MISMATCH';
      /** Composers whose drafts wait for their own sign-in; null = legacy, no composer. */
      composerStaffProfileIds: Array<string | null>;
    };

const REPLAYABLE: readonly PosDraftStatus[] = ['QUEUED', 'REPLAYING'];

/** The first unacknowledged command of a draft, or null when it is fully applied. */
export function firstUnacknowledged(draft: PosQueuedDraft): PosQueuedCommand | null {
  return draft.commands.find((command) => command.status !== 'ACKNOWLEDGED') ?? null;
}

/**
 * The next command to send: the first unacknowledged command of the lowest-sequence
 * replayable draft. Drafts awaiting operator review or quarantined are set aside
 * rather than blocking the queue behind them — they are independent new orders, and
 * a single conflicted draft must not strand the other 49. Ordering WITHIN a draft
 * stays strict (open → items → fire).
 *
 * `deviceId` is the device replay is being attempted on: a mismatch refuses, so
 * queued work is never rebound to a replacement device (M9 §3.5).
 */
export function nextReplayCommand(
  snapshot: PosQueueSnapshot,
  deviceId: string,
  staffProfileId: string
): NextReplay {
  if (deviceId !== snapshot.deviceId) return { status: 'REFUSED', reason: 'DEVICE_MISMATCH' };
  if (snapshot.replay === 'STOPPED_REVOKED') {
    return { status: 'STOPPED', reason: 'DEVICE_REVOKED' };
  }
  if (snapshot.replay === 'PAUSED_REAUTH') return { status: 'PAUSED', reason: 'REAUTH' };

  const candidates = snapshot.drafts
    .filter((draft) => REPLAYABLE.includes(draft.status) && draft.deviceId === deviceId)
    .sort((a, b) => a.sequence - b.sequence);

  const waitingComposers = new Set<string | null>();
  for (const draft of candidates) {
    // Another operator's draft is set aside, not adopted and not blocking: replaying
    // it as the current operator would recreate the attribution flaw, while holding
    // the current operator's own later drafts behind it strands them at a handover.
    // Persisted legacy drafts have no composer and are likewise never adoptable.
    if (draft.composerStaffProfileId !== staffProfileId) {
      waitingComposers.add(draft.composerStaffProfileId ?? null);
      continue;
    }
    const command = firstUnacknowledged(draft);
    if (command) return { status: 'READY', draft, command };
  }
  if (waitingComposers.size > 0) {
    return {
      status: 'REFUSED',
      reason: 'OPERATOR_MISMATCH',
      composerStaffProfileIds: [...waitingComposers],
    };
  }
  return { status: 'IDLE' };
}

const COMPOSER_PROOF_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

/**
 * Whether a queued composer proof must be renewed before replay: it is bound to
 * another terminal session, expires within the margin, or cannot be read. This
 * reads the unsigned claims only to avoid needless renewal round-trips; the
 * server still verifies the signature on every command.
 */
export function composerProofNeedsRenewal(
  proof: string,
  sessionId: string,
  nowMs: number
): boolean {
  try {
    const payload = proof.split('.')[1];
    if (!payload) return true;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sessionId?: unknown;
      expiresAt?: unknown;
    };
    return (
      claims.sessionId !== sessionId ||
      typeof claims.expiresAt !== 'number' ||
      claims.expiresAt - COMPOSER_PROOF_RENEWAL_MARGIN_MS <= nowMs
    );
  } catch {
    return true;
  }
}

// ── Request construction (reuses the M4 routes; no bulk API) ─────────────────

export type PosReplayRequest = {
  path: string;
  method: 'POST';
  headers: { 'Idempotency-Key': string; 'X-POS-Composer-Proof': string };
  body: Record<string, unknown>;
};

export type BuildReplayRequestResult =
  | { ok: true; request: PosReplayRequest }
  | { ok: false; reason: 'ORDER_NOT_ESTABLISHED'; message: string };

function omitUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/**
 * Build the HTTP call for one queued command against the EXISTING M4 terminal
 * routes. Two things happen here and nowhere else:
 *
 *  - the server order id from the acknowledged OPEN_ORDER is threaded into the
 *    later commands, which is what makes resume-after-partial-success possible;
 *  - `quotedUnitPrice` is stripped, because it is a local display value and the M4
 *    `addItemBody` schema is strict — the server remains the only pricing authority.
 */
export function buildReplayRequest(
  draft: PosQueuedDraft,
  command: PosQueuedCommand
): BuildReplayRequestResult {
  const headers = {
    'Idempotency-Key': command.idempotencyKey,
    'X-POS-Composer-Proof': draft.composerProof,
  } as const;

  if (command.kind === 'OPEN_ORDER') {
    return {
      ok: true,
      request: {
        path: '/api/restaurant/orders/open',
        method: 'POST',
        headers,
        body: omitUndefined({ ...command.body }),
      },
    };
  }

  const orderId = draft.serverOrderId;
  if (!orderId) {
    return {
      ok: false,
      reason: 'ORDER_NOT_ESTABLISHED',
      message: 'The order must be opened on the server before its items can replay.',
    };
  }

  if (command.kind === 'ADD_ITEM') {
    const line = command.body;
    return {
      ok: true,
      request: {
        path: '/api/restaurant/orders/add-item',
        method: 'POST',
        headers,
        // Named field by field on purpose: `quotedUnitPrice` is local-only, and the
        // M4 body is strict, so an accidental passthrough would be a 400 at replay.
        body: omitUndefined({
          orderId,
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          course: line.course,
          seatNumber: line.seatNumber,
          modifierOptionIds: line.modifierOptionIds,
        }),
      },
    };
  }

  return {
    ok: true,
    request: {
      path: '/api/restaurant/orders/fire',
      method: 'POST',
      headers,
      body: omitUndefined({ orderId, ...command.body }),
    },
  };
}

// ── Replay outcome classifier ────────────────────────────────────────────────

// ── Applying an outcome ──────────────────────────────────────────────────────

export type ApplyReplayResult = {
  snapshot: PosQueueSnapshot;
  /** Set only on a confirmed-revocation purge (criterion 4). */
  discarded: { drafts: number; commands: number } | null;
};

function mapDraft(
  snapshot: PosQueueSnapshot,
  draftId: string,
  update: (draft: PosQueuedDraft) => PosQueuedDraft
): PosQueueSnapshot {
  return {
    ...snapshot,
    drafts: snapshot.drafts.map((draft) => (draft.draftId === draftId ? update(draft) : draft)),
  };
}

function mapCommand(
  draft: PosQueuedDraft,
  commandId: string,
  update: (command: PosQueuedCommand) => PosQueuedCommand
): PosQueuedDraft {
  return {
    ...draft,
    commands: draft.commands.map((command) =>
      command.commandId === commandId ? update(command) : command
    ),
  };
}

/** Mark a command in flight. The key is untouched — every attempt reuses it. */
export function beginReplay(
  snapshot: PosQueueSnapshot,
  draftId: string,
  commandId: string
): PosQueueSnapshot {
  return mapDraft(snapshot, draftId, (draft) => ({
    ...mapCommand(draft, commandId, (command) => ({
      ...command,
      status: 'IN_FLIGHT',
      attempts: command.attempts + 1,
    })),
    status: 'REPLAYING',
  }));
}

/**
 * Fold one classified outcome back into the queue.
 *
 * ACK records the server id (the OPEN_ORDER's becomes the draft's `serverOrderId`,
 * threading later commands) and completes the draft once nothing is unacknowledged.
 * RETRY returns the command to PENDING with its key intact — that is the crash-window
 * guarantee. REVIEW/QUARANTINE set the draft aside for the operator. PAUSE stops
 * replay without touching draft data. PURGE clears everything and reports the count.
 */
export function applyReplayOutcome(
  snapshot: PosQueueSnapshot,
  input: {
    draftId: string;
    commandId: string;
    outcome: TerminalReplayOutcome;
    /** The id the server returned (order id for OPEN_ORDER, item/ticket id otherwise). */
    serverRef?: string | null;
  }
): ApplyReplayResult {
  const { outcome } = input;

  if (outcome.action === 'PURGE') return purgeForRevocation(snapshot);

  if (outcome.action === 'PAUSE') {
    return {
      snapshot: {
        ...pauseCommand(snapshot, input.draftId, input.commandId),
        replay: 'PAUSED_REAUTH',
      },
      discarded: null,
    };
  }

  if (outcome.action === 'RETRY') {
    return { snapshot: pauseCommand(snapshot, input.draftId, input.commandId), discarded: null };
  }

  if (outcome.action === 'REVIEW' || outcome.action === 'QUARANTINE') {
    return {
      snapshot: mapDraft(snapshot, input.draftId, (draft) => ({
        ...mapCommand(draft, input.commandId, (command) => ({ ...command, status: 'PENDING' })),
        status: outcome.action === 'REVIEW' ? 'NEEDS_REVIEW' : 'QUARANTINED',
        review: {
          reason: outcome.reason === 'CATALOG_CONFLICT' ? 'CATALOG_CONFLICT' : 'REJECTED',
          message: outcome.message,
          atCommandId: input.commandId,
        },
      })),
      discarded: null,
    };
  }

  return {
    snapshot: mapDraft(snapshot, input.draftId, (draft) => {
      const acknowledged = mapCommand(draft, input.commandId, (command) => ({
        ...command,
        status: 'ACKNOWLEDGED',
        // Written once: a duplicate acknowledgement of the same key (the lost-response
        // replay) keeps the first server id instead of recording a second effect.
        serverRef: command.serverRef ?? input.serverRef ?? null,
      }));
      const opened = acknowledged.commands.find((command) => command.kind === 'OPEN_ORDER');
      const serverOrderId = draft.serverOrderId ?? opened?.serverRef ?? null;
      const done = firstUnacknowledged(acknowledged) === null;
      return {
        ...acknowledged,
        serverOrderId,
        status: done ? 'COMPLETED' : 'REPLAYING',
        review: null,
      };
    }),
    discarded: null,
  };
}

function pauseCommand(
  snapshot: PosQueueSnapshot,
  draftId: string,
  commandId: string
): PosQueueSnapshot {
  return mapDraft(snapshot, draftId, (draft) => ({
    ...mapCommand(draft, commandId, (command) => ({ ...command, status: 'PENDING' })),
    status: 'QUEUED',
  }));
}

// ── Auth lifecycle: pause vs purge ───────────────────────────────────────────

/** Re-authentication succeeded: resume FIFO replay with every draft intact. */
export function resumeAfterReauth(snapshot: PosQueueSnapshot): PosQueueSnapshot {
  if (snapshot.replay === 'STOPPED_REVOKED') return snapshot;
  return { ...snapshot, replay: 'READY' };
}

/**
 * Confirmed device revocation. Queued device-bound work is discarded — it can never
 * be replayed by this device and must not be rebound to another — and the snapshot
 * is left in a state where `nextReplayCommand` submits nothing at all. The counts
 * are returned so the operator is told exactly what was lost (criterion 4).
 */
export function purgeForRevocation(snapshot: PosQueueSnapshot): ApplyReplayResult {
  const discarded = {
    drafts: pendingDrafts(snapshot).length,
    commands: countQueuedCommands(snapshot),
  };
  return { snapshot: { ...snapshot, replay: 'STOPPED_REVOKED', drafts: [] }, discarded };
}

/** The operator explicitly abandons unsent work to clear the ceiling (M9 §3.5). */
export function discardQueuedWork(snapshot: PosQueueSnapshot): ApplyReplayResult {
  const discarded = {
    drafts: pendingDrafts(snapshot).length,
    commands: countQueuedCommands(snapshot),
  };
  return {
    snapshot: { ...snapshot, drafts: snapshot.drafts.filter((d) => d.status === 'COMPLETED') },
    discarded,
  };
}

// ── Catalog review (criterion 5: never a silent stale submission) ────────────

/**
 * Compare one draft against the current catalog. A changed price, a now-unavailable
 * (86'd) item, an item that left the publication, or a closed channel all require
 * OPERATOR REVIEW — the draft is never silently replayed at the stale price, and the
 * server stays the final authority either way.
 *
 * Commands already acknowledged are ignored: the server has priced those lines.
 */
export function reviewAgainstCatalog(
  draft: PosQueuedDraft,
  catalog: PosCatalogSnapshot
): PosDraftReview | null {
  if (!catalog.channelOpen) {
    return {
      reason: 'CHANNEL_CLOSED',
      message: 'This channel is no longer open for orders. Review this order before sending.',
      atCommandId: null,
    };
  }

  for (const command of draft.commands) {
    if (command.kind !== 'ADD_ITEM' || command.status === 'ACKNOWLEDGED') continue;
    const item = findCatalogItem(catalog, command.body.menuItemId);
    if (!item || !item.available) {
      return {
        reason: 'ITEM_UNAVAILABLE',
        message: item
          ? 'An item on this order is no longer available. Review it before sending.'
          : 'An item on this order is no longer on the menu. Review it before sending.',
        atCommandId: command.commandId,
      };
    }
    if (item.price !== command.body.quotedUnitPrice) {
      return {
        reason: 'PRICE_CHANGED',
        message: 'A price on this order changed. Review it before sending.',
        atCommandId: command.commandId,
      };
    }
  }

  // A newer catalog version alone is not a conflict: the draft is re-validated line
  // by line above, so an unrelated publication change must not nag the operator.
  return null;
}

/**
 * Re-check every unresolved draft after a catalog refresh and flag the ones that now
 * need review. Drafts that are still consistent are returned to `QUEUED` so a
 * transient 86 that was reversed does not strand them.
 */
export function markDraftsForCatalogReview(
  snapshot: PosQueueSnapshot,
  catalog: PosCatalogSnapshot
): { snapshot: PosQueueSnapshot; flagged: number } {
  let flagged = 0;
  const drafts = snapshot.drafts.map((draft) => {
    if (draft.status === 'COMPLETED' || draft.status === 'QUARANTINED') return draft;
    const review = reviewAgainstCatalog(draft, catalog);
    if (review) {
      flagged += 1;
      return { ...draft, status: 'NEEDS_REVIEW' as const, review };
    }
    if (draft.status === 'NEEDS_REVIEW')
      return { ...draft, status: 'QUEUED' as const, review: null };
    return draft;
  });
  return { snapshot: { ...snapshot, drafts }, flagged };
}

/** The operator resolved a reviewed draft: send it as composed, or drop it. */
export function resolveReviewedDraft(
  snapshot: PosQueueSnapshot,
  draftId: string,
  decision: 'REPLAY' | 'DISCARD',
  catalogVersion: string
): PosQueueSnapshot {
  if (decision === 'DISCARD') {
    return { ...snapshot, drafts: snapshot.drafts.filter((d) => d.draftId !== draftId) };
  }
  // A review cannot establish authorship for work saved before composer proofs.
  if (
    snapshot.drafts.find((draft) => draft.draftId === draftId)?.review?.reason ===
    'COMPOSER_UNVERIFIED'
  )
    return snapshot;
  return mapDraft(snapshot, draftId, (draft) => ({
    ...draft,
    status: 'QUEUED',
    review: null,
    // Re-baselined: the operator accepted the current catalog for this draft.
    catalogVersion,
  }));
}
