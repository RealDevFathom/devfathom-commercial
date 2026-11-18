import { withTerminalScopeLock, type TerminalScopeLock } from '@/lib/retail-terminal/local-store';
import {
  emptyPosState,
  POS_STORE_DATABASE_NAME,
  PosStorageError,
  posScopeKey,
  purgePosScope,
  readPosState,
  sanitizeCatalogSnapshot,
  writePosState,
  type PosCatalogSnapshot,
  type PosOrderChannel,
  type PosPersistedState,
  type PosScope,
  type PosStorageDriver,
} from './pos-client-store';
import {
  applyReplayOutcome,
  beginReplay,
  buildReplayRequest,
  classifyReplayOutcome,
  createQueueSnapshot,
  enqueueDraft,
  draftMatchesCatalog,
  markDraftsForCatalogReview,
  nextReplayCommand,
  resolveReviewedDraft,
  resumeAfterReauth,
  type PosDraftInput,
  type PosDraftReview,
  type PosQueueSnapshot,
  type PosQueuedDraft,
  type PosReplayRequest,
} from './pos-command-queue';

export type PosReplayResponse = {
  status: number;
  serverMessage?: string;
  retryAfter?: string | null;
  serverRef?: string | null;
};

export type PosOfflineRuntimeState = PosPersistedState<PosQueueSnapshot>;

/**
 * The sole impure adapter between the POS, IndexedDB, and the pure queue transitions.
 *
 * Several tabs may open the same enrolled terminal, and they all share one scope
 * document. Each mutation therefore holds a cross-tab lock on that scope, re-reads
 * the persisted document and applies its transition to that fresh copy before the
 * write: a draft another tab saved is never replaced by this tab's stale snapshot,
 * and a catalog refresh cannot roll back newer queue state.
 *
 * The write itself is also revision-checked, so the guarantee does not rest on the
 * lock alone: where a browser has no Web Locks the lock cannot span tabs, and a
 * write that another tab beat is refused, re-read and re-applied instead of
 * replacing that tab's saved work.
 */
export class PosOfflineRuntime {
  private state: PosOfflineRuntimeState;
  private closed = false;
  /** The write revision of the document `state` was last read from or written as. */
  private revision = 0;
  private activeReplay: Promise<ReplayResult> | null = null;
  private readonly stateLock: string;
  private readonly replayLock: string;

  constructor(
    readonly scope: PosScope,
    private readonly driver: PosStorageDriver,
    private readonly lock: TerminalScopeLock = withTerminalScopeLock
  ) {
    this.state = emptyPosState(scope);
    this.state.queue = createQueueSnapshot(scope.deviceId);
    this.stateLock = `${POS_STORE_DATABASE_NAME}:${posScopeKey(scope)}`;
    this.replayLock = `${this.stateLock}:replay`;
  }

  snapshot(): PosOfflineRuntimeState {
    return this.state;
  }

  async hydrate(): Promise<'ready' | 'unrecoverable'> {
    return this.exclusive(async () => {
      const loaded = await this.load();
      if (loaded === 'unrecoverable') return 'unrecoverable';
      if (loaded === 'ok') await this.persist();
      return 'ready';
    });
  }

  /** Pick up work other tabs of this terminal saved since this runtime last wrote. */
  async refresh(): Promise<void> {
    await this.lock(this.stateLock, async () => {
      await this.loadOrThrow();
    });
  }

  /** An already-observed live catalog update, committed atomically. Network reads use fetchLiveCatalog. */
  async cacheCatalog(payload: unknown, fetchedAtClient: string): Promise<PosCatalogSnapshot> {
    const catalog = this.parseCatalog(payload, fetchedAtClient);
    await this.commit(() => {
      this.storeCatalog(catalog, true);
      return { persist: true, result: undefined };
    });
    return catalog;
  }

  async fetchLiveCatalog(
    channel: PosOrderChannel,
    fetch: () => Promise<unknown>
  ): Promise<PosCatalogSnapshot | null> {
    return this.fetchCatalog(channel, null, fetch);
  }

