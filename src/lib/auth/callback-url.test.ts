import { describe, expect, it } from 'vitest';

import { DEFAULT_CALLBACK_URL, safeCallbackUrl } from './callback-url';

const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

// D15 — every one of these passed the previous `/^\/(?![/\\])/` check. It was
// safe only because its single consumer was `router.replace`.
describe('safeCallbackUrl hostile input', () => {
  it.each([
    ['encoded protocol-relative', '/%2f%2fevil.com'],
    ['double-encoded protocol-relative', '/%252f%252fevil.com'],
    ['authority-looking first segment', '/@evil.com'],
    ['encoded authority-looking first segment', '/%40evil.com'],
    ['port-looking first segment', '/evil.com:8080'],
    ['protocol-relative', '//evil.com'],
    ['backslash protocol-relative', '/\\evil.com'],
    ['backslash-backslash', '\\\\evil.com'],
    ['absolute https', 'https://evil.com'],
    ['absolute http', 'http://evil.com'],
    ['scheme-only', 'javascript:alert(1)'],
    ['encoded scheme', 'java%73cript:alert(1)'],
    ['data url', 'data:text/html,<script>alert(1)</script>'],
    ['tab prefix', `/${TAB}evil`],
    ['newline prefix', `/${NEWLINE}https://evil.com`],
    ['carriage return', `/dash${CARRIAGE_RETURN}board`],
    ['null byte', `/dashboard${NUL}`],
    ['zero-width space', `/${ZERO_WIDTH_SPACE}/evil.com`],
    ['byte order mark', `/${BOM}evil`],
    ['leading space', ' /dashboard'],
    ['relative path', 'dashboard'],
    ['parent traversal to a scheme', '/../..//evil.com/%2e%2e'],
    ['malformed percent-encoding', '/%zz'],
    ['empty', ''],
  ])('refuses %s', (_label, hostile) => {
    expect(safeCallbackUrl(hostile)).toBe(DEFAULT_CALLBACK_URL);
  });

  it.each([[null], [undefined], [123 as unknown as string], [{} as unknown as string]])(
    'refuses the non-string %j',
    (value) => {
      expect(safeCallbackUrl(value)).toBe(DEFAULT_CALLBACK_URL);
    }
  );

  it('refuses an absurdly long value', () => {
    expect(safeCallbackUrl(`/${'a'.repeat(4000)}`)).toBe(DEFAULT_CALLBACK_URL);
  });
});

describe('safeCallbackUrl accepted paths', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/projects/123', '/projects/123'],
    ['/finance?tab=invoices', '/finance?tab=invoices'],
    ['/team#members', '/team#members'],
    ['/projects/123?a=1&b=2#top', '/projects/123?a=1&b=2#top'],
    ['/', '/'],
    // Percent-encoded but same-origin: decoded, then normalized by the parser.
    ['/projects/a%20b', '/projects/a%20b'],
  ])('accepts %j', (input, expected) => {
    expect(safeCallbackUrl(input)).toBe(expected);
  });

  it('normalizes ordinary traversal', () => {
    expect(safeCallbackUrl('/a/../b')).toBe('/b');
    expect(safeCallbackUrl('/a/./b')).toBe('/a/b');
  });

  // `/..//evil.com` normalizes to `//evil.com` — a protocol-relative URL, and an
  // open redirect in any consumer that assigns it to `location`.
  it('refuses traversal that resolves into a protocol-relative URL', () => {
    expect(safeCallbackUrl('/..//evil.com')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/a/..//evil.com')).toBe(DEFAULT_CALLBACK_URL);
  });
});
