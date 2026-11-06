/**
 * One owner turn's shared limits. The assistant route creates one per request and passes
 * it to the routed model; every provider attempt (first call, retry or failover) spends
 * one model call, and no attempt starts after the deadline.
 */
export type TurnBudget = {
  /** Epoch milliseconds after which no new provider attempt may start. */
  readonly deadline: number;
  readonly maxModelCalls: number;
  /** Attempts made so far in this turn, across every step and provider. */
  modelCalls: number;
};

/** Decided limits for an interactive Ask Fathom turn. */
export const ASK_FATHOM_TURN_TIMEOUT_MS = 90_000;
export const ASK_FATHOM_MAX_MODEL_CALLS = 4;
export const ASK_FATHOM_MAX_TOOL_CALLS = 6;

export function createTurnBudget(
  input: { timeoutMs?: number; maxModelCalls?: number; now?: number } = {}
): TurnBudget {
  const now = input.now ?? Date.now();
  return {
    deadline: now + (input.timeoutMs ?? ASK_FATHOM_TURN_TIMEOUT_MS),
    maxModelCalls: input.maxModelCalls ?? ASK_FATHOM_MAX_MODEL_CALLS,
    modelCalls: 0,
  };
}

/** Milliseconds left in the turn, never negative. */
export function remainingMs(budget: TurnBudget, now: number = Date.now()): number {
  return Math.max(0, budget.deadline - now);
}

/**
 * Claim one model call. Returns false, and spends nothing, when the turn is out of
 * calls or time; the caller then stops instead of contacting a provider.
 */
export function claimModelCall(budget: TurnBudget, now: number = Date.now()): boolean {
  if (budget.modelCalls >= budget.maxModelCalls || remainingMs(budget, now) <= 0) return false;
  budget.modelCalls += 1;
  return true;
}