  /** Restore only an unresolved order's original scope, never promote a foreign menu to live. */
  async restoreReviewCatalog(
    draftId: string,
    fetch: (channel: PosOrderChannel, publicationId: string) => Promise<unknown>
  ): Promise<PosCatalogSnapshot | null> {
    await this.refresh();
    const draft = this.queue().drafts.find((entry) => entry.draftId === draftId);
    const open = draft?.commands.find((command) => command.kind === 'OPEN_ORDER');
    if (!draft?.retainOriginalCatalog || !draft.review || !open?.body.publicationId) return null;
    return this.fetchCatalog(
      open.body.channel,
      open.body.publicationId,
      () => fetch(open.body.channel, open.body.publicationId!),
      draftId
    );
  }

  private parseCatalog(payload: unknown, fetchedAtClient: string): PosCatalogSnapshot {
    const version =
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? String(payload.version)
        : '';
    const catalog = sanitizeCatalogSnapshot(payload, { version, fetchedAtClient });
    if (catalog.branchId !== this.scope.branchId)
      throw new Error('The menu belongs to another branch. Nothing was sent.');
    return catalog;
  }

  private async fetchCatalog(
    channel: PosOrderChannel,
    publicationId: string | null,
    fetch: () => Promise<unknown>,
    draftId?: string
  ): Promise<PosCatalogSnapshot | null> {
    const lease = await this.commit(() => {
      const queue = this.queue();
      if (this.closed || queue.replay === 'STOPPED_REVOKED')
        throw new Error('The terminal is no longer available. Nothing was sent.');
      const generation = (queue.catalogRequestSequence ?? 0) + 1;
      // An incarnation distinguishes a purged/recreated record. It is only an
      // equality marker, not an authentication or command/idempotency key.
      const instance = queue.catalogInstance ?? `${Math.random()}:${Math.random()}`;
      this.state = {
        ...this.state,
        queue: {
          ...queue,
          catalogInstance: instance,
          catalogRequestSequence: generation,
        },
      };
      return {
        persist: true,
        result: { instance, generation, revision: queue.catalogRevision ?? 0 },
      };
    });
    const catalog = this.parseCatalog(await fetch(), new Date().toISOString());
    if (catalog.channel !== channel || (publicationId && catalog.publicationId !== publicationId)) {
      throw new Error(
        'The returned menu does not match the requested order scope. Nothing was sent.'
      );
    }
    return this.commit(() => {
      const queue = this.queue();
      // Latest-started catalog read wins across both live and original-order
      // paths: the live endpoint's publication is not known until it responds.
      // Any intervening catalog write also invalidates the read, including ABA.
      // Queue enqueues/proof renewals deliberately invalidate neither counter.
      if (
        this.closed ||
        queue.replay === 'STOPPED_REVOKED' ||
        queue.catalogInstance !== lease.instance ||
        queue.catalogRequestSequence !== lease.generation ||
        (queue.catalogRevision ?? 0) !== lease.revision
      ) {
        return { persist: false, result: null };
      }
      if (draftId) {
        const draft = queue.drafts.find((entry) => entry.draftId === draftId);
        if (
          !draft?.retainOriginalCatalog ||
          !draft.review ||
          draft.status === 'COMPLETED' ||
          draft.review.reason === 'COMPOSER_UNVERIFIED' ||
          !draftMatchesCatalog(draft, catalog)
        ) {
          return { persist: false, result: null };
        }
      }
      this.storeCatalog(catalog, !draftId);
      return { persist: true, result: catalog };
    });
  }

