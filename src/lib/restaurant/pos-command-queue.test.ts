/**
 * M9-L1 — the POS offline command-queue battery (acceptance criteria 3 and 4).
 *
 * The queue is pure state, so the whole contract — stable keys, FIFO by persisted
 * sequence, resume-at-first-unacknowledged, the crash window, the 50-draft ceiling,
 * device binding, the replay classifier, re-auth vs confirmed revocation, and
 * review-before-stale-submit — is provable without a browser, a server or a clock.
 *
 * `terminal-orders.ts` is imported for its REAL M4 body schemas: the replay request
 * builder is checked against the same strict Zod objects the routes use, so a drift
 * between the queued draft and the server contract fails here rather than at 3am.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  MAX_QUEUED_DRAFTS,
  applyReplayOutcome,
  beginReplay,
  buildReplayRequest,
  classifyReplayOutcome,
  composerProofNeedsRenewal,
  countQueuedCommands,
  createQueueSnapshot,
  discardQueuedWork,
  enqueueDraft,
  firstUnacknowledged,
  markDraftsForCatalogReview,
  nextReplayCommand,
  parseRetryAfterMs,
  pendingDrafts,
  purgeForRevocation,
  resolveReviewedDraft,
  resumeAfterReauth,
  reviewAgainstCatalog,
  type PosDraftInput,
  type PosQueueSnapshot,
  type PosQueuedDraft,
} from './pos-command-queue';
import {
  assertPersistSafe,
  createMemoryDriver,
  emptyPosState,
  posScopeKey,
  readPosState,
  writePosState,
  type PosCatalogSnapshot,
  type PosScope,
} from './pos-client-store';
import { addItemBody, fireBody, openOrderBody } from './terminal-orders';

const DEVICE = 'device-1';
const OPERATOR = 'staff-1';
const scope: PosScope = { organizationId: 'org-1', branchId: 'branch-1', deviceId: DEVICE };

/** Deterministic ids: `c1`, `c2`, … so assertions can name a command. */
function ids(prefix = 'c') {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

function draftInput(overrides: Partial<PosDraftInput> = {}): PosDraftInput {
  return {
    deviceId: DEVICE,
    composerStaffProfileId: OPERATOR,
    composerProof: 'signed-composer-proof',
    catalogVersion: 'v1:aaaa',
    clientOriginAt: '2026-08-27T10:00:00.000Z',
    open: { channel: 'DINE_IN', tableIds: ['t1'], coverCount: 2 },
    lines: [{ menuItemId: 'mi-1', quantity: 2, quotedUnitPrice: '450.00' }],
    fire: {},
    ...overrides,
  };
}

function seeded(inputs: PosDraftInput[], newId = ids()): PosQueueSnapshot {
  return inputs.reduce((snapshot, input) => {
    const result = enqueueDraft(snapshot, input, newId);
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
    return result.snapshot;
  }, createQueueSnapshot(DEVICE));
}

it('rejects delivery before creating any offline command', () => {
  const result = enqueueDraft(
    createQueueSnapshot(DEVICE),
    draftInput({
      open: { channel: 'DELIVERY', customerId: 'customer-1' },
    }),
    ids()
  );
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      reason: 'DELIVERY_CONNECTED_ONLY',
    })
  );
});

const catalog = (overrides: Partial<PosCatalogSnapshot> = {}): PosCatalogSnapshot => ({
  version: 'v1:aaaa',
  branchId: 'branch-1',
  channel: 'DINE_IN',
  publicationId: 'pub-1',
  channelOpen: true,
  menuId: 'menu-1',
  menuName: 'All day',
  fetchedAtClient: '2026-08-27T10:00:00.000Z',
  sections: [
    {
      sectionId: 'sec-1',
      name: 'Grill',
      sortOrder: 1,
      items: [
        {
          menuItemId: 'mi-1',
          productId: 'prod-1',
          variantId: null,
          name: 'Seekh Kebab',
          sortOrder: 1,
          price: '450.00',
          priceSource: 'PUBLICATION_LIST',
          available: true,
        },
      ],
    },
  ],
  ...overrides,
});

// ── Stable keys and composition ──────────────────────────────────────────────

describe('stable command keys (criterion 3)', () => {
  it('mints one UUID per command and uses it verbatim as the idempotency key', () => {
    const snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    expect(draft.commands.map((c) => c.kind)).toEqual(['OPEN_ORDER', 'ADD_ITEM', 'FIRE']);
    for (const command of draft.commands) {
      expect(command.idempotencyKey).toBe(command.commandId);
      expect(command.status).toBe('PENDING');
      expect(command.attempts).toBe(0);
    }
    expect(new Set(draft.commands.map((c) => c.commandId)).size).toBe(3);
  });

  it('keeps the same keys across a persistence round trip (a reload)', async () => {
    const driver = createMemoryDriver();
    const snapshot = seeded([draftInput()]);
    const before = snapshot.drafts[0].commands.map((c) => c.idempotencyKey);

    await writePosState(driver, { ...emptyPosState<PosQueueSnapshot>(scope), queue: snapshot });
    const raw = await driver.read(posScopeKey(scope));
    const reloaded = createMemoryDriver([[posScopeKey(scope), raw]]);
    const read = await readPosState<PosQueueSnapshot>(reloaded, scope);

    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.state.queue?.drafts[0].commands.map((c) => c.idempotencyKey)).toEqual(before);
    expect(read.state.queue?.nextSequence).toBe(2);
  });

  it('holds nothing the store denylists', () => {
    const snapshot = seeded([draftInput()]);
    expect(() => assertPersistSafe(snapshot)).not.toThrow();
  });

  it('retries reuse the key and only advance the attempt counter', () => {
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    const key = draft.commands[0].idempotencyKey;

    snapshot = beginReplay(snapshot, draft.draftId, draft.commands[0].commandId);
    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[0].commandId,
      outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
    }).snapshot;
    snapshot = beginReplay(snapshot, draft.draftId, draft.commands[0].commandId);

    expect(snapshot.drafts[0].commands[0].idempotencyKey).toBe(key);
    expect(snapshot.drafts[0].commands[0].attempts).toBe(2);
  });
});

