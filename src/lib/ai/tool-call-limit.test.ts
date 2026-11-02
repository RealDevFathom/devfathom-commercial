import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';

import { limitToolCalls, TOOL_CALL_LIMIT_MESSAGE } from './tool-call-limit';

describe('limitToolCalls', () => {
  it('shares one allowance across tools and refuses past it without running', async () => {
    const read = vi.fn(async () => ({ ok: 'read' }));
    const write = vi.fn(async () => ({ ok: 'write' }));
    const tools = {
      read: { description: 'r', inputSchema: {}, execute: read },
      write: { description: 'w', inputSchema: {}, needsApproval: true, execute: write },
      clientSide: { description: 'c', inputSchema: {} },
    } as unknown as ToolSet;
    const limited = limitToolCalls(tools, 3);
    const run = (name: 'read' | 'write') =>
      (limited[name]!.execute as (input: unknown, options: unknown) => unknown)({}, {});
    expect(await run('read')).toEqual({ ok: 'read' });
    expect(await run('write')).toEqual({ ok: 'write' });
    expect(await run('read')).toEqual({ ok: 'read' });
    expect(await run('write')).toEqual({ error: TOOL_CALL_LIMIT_MESSAGE });
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect((limited.write as { needsApproval?: unknown }).needsApproval).toBe(true);
    expect(limited.clientSide).toBe(tools.clientSide);
    expect(tools.read!.execute).toBe(read);
  });
});
