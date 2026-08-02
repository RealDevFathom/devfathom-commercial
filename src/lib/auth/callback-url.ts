/**
 * D15 — where a successful sign-in is allowed to land.
 *
 * The previous check was `/^\/(?![/\\])/.test(raw)`, evaluated in the browser.
 * `/%2f%2fevil.com`, `/@evil.com`, `/..//evil.com` and a tab-prefixed path all
 * satisfy it; it was safe only because its single consumer happened to be
 * `router.replace`. That is a property of the call site, not of the value, and
 * the shared-host login adds call sites.
 *
 * The rule now: decode first, reject control characters and whitespace, then
 * accept only a same-origin absolute path — proven by resolving against an
 * opaque base and requiring the origin to be unchanged. The returned value is
 * the parser's normalized path, never the caller's string.
 */
export const DEFAULT_CALLBACK_URL = '/dashboard';

/** An origin no real deployment can hold, used purely to detect origin escapes. */
const OPAQUE_BASE = 'https://callback.invalid';

/**
 * C0 controls and space, DEL, the C1 range and NBSP, and the Unicode spaces,
 * bidirectional marks and invisible formatting characters that some URL parsers
 * strip and others keep.
 *
 * Written as code-point ranges rather than a character class so the source
 * contains no invisible characters — a reviewer can see exactly what is refused.
 */
function isControlOrSpace(codePoint: number): boolean {
  if (codePoint <= 0x20) return true; // NUL..SPACE, including TAB, LF, CR
  if (codePoint >= 0x7f && codePoint <= 0xa0) return true; // DEL, C1, NBSP
  if (codePoint === 0x1680) return true; // OGHAM SPACE MARK
  if (codePoint >= 0x2000 && codePoint <= 0x200f) return true; // spaces, ZWSP, LRM/RLM
  if (codePoint >= 0x2028 && codePoint <= 0x202f) return true; // separators, bidi overrides
  if (codePoint >= 0x205f && codePoint <= 0x2064) return true; // MMSP, invisible operators
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true; // bidi isolates
  if (codePoint === 0x3000) return true; // IDEOGRAPHIC SPACE
  if (codePoint === 0xfeff) return true; // BOM / ZWNBSP
  return false;
}

function hasControlOrSpace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isControlOrSpace(codePoint)) return true;
  }
  return false;
}

/**
 * As above but tolerating a plain space, for the DECODED form: `%20` inside a
 * path segment is legitimate and changes nothing structurally, whereas a raw
 * space in the submitted value is always suspicious.
 */
function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 0x20) continue;
    if (isControlOrSpace(codePoint)) return true;
  }
  return false;
}

function fullyDecode(value: string): string | null {
  let current = value;
  // A single decode is not enough: `%252f` decodes to `%2f`, which decodes to
  // `/`. Bounded so a crafted input cannot spin here.
  for (let pass = 0; pass < 4; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null; // malformed percent-encoding
    }
    if (decoded === current) return current;
    current = decoded;
  }
  return null;
}

export function safeCallbackUrl(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return DEFAULT_CALLBACK_URL;
  }

  // Raw whitespace or a control character in the submitted value is always
  // suspicious — that is how a tab- or newline-prefixed value slips past naive
  // parsers that differ from the browser's.
  if (hasControlOrSpace(raw)) return DEFAULT_CALLBACK_URL;

  // Decoding is for INSPECTION only: `%2f%2fevil.com` has to be judged as the
  // `//evil.com` a downstream consumer might decode it into. The value actually
  // resolved below is still the caller's, so a legitimate `%20` survives.
  const decoded = fullyDecode(raw);
  if (decoded === null) return DEFAULT_CALLBACK_URL;
  if (hasControl(decoded)) return DEFAULT_CALLBACK_URL;

  for (const candidate of [raw, decoded]) {
    // Must be an absolute path on this origin. `//evil.com` and `/\evil.com` are
    // protocol-relative and scheme-relative escapes, not paths.
    if (!candidate.startsWith('/')) return DEFAULT_CALLBACK_URL;
    if (candidate.startsWith('//') || candidate.startsWith('/\\')) return DEFAULT_CALLBACK_URL;

    // A leading segment carrying authority syntax (`/@host`, `/host:port`) is
    // same-origin under the WHATWG parser but is read as an authority by several
    // other parsers. This product has no such route, so refusing it costs nothing.
    const firstSegment = candidate.slice(1).split(/[/?#\\]/, 1)[0] ?? '';
    if (firstSegment.includes('@') || firstSegment.includes(':')) return DEFAULT_CALLBACK_URL;
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, OPAQUE_BASE);
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
  if (resolved.origin !== OPAQUE_BASE) return DEFAULT_CALLBACK_URL;

  const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // `/..//evil.com` normalizes to `//evil.com` — a protocol-relative URL, and an
  // open redirect in any consumer that assigns it to `location`. Traversal that
  // resolves into one is refused rather than repaired.
  if (!normalized.startsWith('/') || normalized.startsWith('//')) return DEFAULT_CALLBACK_URL;
  return normalized;
}