// ── FIFO ordering ────────────────────────────────────────────────────────────

describe('FIFO replay by persisted sequence, never a clock (criterion 3)', () => {
  it('orders by sequence even when client-origin time runs backwards', () => {
    const snapshot = seeded([
      draftInput({ clientOriginAt: '2026-08-27T12:00:00.000Z' }),
      draftInput({ clientOriginAt: '2026-08-27T09:00:00.000Z' }), // skewed clock
      draftInput({ clientOriginAt: '2026-08-27T11:00:00.000Z' }),
    ]);
    expect(snapshot.drafts.map((d) => d.sequence)).toEqual([1, 2, 3]);

    const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
    expect(next.status).toBe('READY');
    if (next.status !== 'READY') return;
    expect(next.draft.sequence).toBe(1);
    expect(next.draft.clientOriginAt).toBe('2026-08-27T12:00:00.000Z');
  });

  it('walks a draft open → item → fire and only then moves to the next draft', () => {
    let snapshot = seeded([draftInput(), draftInput()]);
    const order: string[] = [];

    for (let step = 0; step < 6; step += 1) {
      const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
      if (next.status !== 'READY') break;
      order.push(`${next.draft.sequence}:${next.command.kind}`);
      snapshot = beginReplay(snapshot, next.draft.draftId, next.command.commandId);
      snapshot = applyReplayOutcome(snapshot, {
        draftId: next.draft.draftId,
        commandId: next.command.commandId,
        outcome: { action: 'ACK' },
        serverRef: `server-${order.length}`,
      }).snapshot;
    }

    expect(order).toEqual([
      '1:OPEN_ORDER',
      '1:ADD_ITEM',
      '1:FIRE',
      '2:OPEN_ORDER',
      '2:ADD_ITEM',
      '2:FIRE',
    ]);
    expect(snapshot.drafts.every((d) => d.status === 'COMPLETED')).toBe(true);
    expect(nextReplayCommand(snapshot, DEVICE, OPERATOR).status).toBe('IDLE');
  });

  it('resumes at the first unacknowledged command after a partial application', () => {
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];

    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[0].commandId,
      outcome: { action: 'ACK' },
      serverRef: 'order-1',
    }).snapshot;

    expect(snapshot.drafts[0].serverOrderId).toBe('order-1');
    expect(firstUnacknowledged(snapshot.drafts[0])?.kind).toBe('ADD_ITEM');

    const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
    if (next.status !== 'READY') throw new Error('expected a resumable command');
    expect(next.command.kind).toBe('ADD_ITEM');
    // The item command now carries the server's order id, not a local draft id.
    const built = buildReplayRequest(next.draft, next.command);
    expect(built.ok && built.request.body.orderId).toBe('order-1');
  });

  it('sets a reviewed or quarantined draft aside instead of stranding the queue', () => {
    let snapshot = seeded([draftInput(), draftInput()]);
    const first = snapshot.drafts[0];
    snapshot = applyReplayOutcome(snapshot, {
      draftId: first.draftId,
      commandId: first.commands[0].commandId,
      outcome: { action: 'QUARANTINE', reason: 'REJECTED', message: 'refused' },
    }).snapshot;

    expect(snapshot.drafts[0].status).toBe('QUARANTINED');
    const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
    if (next.status !== 'READY') throw new Error('expected the second draft to replay');
    expect(next.draft.sequence).toBe(2);
  });
});

// ── The crash window ─────────────────────────────────────────────────────────

describe('the crash window: committed server-side, response lost (criterion 3)', () => {
  /** A server that dedupes on Idempotency-Key, exactly as the M4 command layer does. */
  function fakeServer() {
    const byKey = new Map<string, string>();
    let created = 0;
    return {
      created: () => created,
      submit(key: string): string {
        const existing = byKey.get(key);
        if (existing) return existing;
        created += 1;
        const id = `order-${created}`;
        byKey.set(key, id);
        return id;
      },
    };
  }

  it('replays the same key after a reload and produces exactly one server result', async () => {
    const server = fakeServer();
    const driver = createMemoryDriver();
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    const open = draft.commands[0];

    // Attempt 1: the server commits, then the response is lost on the wire.
    snapshot = beginReplay(snapshot, draft.draftId, open.commandId);
    server.submit(open.idempotencyKey);
    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: open.commandId,
      outcome: classifyReplayOutcome({ status: 0 }),
    }).snapshot;

    // The pad reloads mid-flight; the queue comes back off disk unchanged.
    await writePosState(driver, { ...emptyPosState<PosQueueSnapshot>(scope), queue: snapshot });
    const read = await readPosState<PosQueueSnapshot>(driver, scope);
    if (read.status !== 'ok' || !read.state.queue) throw new Error('queue did not survive reload');
    snapshot = read.state.queue;

    // Attempt 2: same command, same key.
    const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
    if (next.status !== 'READY') throw new Error('expected the open command to be replayable');
    expect(next.command.commandId).toBe(open.commandId);
    const built = buildReplayRequest(next.draft, next.command);
    if (!built.ok) throw new Error('expected a replay request');
    expect(built.request.headers['Idempotency-Key']).toBe(open.idempotencyKey);
    expect(built.request.headers['X-POS-Composer-Proof']).toBe('signed-composer-proof');

    const serverRef = server.submit(built.request.headers['Idempotency-Key']);
    snapshot = applyReplayOutcome(snapshot, {
      draftId: next.draft.draftId,
      commandId: next.command.commandId,
      outcome: { action: 'ACK' },
      serverRef,
    }).snapshot;

    expect(server.created()).toBe(1);
    expect(snapshot.drafts[0].serverOrderId).toBe('order-1');
  });

  it('keeps the first server id when an acknowledgement arrives twice', () => {
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    const apply = (serverRef: string) =>
      applyReplayOutcome(snapshot, {
        draftId: draft.draftId,
        commandId: draft.commands[0].commandId,
        outcome: { action: 'ACK' },
        serverRef,
      }).snapshot;

    snapshot = apply('order-1');
    snapshot = apply('order-2');
    expect(snapshot.drafts[0].commands[0].serverRef).toBe('order-1');
    expect(snapshot.drafts[0].serverOrderId).toBe('order-1');
  });
});

