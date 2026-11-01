// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const merge = createRequire(import.meta.url)('deepmerge');

describe('GHSA-gcqx-w48m-w2h4 patched deepmerge', () => {
  it('copies own __proto__ keys without changing the result prototype', () => {
    const payload = JSON.parse('{"__proto__":{"poisoned":true}}');
    for (const result of [
      merge(payload, {}),
      merge(Object.create(null), payload),
      merge({}, { nested: payload }).nested,
    ]) {
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result.poisoned).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).poisoned).toBeUndefined();
  });
  it('preserves array, nested object, all and custom array merge behavior', () => {
    expect(merge({ a: [1], b: { x: 1 } }, { a: [2], b: { y: 2 } })).toEqual({
      a: [1, 2],
      b: { x: 1, y: 2 },
    });
    expect(merge.all([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
    expect(merge({ a: [1] }, { a: [2] }, { arrayMerge: (_a: unknown, b: unknown) => b })).toEqual({
      a: [2],
    });
  });
});