  /** Caller holds the terminal lock and has re-read the current scope document. */
  private storeCatalog(catalog: PosCatalogSnapshot, live: boolean): void {
    const queue = this.queue();
    const key = (entry: PosCatalogSnapshot) =>
      JSON.stringify([entry.branchId, entry.channel, entry.publicationId]);
    // The scoped registry is authoritative; an older live projection must never
    // replace a newer scoped entry while we merge a different publication.
    const catalogs = new Map(
      [
        ...(this.state.catalog ? [this.state.catalog] : []),
        ...(queue.reviewCatalogs ?? []),
        catalog,
      ].map((entry) => [key(entry), entry])
    );
    const active =
      live || (this.state.catalog && key(this.state.catalog) === key(catalog))
        ? catalog
        : this.state.catalog;
    const reviewCatalogs = [...catalogs.values()].filter(
      (entry) =>
        entry === active ||
        (entry.branchId === this.scope.branchId &&
          queue.drafts.some((draft) => {
            const open = draft.commands.find((command) => command.kind === 'OPEN_ORDER');
            return (
              draft.status !== 'COMPLETED' &&
              Boolean(open?.body.publicationId) &&
              draftMatchesCatalog(draft, entry)
            );
          }))
    );
    this.state = {
      ...this.state,
      catalog: active,
      queue: { ...queue, reviewCatalogs, catalogRevision: (queue.catalogRevision ?? 0) + 1 },
    };
    const drafts = queue.drafts.map((draft) => {
      const open = draft.commands.find((command) => command.kind === 'OPEN_ORDER');
      // Restoration cannot re-review another publication/channel against this menu.
      if (!live && (!open?.body.publicationId || !draftMatchesCatalog(draft, catalog)))
        return draft;
      const reviewed = !live ? { ...draft, retainOriginalCatalog: true } : draft;
      const ownCatalog = this.catalogFor(reviewed);
      if (!ownCatalog) return reviewed;
      return markDraftsForCatalogReview({ ...queue, drafts: [reviewed] }, ownCatalog).snapshot
        .drafts[0];
    });
    this.state = { ...this.state, queue: { ...this.queue(), drafts } };
  }

  async enqueue(input: PosDraftInput): Promise<ReturnType<typeof enqueueDraft>> {
    return this.commit<ReturnType<typeof enqueueDraft>>(() => {
      const result = enqueueDraft(this.queue(), input);
      if (!result.ok) return { persist: false, result };
      this.state = { ...this.state, queue: result.snapshot };
      return { persist: true, result };
    });
  }

  async resume(): Promise<void> {
    await this.commit(() => {
      this.state = { ...this.state, queue: resumeAfterReauth(this.queue()) };
      return { persist: true, result: undefined };
    });
  }

  /**
   * Replace an expired composer proof only after the same operator has authenticated
   * again. The server still verifies the replacement proof on every replay request.
   */
  async renewComposerProof(
    staffProfileId: string,
    renew: (originalProof: string) => Promise<string | null>,
    needsRenewal: (proof: string) => boolean = () => true
  ): Promise<void> {
    await this.refresh();
    const candidates = this.queue().drafts.filter(
      (draft) =>
        draft.status !== 'COMPLETED' &&
        draft.review?.reason !== 'COMPOSER_UNVERIFIED' &&
        draft.composerStaffProfileId === staffProfileId &&
        needsRenewal(draft.composerProof)
    );
    for (const candidate of candidates) {
      const composerProof = await renew(candidate.composerProof);
      if (!composerProof) continue;
      await this.commit(() => {
        this.state = {
          ...this.state,
          queue: {
            ...this.queue(),
            drafts: this.queue().drafts.map((draft) =>
              draft.draftId === candidate.draftId && draft.composerProof === candidate.composerProof
                ? { ...draft, composerProof }
                : draft
            ),
          },
        };
        return { persist: true, result: undefined };
      });
    }
  }