// ── The ceiling and device binding ───────────────────────────────────────────

describe('the visible 50-draft ceiling and device binding (criterion 3)', () => {
  it('refuses the 51st draft visibly and accepts again after a discard', () => {
    const full = seeded(Array.from({ length: MAX_QUEUED_DRAFTS }, () => draftInput()));
    expect(pendingDrafts(full)).toHaveLength(50);

    const refused = enqueueDraft(full, draftInput(), ids('x'));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('QUEUE_FULL');
    expect(refused.message).toContain('50');

    const cleared = discardQueuedWork(full);
    expect(cleared.discarded).toEqual({ drafts: 50, commands: 150 });
    expect(enqueueDraft(cleared.snapshot, draftInput(), ids('y')).ok).toBe(true);
  });

  it('frees ceiling room as drafts complete', () => {
    let snapshot = seeded(Array.from({ length: MAX_QUEUED_DRAFTS }, () => draftInput()));
    const first = snapshot.drafts[0];
    for (const command of first.commands) {
      snapshot = applyReplayOutcome(snapshot, {
        draftId: first.draftId,
        commandId: command.commandId,
        outcome: { action: 'ACK' },
        serverRef: 'srv',
      }).snapshot;
    }
    expect(snapshot.drafts[0].status).toBe('COMPLETED');
    expect(enqueueDraft(snapshot, draftInput(), ids('z')).ok).toBe(true);
  });

  it('refuses to queue or replay work bound to a different device', () => {
    const snapshot = seeded([draftInput()]);
    const foreign = enqueueDraft(snapshot, draftInput({ deviceId: 'device-2' }), ids('f'));
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe('DEVICE_MISMATCH');

    const replay = nextReplayCommand(snapshot, 'device-2', OPERATOR);
    expect(replay).toEqual({ status: 'REFUSED', reason: 'DEVICE_MISMATCH' });
  });

  it('refuses to adopt a legacy persisted draft with no composing operator', () => {
    const snapshot = seeded([draftInput()]);
    const legacyDraft = snapshot.drafts[0] as Partial<PosQueuedDraft>;
    delete legacyDraft.composerStaffProfileId;
    delete legacyDraft.composerProof;

    expect(nextReplayCommand(snapshot, DEVICE, OPERATOR)).toEqual({
      status: 'REFUSED',
      reason: 'OPERATOR_MISMATCH',
      composerStaffProfileIds: [null],
    });
  });

  it("sets another operator's draft aside without stranding the current operator's later work", () => {
    const snapshot = seeded([
      draftInput({ composerStaffProfileId: 'staff-2', composerProof: 'proof-b' }),
      draftInput(),
    ]);

    const next = nextReplayCommand(snapshot, DEVICE, OPERATOR);
    expect(next.status).toBe('READY');
    if (next.status === 'READY') {
      expect(next.draft.composerStaffProfileId).toBe(OPERATOR);
      expect(next.draft.sequence).toBe(snapshot.drafts[1].sequence);
    }

    const done = {
      ...snapshot,
      drafts: snapshot.drafts.map((draft, index) =>
        index === 1 ? { ...draft, status: 'COMPLETED' as const } : draft
      ),
    };
    expect(nextReplayCommand(done, DEVICE, OPERATOR)).toEqual({
      status: 'REFUSED',
      reason: 'OPERATOR_MISMATCH',
      composerStaffProfileIds: ['staff-2'],
    });
    expect(nextReplayCommand(done, DEVICE, 'staff-2').status).toBe('READY');
  });
});

