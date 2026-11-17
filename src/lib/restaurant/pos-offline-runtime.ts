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
 */
export class PosOfflineRuntime {
  private state: PosOfflineRuntimeState;
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
    return this.lock(this.stateLock, async () => {
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

  async cacheCatalog(payload: unknown, fetchedAtClient: string): Promise<PosCatalogSnapshot> {
    const version =
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? String(payload.version)
        : '';
    const catalog = sanitizeCatalogSnapshot(payload, { version, fetchedAtClient });
    await this.commit(() => {
      const queue = this.queue();
      const catalogs = new Map(
        [
          ...(queue.reviewCatalogs ?? []),
          ...(this.state.catalog ? [this.state.catalog] : []),
          catalog,
        ].map((entry) => [
          JSON.stringify([entry.branchId, entry.channel, entry.publicationId]),
          entry,
        ])
      );
      const reviewCatalogs = [...catalogs.values()].filter(
        (entry) =>
          entry === catalog ||
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
      this.state = { ...this.state, catalog, queue: { ...queue, reviewCatalogs } };
      const drafts = queue.drafts.map((draft) => {
        const ownCatalog = this.catalogFor(draft);
        if (!ownCatalog) return draft;
        return markDraftsForCatalogReview({ ...queue, drafts: [draft] }, ownCatalog).snapshot
          .drafts[0];
      });
      this.state = { ...this.state, queue: { ...this.queue(), drafts } };
      return { persist: true, result: undefined };
    });
    return catalog;
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
      const applied = await this.lock(this.stateLock, async () => {
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
    return this.lock(this.stateLock, async () => {
      await this.loadOrThrow();
      const { persist, result } = transition();
      if (persist) await this.persist();
      return result;
    });
  }

  private persist(): Promise<void> {
    return writePosState(this.driver, this.state);
  }
}

type ReplayStep =
  { done: ReplayResult } | { draftId: string; commandId: string; request: PosReplayRequest };

type ReplayResult = {
  state: 'IDLE' | 'PAUSED' | 'STOPPED' | 'REFUSED';
  discarded: { drafts: number; commands: number } | null;
  /** Set when replay finished the current operator's work but other composers' drafts wait. */
  waitingComposers?: Array<string | null>;
};
