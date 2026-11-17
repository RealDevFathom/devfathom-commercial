import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config agent rules (DEV-857)', () => {
  it('stops `next dev` from rewriting AGENTS.md', () => {
    expect((nextConfig as { agentRules?: boolean }).agentRules).toBe(false);
  });
});
