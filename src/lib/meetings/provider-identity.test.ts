import { describe, expect, it } from 'vitest';
import { createMeetingProviderIdentity, parseMeetingProviderIdentity } from './provider-identity';

describe('meeting provider identity contract', () => {
  it.each([
    ['usr', 'user-1'],
    ['gst', 'grant-1'],
    ['usr', 'user:1'],
    ['gst', 'guest:grant-1'],
  ] as const)('round-trips the admitted %s identity for %s', (namespace, value) => {
    const identity = createMeetingProviderIdentity(namespace, value);
    expect(identity).toBe(`${namespace}:${value}`);
    expect(parseMeetingProviderIdentity(identity)).toEqual({ namespace, value });
  });

  it('preserves legacy unprefixed identities', () => {
    expect(parseMeetingProviderIdentity('grant-1')).toEqual({
      namespace: 'legacy',
      value: 'grant-1',
    });
  });

  it.each(['', 'usr:', 'gst:', ':grant-1', 'unknown:grant-1'])(
    'rejects an empty or unsupported identity (%s)',
    (identity) => {
      expect(parseMeetingProviderIdentity(identity)).toBeNull();
    }
  );

  it.each(['usr', 'gst'] as const)('does not create an empty %s identity', (namespace) => {
    expect(() => createMeetingProviderIdentity(namespace, '')).toThrow(
      'Meeting provider identity requires a non-empty value.'
    );
  });
});