describe('composer proof renewal check', () => {
  const NOW = Date.parse('2026-10-31T12:00:00.000Z');
  const proof = (claims: Record<string, unknown>) =>
    `v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

  it('skips renewal for a fresh proof bound to the current session', () => {
    expect(
      composerProofNeedsRenewal(
        proof({ sessionId: 'session-1', expiresAt: NOW + 60 * 60 * 1000 }),
        'session-1',
        NOW
      )
    ).toBe(false);
  });

  it('renews expired, nearly expired, other-session, and unreadable proofs', () => {
    expect(
      composerProofNeedsRenewal(
        proof({ sessionId: 'session-1', expiresAt: NOW - 1 }),
        'session-1',
        NOW
      )
    ).toBe(true);
    expect(
      composerProofNeedsRenewal(
        proof({ sessionId: 'session-1', expiresAt: NOW + 60 * 1000 }),
        'session-1',
        NOW
      )
    ).toBe(true);
    expect(
      composerProofNeedsRenewal(
        proof({ sessionId: 'session-0', expiresAt: NOW + 60 * 60 * 1000 }),
        'session-1',
        NOW
      )
    ).toBe(true);
    expect(composerProofNeedsRenewal('signed-composer-proof', 'session-1', NOW)).toBe(true);
    expect(composerProofNeedsRenewal('v1.%%%.sig', 'session-1', NOW)).toBe(true);
  });
});

// ── The replay classifier ────────────────────────────────────────────────────

describe('replay classifier (criteria 3 and 4)', () => {
  it('retries transient failures with the same key', () => {
    expect(classifyReplayOutcome({ status: 0 })).toEqual({
      action: 'RETRY',
      reason: 'NETWORK',
      retryAfterMs: null,
    });
    expect(classifyReplayOutcome({ status: 408 })).toMatchObject({
      action: 'RETRY',
      reason: 'TIMEOUT',
    });
    for (const status of [500, 502, 503, 504]) {
      expect(classifyReplayOutcome({ status }), String(status)).toMatchObject({
        action: 'RETRY',
        reason: 'SERVER',
      });
    }
  });

  it('obeys Retry-After on 429 and falls back when it is not a second count', () => {
    expect(classifyReplayOutcome({ status: 429, retryAfter: '12' })).toEqual({
      action: 'RETRY',
      reason: 'RATE_LIMITED',
      retryAfterMs: 12_000,
    });
    expect(classifyReplayOutcome({ status: 429, retryAfter: null })).toMatchObject({
      retryAfterMs: null,
    });
    expect(parseRetryAfterMs('Wed, 27 Aug 2026 10:00:00 GMT')).toBeNull();
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('-5')).toBeNull();
  });

  it('quarantines a permanently rejected draft rather than looping', () => {
    for (const status of [400, 404, 410, 422]) {
      expect(classifyReplayOutcome({ status }), String(status)).toMatchObject({
        action: 'QUARANTINE',
        reason: 'REJECTED',
      });
    }
  });

  it('sends a 409 to operator review, never to a silent retry', () => {
    expect(classifyReplayOutcome({ status: 409 })).toMatchObject({
      action: 'REVIEW',
      reason: 'CATALOG_CONFLICT',
    });
  });

  it('distinguishes re-authentication from a confirmed device revocation', () => {
    // Confirmed revocation: the existing terminal classifier's `revoked` verdict.
    expect(
      classifyReplayOutcome({ status: 403, serverMessage: 'This device has been revoked.' })
    ).toMatchObject({ action: 'PURGE', reason: 'DEVICE_REVOKED' });

    // Everything else on the auth family only pauses.
    for (const input of [
      {
        status: 401,
        serverMessage: 'Terminal session is no longer valid; re-establish the session.',
      },
      { status: 401, serverMessage: 'Credential refused.' },
      { status: 403, serverMessage: 'This terminal is not permitted to complete that request.' },
      { status: 423, serverMessage: 'Credential locked.', retryAfter: '30' },
    ]) {
      expect(classifyReplayOutcome(input), String(input.status)).toMatchObject({
        action: 'PAUSE',
        reason: 'REAUTH',
      });
    }
  });
});

// ── Pause vs purge ───────────────────────────────────────────────────────────

describe('re-auth pauses, confirmed revocation purges (criterion 4)', () => {
  it('preserves every queued draft across a session expiry and resumes after re-auth', () => {
    let snapshot = seeded([draftInput(), draftInput()]);
    const draft = snapshot.drafts[0];

    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[0].commandId,
      outcome: classifyReplayOutcome({
        status: 401,
        serverMessage: 'Terminal session is no longer valid; re-establish the session.',
      }),
    }).snapshot;

    expect(snapshot.replay).toBe('PAUSED_REAUTH');
    expect(nextReplayCommand(snapshot, DEVICE, OPERATOR)).toEqual({
      status: 'PAUSED',
      reason: 'REAUTH',
    });
    expect(pendingDrafts(snapshot)).toHaveLength(2);
    expect(countQueuedCommands(snapshot)).toBe(6);
    expect(snapshot.drafts[0].commands[0].status).toBe('PENDING');

    snapshot = resumeAfterReauth(snapshot);
    expect(nextReplayCommand(snapshot, DEVICE, OPERATOR).status).toBe('READY');
  });

  it('purges device-bound work on confirmed revocation, reports the count, and submits nothing later', () => {
    let snapshot = seeded([draftInput(), draftInput()]);
    const draft = snapshot.drafts[1];

    const result = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[0].commandId,
      outcome: classifyReplayOutcome({
        status: 403,
        serverMessage: 'This device has been revoked.',
      }),
    });
    snapshot = result.snapshot;

    expect(result.discarded).toEqual({ drafts: 2, commands: 6 });
    expect(snapshot.drafts).toHaveLength(0);
    expect(snapshot.replay).toBe('STOPPED_REVOKED');
    expect(nextReplayCommand(snapshot, DEVICE, OPERATOR)).toEqual({
      status: 'STOPPED',
      reason: 'DEVICE_REVOKED',
    });

    // A revoked device cannot be talked back into replaying, nor take more work.
    expect(resumeAfterReauth(snapshot).replay).toBe('STOPPED_REVOKED');
    const refused = enqueueDraft(snapshot, draftInput(), ids('r'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('DEVICE_REVOKED');
    expect(purgeForRevocation(snapshot).discarded).toEqual({ drafts: 0, commands: 0 });
  });

  it('purges the persisted document alongside the queue', async () => {
    const driver = createMemoryDriver();
    const snapshot = seeded([draftInput()]);
    await writePosState(driver, { ...emptyPosState<PosQueueSnapshot>(scope), queue: snapshot });

    const purged = purgeForRevocation(snapshot);
    await writePosState(driver, {
      ...emptyPosState<PosQueueSnapshot>(scope),
      catalog: null,
      queue: purged.snapshot,
    });

    const read = await readPosState<PosQueueSnapshot>(driver, scope);
    if (read.status !== 'ok') throw new Error('expected a readable document');
    expect(read.state.catalog).toBeNull();
    expect(read.state.queue?.drafts).toEqual([]);
  });
});

// ── Request construction against the real M4 contract ────────────────────────

describe('replay requests reuse the M4 command contract', () => {
  const built = (draft: PosQueuedDraft, index: number) => {
    const result = buildReplayRequest(draft, draft.commands[index]);
    if (!result.ok) throw new Error(`expected a request: ${result.reason}`);
    return result.request;
  };

  it('targets the existing M4 routes and satisfies their strict schemas', () => {
    const snapshot = seeded([draftInput()]);
    const draft: PosQueuedDraft = { ...snapshot.drafts[0], serverOrderId: 'order-1' };

    const open = built(draft, 0);
    expect(open.path).toBe('/api/restaurant/orders/open');
    expect(openOrderBody.safeParse(open.body).success).toBe(true);

    const addItem = built(draft, 1);
    expect(addItem.path).toBe('/api/restaurant/orders/add-item');
    expect(addItemBody.safeParse(addItem.body).success).toBe(true);

    const fire = built(draft, 2);
    expect(fire.path).toBe('/api/restaurant/orders/fire');
    expect(fireBody.safeParse(fire.body).success).toBe(true);
  });

  it('strips the local quoted price, which the strict server body would reject', () => {
    const snapshot = seeded([draftInput()]);
    const draft: PosQueuedDraft = { ...snapshot.drafts[0], serverOrderId: 'order-1' };
    const addItem = built(draft, 1);

    expect(addItem.body).not.toHaveProperty('quotedUnitPrice');
    expect(addItem.body).toEqual({ orderId: 'order-1', menuItemId: 'mi-1', quantity: 2 });
    expect(addItemBody.safeParse({ ...addItem.body, quotedUnitPrice: '450.00' }).success).toBe(
      false
    );
  });

  it('refuses to send an item before its order exists on the server', () => {
    const snapshot = seeded([draftInput()]);
    const result = buildReplayRequest(snapshot.drafts[0], snapshot.drafts[0].commands[1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ORDER_NOT_ESTABLISHED');
  });
});

// ── Stale catalog / 86 review ────────────────────────────────────────────────

describe('review before a stale submission (criterion 5)', () => {
  it('passes a draft that still matches the catalog', () => {
    const snapshot = seeded([draftInput()]);
    expect(reviewAgainstCatalog(snapshot.drafts[0], catalog())).toBeNull();
  });

  it('flags an 86d item, a removed item, a changed price and a closed channel', () => {
    const snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];

    const eightySixed = catalog({
      sections: [
        {
          ...catalog().sections[0],
          items: [{ ...catalog().sections[0].items[0], available: false }],
        },
      ],
    });
    expect(reviewAgainstCatalog(draft, eightySixed)?.reason).toBe('ITEM_UNAVAILABLE');

    const removed = catalog({ sections: [{ ...catalog().sections[0], items: [] }] });
    expect(reviewAgainstCatalog(draft, removed)?.reason).toBe('ITEM_UNAVAILABLE');

    const repriced = catalog({
      sections: [
        {
          ...catalog().sections[0],
          items: [{ ...catalog().sections[0].items[0], price: '525.00' }],
        },
      ],
    });
    expect(reviewAgainstCatalog(draft, repriced)?.reason).toBe('PRICE_CHANGED');

    expect(reviewAgainstCatalog(draft, catalog({ channelOpen: false }))?.reason).toBe(
      'CHANNEL_CLOSED'
    );
  });

  describe('selected modifiers are part of the reviewed quote', () => {
    const withModifiers = (priceDelta: string, options = [{ id: 'opt-cheese', priceDelta }]) =>
      catalog({
        sections: [
          {
            ...catalog().sections[0],
            items: [
              {
                ...catalog().sections[0].items[0],
                modifierGroups: [
                  {
                    id: 'grp-1',
                    name: 'Extras',
                    minSelect: 0,
                    maxSelect: null,
                    options: options.map((option) => ({ ...option, name: option.id })),
                  },
                ],
              },
            ],
          },
        ],
      });
    const modifierDraft = (quotedModifiers?: Array<{ optionId: string; priceDelta: string }>) =>
      seeded([
        draftInput({
          lines: [
            {
              menuItemId: 'mi-1',
              quantity: 1,
              quotedUnitPrice: '450.00',
              modifierOptionIds: ['opt-cheese'],
              ...(quotedModifiers ? { quotedModifiers } : {}),
            },
          ],
        }),
      ]).drafts[0];

    const modifierDraftSnapshot = (
      quotedModifiers: Array<{ optionId: string; priceDelta: string }>
    ) =>
      seeded([
        draftInput({
          lines: [
            {
              menuItemId: 'mi-1',
              quantity: 1,
              quotedUnitPrice: '450.00',
              modifierOptionIds: ['opt-cheese'],
              quotedModifiers,
            },
          ],
        }),
      ]);

    it('passes when every selected modifier still has the quoted delta', () => {
      const draft = modifierDraft([{ optionId: 'opt-cheese', priceDelta: '50.00' }]);
      expect(reviewAgainstCatalog(draft, withModifiers('50.00'))).toBeNull();
    });

    it.each(['base price', 'modifier price'] as const)(
      'rejects repeated %s changes with identical reason, message and command, including same-version drift',
      (changed) => {
        const original = modifierDraftSnapshot([{ optionId: 'opt-cheese', priceDelta: '20.00' }]);
        const menuA = withModifiers('50.00');
        const menuB = withModifiers('80.00');
        if (changed === 'base price') {
          menuA.sections[0].items[0].price = '500.00';
          menuB.sections[0].items[0].price = '700.00';
        }
        const a = markDraftsForCatalogReview(original, menuA).snapshot;
        const b = markDraftsForCatalogReview(a, menuB).snapshot;
        const displayed = a.drafts[0].review!;
        expect(b.drafts[0].review).toMatchObject({
          reason: displayed.reason,
          message: displayed.message,
          atCommandId: displayed.atCommandId,
        });
        expect(menuA.version).toBe(menuB.version);
        const result = resolveReviewedDraft(
          b,
          b.drafts[0].draftId,
          'REPLAY',
          displayed,
          menuB.version,
          menuB
        );
        expect(result.status).toBe('STALE');
        expect(result.snapshot).toEqual(b);
        expect(result.snapshot.drafts[0].commands).toEqual(original.drafts[0].commands);
        expect(nextReplayCommand(result.snapshot, DEVICE, OPERATOR).status).toBe('IDLE');

        // Even if a persisted review was not refreshed alongside the catalog, the
        // resolver must compare against actual current values before rebaselining.
        const drift = resolveReviewedDraft(
          a,
          a.drafts[0].draftId,
          'REPLAY',
          displayed,
          menuB.version,
          menuB
        );
        expect(drift.status).toBe('STALE');
        expect(drift.snapshot.drafts[0].review).toEqual(b.drafts[0].review);
        expect(drift.snapshot.drafts[0].commands).toEqual(original.drafts[0].commands);
        const fresh = resolveReviewedDraft(
          b,
          b.drafts[0].draftId,
          'REPLAY',
          b.drafts[0].review,
          menuB.version,
          menuB
        );
        expect(fresh.status).toBe('APPLIED');
        expect(fresh.snapshot.drafts[0].status).toBe('QUEUED');
        expect(fresh.snapshot.drafts[0].commands[1].body).toMatchObject({
          quotedUnitPrice: menuB.sections[0].items[0].price,
          quotedModifiers: [{ optionId: 'opt-cheese', priceDelta: '80.00' }],
        });
      }
    );

    it('requires a fresh display for older reviews without captured catalog values', () => {
      const current = withModifiers('80.00');
      const snapshot = markDraftsForCatalogReview(
        modifierDraftSnapshot([{ optionId: 'opt-cheese', priceDelta: '50.00' }]),
        current
      ).snapshot;
      const legacy = structuredClone(snapshot);
      delete legacy.drafts[0].review!.catalog;
      const result = resolveReviewedDraft(
        legacy,
        legacy.drafts[0].draftId,
        'REPLAY',
        legacy.drafts[0].review,
        current.version,
        current
      );
      expect(result.status).toBe('STALE');
      expect(result.snapshot).toEqual(snapshot);
      expect(nextReplayCommand(result.snapshot, DEVICE, OPERATOR).status).toBe('IDLE');
    });

    it.each(['branchId', 'channel', 'publicationId', 'menuId'] as const)(
      'binds the approval to its catalog %s',
      (field) => {
        const current = withModifiers('80.00');
        const snapshot = markDraftsForCatalogReview(
          modifierDraftSnapshot([{ optionId: 'opt-cheese', priceDelta: '50.00' }]),
          current
        ).snapshot;
        const other = {
          ...current,
          [field]: field === 'channel' ? ('TAKEAWAY' as const) : 'other-menu-scope',
        };
        const result = resolveReviewedDraft(
          snapshot,
          snapshot.drafts[0].draftId,
          'REPLAY',
          snapshot.drafts[0].review,
          other.version,
          other
        );
        expect(result.status).toBe('STALE');
        expect(result.snapshot.drafts[0].status).toBe('NEEDS_REVIEW');
        expect(result.snapshot.drafts[0].commands).toEqual(snapshot.drafts[0].commands);
      }
    );

    it('ignores unrelated version and unselected modifier updates', () => {
      const current = withModifiers('80.00');
      const snapshot = markDraftsForCatalogReview(
        modifierDraftSnapshot([{ optionId: 'opt-cheese', priceDelta: '50.00' }]),
        current
      ).snapshot;
      const newer = withModifiers('80.00', [
        { id: 'opt-cheese', priceDelta: '80.00' },
        { id: 'unselected', priceDelta: '900.00' },
      ]);
      newer.version = 'new-unrelated-version';
      const result = resolveReviewedDraft(
        snapshot,
        snapshot.drafts[0].draftId,
        'REPLAY',
        snapshot.drafts[0].review,
        newer.version,
        newer
      );
      expect(result.status).toBe('APPLIED');
      expect(result.snapshot.drafts[0].status).toBe('QUEUED');
    });

    it('flags a repriced modifier even when the base price is unchanged', () => {
      const draft = modifierDraft([{ optionId: 'opt-cheese', priceDelta: '50.00' }]);
      const review = reviewAgainstCatalog(draft, withModifiers('80.00'));
      expect(review?.reason).toBe('PRICE_CHANGED');
      expect(review?.atCommandId).toBe(draft.commands[1].commandId);

      const flagged = markDraftsForCatalogReview(
        seeded([
          draftInput({
            lines: [
              {
                menuItemId: 'mi-1',
                quantity: 1,
                quotedUnitPrice: '450.00',
                modifierOptionIds: ['opt-cheese'],
                quotedModifiers: [{ optionId: 'opt-cheese', priceDelta: '50.00' }],
              },
            ],
          }),
        ]),
        withModifiers('80.00')
      );
      expect(flagged.flagged).toBe(1);
      expect(flagged.snapshot.drafts[0].status).toBe('NEEDS_REVIEW');
      expect(nextReplayCommand(flagged.snapshot, DEVICE, OPERATOR).status).toBe('IDLE');
    });

    it('flags a selected modifier that was withdrawn from the item', () => {
      const draft = modifierDraft([{ optionId: 'opt-cheese', priceDelta: '50.00' }]);
      const withdrawn = withModifiers('50.00', [{ id: 'opt-onion', priceDelta: '0.00' }]);
      expect(reviewAgainstCatalog(draft, withdrawn)?.reason).toBe('ITEM_UNAVAILABLE');
      expect(reviewAgainstCatalog(draft, catalog())?.reason).toBe('ITEM_UNAVAILABLE');
    });

    it('reviews a legacy draft whose modifier quote was never captured', () => {
      const draft = modifierDraft();
      expect(reviewAgainstCatalog(draft, withModifiers('50.00'))?.reason).toBe('PRICE_CHANGED');
    });

    it('keeps the modifier quote local to the device', () => {
      const draft = modifierDraft([{ optionId: 'opt-cheese', priceDelta: '50.00' }]);
      const built = buildReplayRequest({ ...draft, serverOrderId: 'order-1' }, draft.commands[1]);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.request.body).not.toHaveProperty('quotedModifiers');
      expect(addItemBody.safeParse(built.request.body).success).toBe(true);
    });

    it('records the reviewed catalog as the accepted quote when the operator sends a draft', () => {
      const legacy = seeded([
        draftInput({
          lines: [
            {
              menuItemId: 'mi-1',
              quantity: 1,
              quotedUnitPrice: '450.00',
              modifierOptionIds: ['opt-cheese'],
            },
          ],
        }),
      ]);
      const current = withModifiers('50.00');
      const flagged = markDraftsForCatalogReview(legacy, current).snapshot;
      expect(flagged.drafts[0].status).toBe('NEEDS_REVIEW');

      const accepted = resolveReviewedDraft(
        flagged,
        flagged.drafts[0].draftId,
        'REPLAY',
        flagged.drafts[0].review,
        current.version,
        current
      ).snapshot;
      // Unchanged since the review: the accepted draft is not flagged again.
      const refreshed = markDraftsForCatalogReview(accepted, current);
      expect(refreshed.flagged).toBe(0);
      expect(refreshed.snapshot.drafts[0].status).toBe('QUEUED');
      // A change made after the review still needs a fresh one.
      expect(markDraftsForCatalogReview(accepted, withModifiers('80.00')).flagged).toBe(1);
    });

    it('does not take another channel menu as the accepted quote', () => {
      const legacy = seeded([
        draftInput({
          lines: [
            {
              menuItemId: 'mi-1',
              quantity: 1,
              quotedUnitPrice: '450.00',
              modifierOptionIds: ['opt-cheese'],
            },
          ],
        }),
      ]);
      const takeaway = { ...withModifiers('50.00'), channel: 'TAKEAWAY' as const };
      const flagged = markDraftsForCatalogReview(legacy, takeaway).snapshot;
      const accepted = resolveReviewedDraft(
        flagged,
        flagged.drafts[0].draftId,
        'REPLAY',
        flagged.drafts[0].review,
        takeaway.version,
        takeaway
      ).snapshot;
      expect(accepted.drafts[0].commands[1]).toEqual(legacy.drafts[0].commands[1]);
      expect(markDraftsForCatalogReview(accepted, withModifiers('50.00')).flagged).toBe(1);
    });

    it('shows every changed line before replay instead of accepting unseen changes', () => {
      const snapshot = seeded([
        draftInput({
          lines: [
            { menuItemId: 'mi-1', quantity: 1, quotedUnitPrice: '400.00' },
            {
              menuItemId: 'mi-1',
              quantity: 1,
              quotedUnitPrice: '450.00',
              modifierOptionIds: ['opt-cheese'],
              quotedModifiers: [{ optionId: 'opt-cheese', priceDelta: '50.00' }],
            },
          ],
        }),
      ]);
      const current = withModifiers('80.00');
      const flagged = markDraftsForCatalogReview(snapshot, current).snapshot;
      const draftId = flagged.drafts[0].draftId;
      expect(flagged.drafts[0].review).toMatchObject({
        reason: 'PRICE_CHANGED',
        atCommandId: 'c2',
      });

      // Accepting the base-price change shown for the first line surfaces the
      // modifier change on the second line; nothing replays yet.
      const first = resolveReviewedDraft(
        flagged,
        draftId,
        'REPLAY',
        flagged.drafts[0].review,
        current.version,
        current
      ).snapshot;
      expect(first.drafts[0].status).toBe('NEEDS_REVIEW');
      expect(first.drafts[0].review).toMatchObject({ reason: 'PRICE_CHANGED', atCommandId: 'c3' });
      expect(nextReplayCommand(first, DEVICE, OPERATOR).status).toBe('IDLE');

      const second = resolveReviewedDraft(
        first,
        draftId,
        'REPLAY',
        first.drafts[0].review,
        current.version,
        current
      ).snapshot;
      expect(second.drafts[0].status).toBe('QUEUED');
      expect(markDraftsForCatalogReview(second, current).flagged).toBe(0);
    });

    it('shows a line change hidden behind an accepted closed-channel review', () => {
      const snapshot = modifierDraftSnapshot([{ optionId: 'opt-cheese', priceDelta: '50.00' }]);
      const closed = { ...withModifiers('80.00'), channelOpen: false };
      const flagged = markDraftsForCatalogReview(snapshot, closed).snapshot;
      expect(flagged.drafts[0].review?.reason).toBe('CHANNEL_CLOSED');

      const accepted = resolveReviewedDraft(
        flagged,
        flagged.drafts[0].draftId,
        'REPLAY',
        flagged.drafts[0].review,
        closed.version,
        closed
      ).snapshot;
      expect(accepted.drafts[0].status).toBe('NEEDS_REVIEW');
      expect(accepted.drafts[0].review).toMatchObject({
        reason: 'PRICE_CHANGED',
        atCommandId: 'c2',
      });
    });

    describe('a review raised while a command is in flight', () => {
      const twoLines = () => {
        let snapshot = seeded([
          draftInput({
            lines: [
              { menuItemId: 'mi-1', quantity: 1, quotedUnitPrice: '450.00' },
              {
                menuItemId: 'mi-1',
                quantity: 1,
                quotedUnitPrice: '450.00',
                modifierOptionIds: ['opt-cheese'],
                quotedModifiers: [{ optionId: 'opt-cheese', priceDelta: '50.00' }],
              },
            ],
          }),
        ]);
        const draft = snapshot.drafts[0];
        snapshot = applyReplayOutcome(beginReplay(snapshot, draft.draftId, 'c1'), {
          draftId: draft.draftId,
          commandId: 'c1',
          outcome: { action: 'ACK' },
          serverRef: 'order-1',
        }).snapshot;
        // The first line is on the wire when the refresh reprices the second line.
        snapshot = beginReplay(snapshot, draft.draftId, 'c2');
        snapshot = markDraftsForCatalogReview(snapshot, withModifiers('80.00')).snapshot;
        expect(snapshot.drafts[0].status).toBe('NEEDS_REVIEW');
        expect(snapshot.drafts[0].review?.atCommandId).toBe('c3');
        return snapshot;
      };

      it('survives the acknowledgement of the in-flight command', () => {
        const snapshot = twoLines();
        const acked = applyReplayOutcome(snapshot, {
          draftId: snapshot.drafts[0].draftId,
          commandId: 'c2',
          outcome: { action: 'ACK' },
          serverRef: 'item-1',
        }).snapshot;
        expect(acked.drafts[0].status).toBe('NEEDS_REVIEW');
        expect(acked.drafts[0].review?.reason).toBe('PRICE_CHANGED');
        expect(nextReplayCommand(acked, DEVICE, OPERATOR).status).toBe('IDLE');
      });

      it('survives a retry of the in-flight command', () => {
        const snapshot = twoLines();
        const retried = applyReplayOutcome(snapshot, {
          draftId: snapshot.drafts[0].draftId,
          commandId: 'c2',
          outcome: classifyReplayOutcome({ status: 0 }),
        }).snapshot;
        expect(retried.drafts[0].status).toBe('NEEDS_REVIEW');
        expect(nextReplayCommand(retried, DEVICE, OPERATOR).status).toBe('IDLE');
      });
    });
  });

  it('does not re-price lines the server already accepted', () => {
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[1].commandId,
      outcome: { action: 'ACK' },
      serverRef: 'item-1',
    }).snapshot;

    const repriced = catalog({
      version: 'v1:bbbb',
      sections: [
        {
          ...catalog().sections[0],
          items: [{ ...catalog().sections[0].items[0], price: '525.00' }],
        },
      ],
    });
    expect(reviewAgainstCatalog(snapshot.drafts[0], repriced)).toBeNull();
  });

  it('disables a queued draft within one refresh cycle and restores it if the 86 is lifted', () => {
    const snapshot = seeded([draftInput(), draftInput()]);
    const eightySixed = catalog({
      version: 'v1:bbbb',
      sections: [
        {
          ...catalog().sections[0],
          items: [{ ...catalog().sections[0].items[0], available: false }],
        },
      ],
    });

    const flagged = markDraftsForCatalogReview(snapshot, eightySixed);
    expect(flagged.flagged).toBe(2);
    expect(flagged.snapshot.drafts.every((d) => d.status === 'NEEDS_REVIEW')).toBe(true);
    // Nothing replays while every draft awaits review — no silent stale submit.
    expect(nextReplayCommand(flagged.snapshot, DEVICE, OPERATOR).status).toBe('IDLE');

    const restored = markDraftsForCatalogReview(flagged.snapshot, catalog({ version: 'v1:cccc' }));
    expect(restored.flagged).toBe(0);
    expect(restored.snapshot.drafts.every((d) => d.status === 'QUEUED')).toBe(true);
    expect(nextReplayCommand(restored.snapshot, DEVICE, OPERATOR).status).toBe('READY');
  });

  it('leaves a quarantined draft alone on refresh', () => {
    let snapshot = seeded([draftInput()]);
    const draft = snapshot.drafts[0];
    snapshot = applyReplayOutcome(snapshot, {
      draftId: draft.draftId,
      commandId: draft.commands[0].commandId,
      outcome: classifyReplayOutcome({ status: 400 }),
    }).snapshot;

    const after = markDraftsForCatalogReview(snapshot, catalog({ channelOpen: false }));
    expect(after.flagged).toBe(0);
    expect(after.snapshot.drafts[0].status).toBe('QUARANTINED');
    expect(after.snapshot.drafts[0].review?.reason).toBe('REJECTED');
  });

  it('lets the operator send a reviewed draft as composed, or drop it', () => {
    const snapshot = markDraftsForCatalogReview(
      seeded([draftInput(), draftInput()]),
      catalog({ version: 'v1:bbbb', channelOpen: false })
    ).snapshot;

    const accepted = resolveReviewedDraft(
      snapshot,
      snapshot.drafts[0].draftId,
      'REPLAY',
      snapshot.drafts[0].review,
      'v1:bbbb'
    ).snapshot;
    expect(accepted.drafts[0].status).toBe('QUEUED');
    expect(accepted.drafts[0].review).toBeNull();
    expect(accepted.drafts[0].catalogVersion).toBe('v1:bbbb');

    const dropped = resolveReviewedDraft(
      snapshot,
      snapshot.drafts[1].draftId,
      'DISCARD',
      snapshot.drafts[1].review,
      'v1:bbbb'
    ).snapshot;
    expect(dropped.drafts).toHaveLength(1);
  });

  it.each(['atCommandId', 'reason', 'message', 'missing'] as const)(
    'does not approve a review with a stale or missing %s',
    (field) => {
      const snapshot = markDraftsForCatalogReview(
        seeded([draftInput()]),
        catalog({ channelOpen: false })
      ).snapshot;
      const draft = snapshot.drafts[0];
      const displayed =
        field === 'missing'
          ? null
          : {
              ...draft.review!,
              ...(field === 'atCommandId' ? { atCommandId: 'previous-command' } : {}),
              ...(field === 'reason' ? { reason: 'CATALOG_CONFLICT' as const } : {}),
              ...(field === 'message' ? { message: 'A different conflict was displayed.' } : {}),
            };
      // Even without a matching catalog, stale approval cannot release the review.
      const result = resolveReviewedDraft(
        snapshot,
        draft.draftId,
        'REPLAY',
        displayed,
        'v2'
      ).snapshot;
      expect(result).toEqual(snapshot);
      expect(nextReplayCommand(result, DEVICE, OPERATOR).status).toBe('IDLE');
    }
  );
});

describe('server review identity before display', () => {
  it.each(['c1', 'c2'])('captures an unchanged 409 on %s for first-click approval', (commandId) => {
    const original = seeded([draftInput()]);
    const current = catalog();
    const reviewed = applyReplayOutcome(original, {
      draftId: original.drafts[0].draftId,
      commandId,
      outcome: classifyReplayOutcome({ status: 409 }),
      catalog: current,
    }).snapshot;
    const displayed = reviewed.drafts[0].review;
    expect(displayed?.catalog).toMatchObject({ menuName: 'All day', channel: 'DINE_IN' });
    const refreshed = markDraftsForCatalogReview(reviewed, current).snapshot;
    expect(refreshed.drafts[0].status).toBe('NEEDS_REVIEW');
    expect(refreshed.drafts[0].review).toEqual(displayed);
    expect(nextReplayCommand(refreshed, DEVICE, OPERATOR).status).toBe('IDLE');
    const approved = resolveReviewedDraft(
      refreshed,
      original.drafts[0].draftId,
      'REPLAY',
      displayed,
      current.version,
      current
    );
    expect(approved.status).toBe('APPLIED');
    expect(approved.snapshot.drafts[0].status).toBe('QUEUED');
  });

  it('rejects changed values after a server review without modifying its quotes', () => {
    const original = seeded([draftInput()]);
    const current = catalog();
    const reviewed = applyReplayOutcome(original, {
      draftId: original.drafts[0].draftId,
      commandId: 'c2',
      outcome: classifyReplayOutcome({ status: 409 }),
      catalog: current,
    }).snapshot;
    const changed = catalog({
      sections: [
        { ...current.sections[0], items: [{ ...current.sections[0].items[0], price: '700.00' }] },
      ],
    });
    const blocked = resolveReviewedDraft(
      reviewed,
      original.drafts[0].draftId,
      'REPLAY',
      reviewed.drafts[0].review,
      changed.version,
      changed
    );
    expect(blocked.status).toBe('STALE');
    expect(blocked.snapshot.drafts[0].status).toBe('NEEDS_REVIEW');
    expect(blocked.snapshot.drafts[0].commands).toEqual(reviewed.drafts[0].commands);
    expect(blocked.snapshot.drafts[0].review?.catalog?.line?.currentPrice).toBe('700.00');
    expect(nextReplayCommand(blocked.snapshot, DEVICE, OPERATOR).status).toBe('IDLE');
  });
});