  async resolveReview(
    draftId: string,
    decision: 'REPLAY' | 'DISCARD',
    displayedReview: PosDraftReview | null
  ): Promise<ReturnType<typeof resolveReviewedDraft>['status'] | 'CATALOG_REQUIRED'> {
    return this.commit<ReturnType<typeof resolveReviewedDraft>['status'] | 'CATALOG_REQUIRED'>(
      () => {
        let draft = this.queue().drafts.find((entry) => entry.draftId === draftId);
        if (decision === 'REPLAY' && draft?.review?.reason === 'COMPOSER_UNVERIFIED') {
          return { persist: false, result: 'REFUSED' };
        }
        const current = this.state.catalog;
        const displayed = displayedReview?.catalog;
        // A binary "different publication" label cannot distinguish two foreign
        // publications. Return to the order's own scope instead of approving either.
        if (
          decision === 'REPLAY' &&
          draft?.review &&
          current &&
          displayed &&
          !displayed.publicationMatchesOrder &&
          !draftMatchesCatalog(draft, current) &&
          displayed.publicationId !== current.publicationId &&
          !draft.retainOriginalCatalog
        ) {
          const scopeReview: PosDraftReview = {
            ...draft.review,
            reason: 'CATALOG_SCOPE_CHANGED',
            message:
              'The menu publication changed. Review the saved order’s original menu before sending.',
          };
          draft = { ...draft, retainOriginalCatalog: true, scopeReview, review: scopeReview };
          this.state = {
            ...this.state,
            queue: {
              ...this.queue(),
              drafts: this.queue().drafts.map((entry) =>
                entry.draftId === draftId ? draft! : entry
              ),
            },
          };
        }
        const catalog = draft ? this.catalogFor(draft) : current;
        if (decision === 'REPLAY' && draft?.retainOriginalCatalog && !catalog) {
          this.state = {
            ...this.state,
            queue: {
              ...this.queue(),
              drafts: this.queue().drafts.map((entry) =>
                entry.draftId === draftId
                  ? {
                      ...entry,
                      status: 'NEEDS_REVIEW',
                      review: entry.review && { ...entry.review, originalCatalogRequired: true },
                    }
                  : entry
              ),
            },
          };
          return { persist: true, result: 'CATALOG_REQUIRED' };
        }
        const resolved = resolveReviewedDraft(
          this.queue(),
          draftId,
          decision,
          displayedReview,
          catalog?.version ?? '',
          catalog ?? null
        );
        this.state = { ...this.state, queue: resolved.snapshot };
        return { persist: true, result: resolved.status };
      }
    );
  }

  replay(
    staffProfileId: string,
    send: (request: PosReplayRequest) => Promise<PosReplayResponse>
  ): Promise<ReplayResult> {
    if (this.activeReplay) return this.activeReplay;
    // One replaying tab per terminal; the others wait and then find the work done.
    const replay = this.lock(this.replayLock, () => this.runReplay(staffProfileId, send));
    this.activeReplay = replay;
    const clear = () => {
      if (this.activeReplay === replay) this.activeReplay = null;
    };
    void replay.then(clear, clear);
    return replay;
  }

  private async runReplay(
    staffProfileId: string,
    send: (request: PosReplayRequest) => Promise<PosReplayResponse>
  ): Promise<ReplayResult> {
    for (;;) {
      const step = await this.commit<ReplayStep>(() => {
        const next = nextReplayCommand(this.queue(), this.scope.deviceId, staffProfileId);
        if (next.status === 'REFUSED' && next.reason === 'OPERATOR_MISMATCH') {
          return {
            persist: false,
            result: {
              done: {
                state: 'REFUSED' as const,
                discarded: null,
                waitingComposers: next.composerStaffProfileIds,
              },
            },
          };
        }
        if (next.status !== 'READY') {
          return { persist: false, result: { done: { state: next.status, discarded: null } } };
        }
        const built = buildReplayRequest(next.draft, next.command);
        if (!built.ok) {
          return {
            persist: false,
            result: { done: { state: 'REFUSED' as const, discarded: null } },
          };
        }
        this.state = {
          ...this.state,
          queue: beginReplay(this.queue(), next.draft.draftId, next.command.commandId),
        };
        return {
          persist: true,
          result: {
            draftId: next.draft.draftId,
            commandId: next.command.commandId,
            request: built.request,
          },
        };
      });
      if ('done' in step) return step.done;

      // The network call runs outside the state lock so other tabs can keep saving.
      let response: PosReplayResponse;
      try {
        response = await send(step.request);
      } catch {
        response = { status: 0 };
      }
      const outcome = classifyReplayOutcome(response);
      const applied = await this.exclusive(async () => {
        await this.loadOrThrow();
        const result = applyReplayOutcome(this.queue(), {
          draftId: step.draftId,
          commandId: step.commandId,
          outcome,
          serverRef: response.serverRef,
          catalog: this.catalogFor(
            this.queue().drafts.find((draft) => draft.draftId === step.draftId)!
          ),
        });
        this.state = { ...this.state, queue: result.snapshot };
        if (result.snapshot.replay === 'STOPPED_REVOKED') {
          await purgePosScope(this.driver, this.scope);
        } else {
          await this.persist();
        }
        return result;
      });
      if (applied.snapshot.replay === 'STOPPED_REVOKED') {
        return { state: 'STOPPED' as const, discarded: applied.discarded };
      }
      if (outcome.action !== 'ACK') {
        return { state: 'PAUSED' as const, discarded: applied.discarded };
      }
    }
  }

