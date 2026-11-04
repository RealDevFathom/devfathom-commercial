import type { ToolSet } from 'ai';

export const TOOL_CALL_LIMIT_MESSAGE = 'Tool call limit reached for this turn.';

/**
 * Share one tool-call allowance across a turn's tools (DEV-576). Calls past `max`
 * return `{ error }` without running. Each tool is copied, never mutated, so its other
 * properties (schema, approval flag) are unchanged.
 */
export function limitToolCalls<TOOLS extends ToolSet>(tools: TOOLS, max: number): TOOLS {
  let calls = 0;
  const limited: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (typeof execute !== 'function') {
      limited[name] = tool;
      continue;
    }
    limited[name] = {
      ...tool,
      execute: (input: unknown, options: unknown) => {
        calls += 1;
        if (calls > max) return { error: TOOL_CALL_LIMIT_MESSAGE };
        return (execute as (input: unknown, options: unknown) => unknown)(input, options);
      },
    };
  }
  return limited as TOOLS;
}
