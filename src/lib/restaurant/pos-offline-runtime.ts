import {
  emptyPosState,
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
  markDraftsForCatalogReview,
  nextReplayCommand,
  resolveReviewedDraft,
  resumeAfterReauth,
  type PosDraftInput,
  type PosQueueSnapshot,
  type PosReplayRequest,
} from './pos-command-queue';

export type PosReplayResponse = {
  status: number;
  serverMessage?: string;
  retryAfter?: string | null;
  serverRef?: string | null;
};

export type PosOfflineRuntimeState = PosPersistedState<PosQueueSnapshot>;

/** The sole impure adapter between the POS, IndexedDB, and the pure queue transitions. */
export class PosOfflineRuntime {
  private state: PosOfflineRuntimeState;
  private activeReplay: Promise<ReplayResult> | null = null;

  constructor(
    readonly scope: PosScope,
    private readonly driver: PosStorageDriver
  ) {
    this.state = emptyPosState(scope);
    this.state.queue = createQueueSnapshot(scope.deviceId);
  }

  snapshot(): PosOfflineRuntimeState {
    return this.state;
  }

  async hydrate(): Promise<'ready' | 'unrecoverable'> {
    const result = await readPosState<PosQueueSnapshot>(this.driver, this.scope);
    if (result.status === 'unrecoverable') return 'unrecoverable';
    if (result.status === 'ok') {
      if (result.state.queue && result.state.queue.deviceId !== this.scope.deviceId) {
        return 'unrecoverable';
      }
      this.state = {
        ...result.state,
        queue: result.state.queue ?? createQueueSnapshot(this.scope.deviceId),
      };
    }
    return 'ready';
  }

  async cacheCatalog(payload: unknown, fetchedAtClient: string): Promise<PosCatalogSnapshot> {
    const version =
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? String(payload.version)
        : '';
    const catalog = sanitizeCatalogSnapshot(payload, { version, fetchedAtClient });
    const reviewed = markDraftsForCatalogReview(this.queue(), catalog);
    this.state = { ...this.state, catalog, queue: reviewed.snapshot };
    await this.persist();
    return catalog;
  }

  async enqueue(input: PosDraftInput) {
    const result = enqueueDraft(this.queue(), input);
    if (!result.ok) return result;
    this.state = { ...this.state, queue: result.snapshot };
    await this.persist();
    return result;
  }

  async resume(): Promise<void> {
    this.state = { ...this.state, queue: resumeAfterReauth(this.queue()) };
    await this.persist();
  }

  /**
   * Replace an expired composer proof only after the same operator has authenticated
   * again. The server still verifies the replacement proof on every replay request.
   */
  async renewComposerProof(staffProfileId: string, composerProof: string): Promise<void> {
    this.state = {
      ...this.state,
      queue: {
        ...this.queue(),
        drafts: this.queue().drafts.map((draft) =>
          draft.status !== 'COMPLETED' && draft.composerStaffProfileId === staffProfileId
            ? { ...draft, composerProof }
            : draft
        ),
      },
    };
    await this.persist();
  }

  async resolveReview(draftId: string, decision: 'REPLAY' | 'DISCARD'): Promise<void> {
    this.state = {
      ...this.state,
      queue: resolveReviewedDraft(
        this.queue(),
        draftId,
        decision,
        this.state.catalog?.version ?? ''
      ),
    };
    await this.persist();
  }

  replay(
    staffProfileId: string,
    send: (request: PosReplayRequest) => Promise<PosReplayResponse>
  ): Promise<ReplayResult> {
    if (this.activeReplay) return this.activeReplay;
    const replay = this.runReplay(staffProfileId, send);
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
      const next = nextReplayCommand(this.queue(), this.scope.deviceId, staffProfileId);
      if (next.status !== 'READY') return { state: next.status, discarded: null };
      const built = buildReplayRequest(next.draft, next.command);
      if (!built.ok) return { state: 'REFUSED' as const, discarded: null };

      this.state = {
        ...this.state,
        queue: beginReplay(this.queue(), next.draft.draftId, next.command.commandId),
      };
      await this.persist();

      let response: PosReplayResponse;
      try {
        response = await send(built.request);
      } catch {
        response = { status: 0 };
      }
      const applied = applyReplayOutcome(this.queue(), {
        draftId: next.draft.draftId,
        commandId: next.command.commandId,
        outcome: classifyReplayOutcome(response),
        serverRef: response.serverRef,
      });
      this.state = { ...this.state, queue: applied.snapshot };
      if (applied.snapshot.replay === 'STOPPED_REVOKED') {
        await purgePosScope(this.driver, this.scope);
        return { state: 'STOPPED' as const, discarded: applied.discarded };
      }
      await this.persist();
      if (classifyReplayOutcome(response).action !== 'ACK') {
        return { state: 'PAUSED' as const, discarded: applied.discarded };
      }
    }
  }

  close(): void {
    this.driver.close();
  }

  private queue(): PosQueueSnapshot {
    return this.state.queue ?? createQueueSnapshot(this.scope.deviceId);
  }

  private persist(): Promise<void> {
    return writePosState(this.driver, this.state);
  }
}

type ReplayResult = {
  state: 'IDLE' | 'PAUSED' | 'STOPPED' | 'REFUSED';
  discarded: { drafts: number; commands: number } | null;
};
