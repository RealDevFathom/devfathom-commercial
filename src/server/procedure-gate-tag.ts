/**
 * DEV-959B — what a procedure-level middleware enforces, readable from a built procedure.
 *
 * The capability middlewares in `trpc.ts` carry a tag naming the check they run, so a test
 * can read each procedure's enforced gate straight from `procedure._def.middlewares` (and
 * `_def.meta` for deny-by-default procedures) instead of trusting a free-text description.
 * Replacing a gated builder with a weaker one changes what this reads. Tags never decide
 * anything at run time.
 */
import type { Action } from '@/lib/abac';

export type ProcedureGateTag =
  /** `requireCapability(action)`: the caller must hold this one action. */
  | { kind: 'capability'; action: Action }
  /** `requireDeclaredCapabilities`: every action in `.meta({ capabilities })`, none refuses. */
  | { kind: 'declared' }
  /** `contextualCapabilityProcedure`: actions chosen from the context at run time. */
  | { kind: 'contextual' }
  /** `requireActiveUser`: any signed-in member with a usable session. */
  | { kind: 'signed-in' };

const GATE_TAG: unique symbol = Symbol.for('devfathom.procedureGate');

/** Marks a middleware function with the gate it enforces and returns the same function. */
export function tagProcedureGate<T extends object>(fn: T, tag: ProcedureGateTag): T {
  Object.defineProperty(fn, GATE_TAG, { value: tag, enumerable: false });
  return fn;
}

type ProcedureLike = {
  _def: { middlewares?: readonly unknown[]; meta?: { capabilities?: readonly string[] } };
};

/**
 * The gate a built procedure enforces at procedure level, as sorted tokens: an action name
 * for each capability it requires, `contextual` for a run-time choice, `signed-in` for the
 * session check alone, and `refused` for a deny-by-default procedure with no annotation.
 * An empty list means the procedure checks nothing before its resolver (a public one).
 */
export function enforcedProcedureGate(procedure: ProcedureLike): string[] {
  const tokens = new Set<string>();
  for (const middleware of procedure._def.middlewares ?? []) {
    if (typeof middleware !== 'function') continue;
    const tag = (middleware as unknown as Record<symbol, ProcedureGateTag | undefined>)[GATE_TAG];
    if (!tag) continue;
    if (tag.kind === 'capability') tokens.add(tag.action);
    else if (tag.kind === 'declared') {
      const declared = procedure._def.meta?.capabilities ?? [];
      if (declared.length === 0) tokens.add('refused');
      for (const action of declared) tokens.add(action);
    } else tokens.add(tag.kind);
  }
  return [...tokens].sort();
}