  close(): void {
    this.closed = true;
    this.driver.close();
  }

  private catalogFor(draft: PosQueuedDraft): PosCatalogSnapshot | null {
    if (!draft?.retainOriginalCatalog) return this.state.catalog;
    return (
      this.queue().reviewCatalogs?.find(
        (catalog) => catalog.branchId === this.scope.branchId && draftMatchesCatalog(draft, catalog)
      ) ?? null
    );
  }

  private queue(): PosQueueSnapshot {
    return this.state.queue ?? createQueueSnapshot(this.scope.deviceId);
  }

  /**
   * Replace the in-memory state with the persisted document. Callers hold the state
   * lock. Schema v1 also contains pre-proof drafts: preserve them for explicit
   * discard, but never let unverifiable authorship block newer signed work.
   */
  private async load(): Promise<'ok' | 'empty' | 'unrecoverable'> {
    const result = await readPosState<PosQueueSnapshot>(this.driver, this.scope);
    if (result.status === 'unrecoverable') return 'unrecoverable';
    this.revision = result.status === 'ok' ? result.revision : 0;
    if (result.status === 'empty') {
      // A confirmed revocation purged the document; this runtime stays stopped
      // rather than recreating local work the device can never send.
      if (this.queue().replay !== 'STOPPED_REVOKED') {
        this.state = emptyPosState(this.scope);
        this.state.queue = createQueueSnapshot(this.scope.deviceId);
      }
      return 'empty';
    }
    if (result.state.queue && result.state.queue.deviceId !== this.scope.deviceId) {
      return 'unrecoverable';
    }
    const queue = result.state.queue ?? createQueueSnapshot(this.scope.deviceId);
    this.state = {
      ...result.state,
      queue: {
        ...queue,
        drafts: queue.drafts.map((draft) =>
          draft.status !== 'COMPLETED' && (!draft.composerStaffProfileId || !draft.composerProof)
            ? {
                ...draft,
                status: 'QUARANTINED',
                review: {
                  reason: 'COMPOSER_UNVERIFIED',
                  message:
                    'This saved order has no verified composer. Recreate it and discard this copy.',
                  atCommandId: null,
                },
              }
            : draft
        ),
      },
    };
    return 'ok';
  }

  private async loadOrThrow(): Promise<void> {
    if ((await this.load()) === 'unrecoverable') {
      throw new PosStorageError(
        'UNRECOVERABLE',
        'Local terminal storage changed in another tab and can no longer be read. Reload the POS.'
      );
    }
  }

  /** Lock the scope, apply `transition` to the freshly read document, then write it. */
  private commit<T>(transition: () => { persist: boolean; result: T }): Promise<T> {
    return this.exclusive(async () => {
      await this.loadOrThrow();
      const { persist, result } = transition();
      if (persist) await this.persist();
      return result;
    });
  }

  /**
   * Hold the scope lock while `body` reads, transforms and writes the document. If
   * another tab wrote in between (possible only where the lock cannot span tabs),
   * the revision-checked write refused: run `body` again on the newer document. If
   * that keeps happening, fail loudly with this tab's view reset to what is stored,
   * so it never reports or shows a save that did not happen.
   */
  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    return this.lock(this.stateLock, async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await body();
        } catch (error) {
          if (!(error instanceof PosStorageError) || error.reason !== 'WRITE_CONFLICT') throw error;
          if (attempt >= MAX_WRITE_ATTEMPTS) {
            await this.load();
            throw error;
          }
        }
      }
    });
  }

  private async persist(): Promise<void> {
    this.revision = await writePosState(this.driver, this.state, this.revision);
  }
}

/** Re-reads allowed when other tabs keep winning the write; each one makes progress for them. */
const MAX_WRITE_ATTEMPTS = 8;

type ReplayStep =
  { done: ReplayResult } | { draftId: string; commandId: string; request: PosReplayRequest };

type ReplayResult = {
  state: 'IDLE' | 'PAUSED' | 'STOPPED' | 'REFUSED';
  discarded: { drafts: number; commands: number } | null;
  /** Set when replay finished the current operator's work but other composers' drafts wait. */
  waitingComposers?: Array<string | null>;
};
