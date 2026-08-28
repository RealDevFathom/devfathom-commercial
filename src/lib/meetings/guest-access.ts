/**
 * Guest credentials for a single meeting occurrence — WHA-235 (Lane 1).
 *
 * WHAT A GUEST HOLDS IS TWO SEPARATE THINGS, AND THAT SEPARATION IS THE DESIGN.
 *
 *   - `MeetingOccurrence.publicId` is a LOCATOR. It is in the join URL, it is
 *     shareable, and holding it proves nothing. The model doc says so in as
 *     many words: "It is a LOCATOR, NOT AUTHORIZATION."
 *   - the guest SECRET is the credential. It is minted once, shown once,
 *     stored only as a SHA-256 hash on `MeetingOccurrenceParticipant`, and
 *     expires.
 *
 * THE SECRET NEVER TRAVELS IN A URL. That is what makes it different from
 * `src/lib/invite-token.ts`, whose token is deliberately a link. A URL is
 * written to browser history, `Referer` headers, proxy logs, server access
 * logs, and chat-app link previews — none of which are places a live meeting
 * credential may sit. So the join link carries `publicId` only and the guest
 * TYPES the secret. Being typed by a human is also why the secret is grouped
 * base32 over an alphabet with no `0/O` or `1/I` confusions, rather than the
 * base64url of an invite token.
 *
 * IT IS OCCURRENCE-SCOPED, NEVER SERIES-SCOPED. The `MeetingParticipant` model
 * doc forbids credential columns on the series row, and
 * `scripts/verify-tenant-isolation.ts` asserts that boundary, because a secret
 * that outlives one occurrence is a permanent key to every future one.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Typing alphabet: RFC 4648 base32 minus the characters people transcribe
 * wrongly off a screen (`0`/`O`, `1`/`I`/`L`). 28 symbols, so each character
 * carries just under 4.81 bits.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ2345678';

/** Characters per group in the displayed form, e.g. `A2CD-E4GH-…`. */
const GROUP_SIZE = 4;
/** Number of groups. 20 characters over a 30-symbol alphabet ≈ 98 bits. */
const GROUP_COUNT = 5;

const SECRET_LENGTH = GROUP_SIZE * GROUP_COUNT;

/**
 * A raw guest secret, in the grouped form handed to exactly one person exactly
 * once.
 *
 * The branded type is not decoration. It makes "did this value reach a log
 * line" answerable by the compiler rather than by review: a `GuestSecret` has
 * no implicit string conversion at a call site typed for `string`, so passing
 * one to a logger is a type error and has to be spelled out deliberately.
 */
export type GuestSecret = string & { readonly __brand: 'GuestSecret' };

/** What `mintGuestSecret` returns: the value to deliver, and the value to store. */
export type MintedGuestSecret = {
  /** Show once, deliver out of band, never persist, never log. */
  secret: GuestSecret;
  /** The only representation that may reach the database. */
  secretHash: string;
};

/**
 * Deterministic hash for storage and lookup.
 *
 * SHA-256 rather than bcrypt for the same reason `hashInviteToken` uses it: the
 * secret carries ~98 bits of entropy, so a slow hash buys nothing against a
 * brute force that is already infeasible, and a deterministic digest is what
 * allows a single indexed lookup on `guestTokenHash` instead of a scan.
 */
export function hashGuestSecret(secret: string): string {
  return createHash('sha256').update(normalizeGuestSecret(secret)).digest('hex');
}

/**
 * Fold a typed secret back to canonical form.
 *
 * A human retyping `a2cd-e4gh` must authenticate as readily as one pasting
 * `A2CDE4GH`, so grouping punctuation and case are stripped before hashing.
 * Whitespace goes too — copying out of an email reliably brings some along.
 */
export function normalizeGuestSecret(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** Mint a fresh guest secret. The raw value exists only in the returned object. */
export function mintGuestSecret(): MintedGuestSecret {
  // Rejection sampling, not `% ALPHABET.length`. The modulo of a uniform byte
  // over 30 symbols is biased toward the first 16, which would quietly cost
  // entropy the length calculation above claims to have.
  const characters: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

  while (characters.length < SECRET_LENGTH) {
    for (const byte of randomBytes(SECRET_LENGTH)) {
      if (byte >= limit) continue;
      characters.push(ALPHABET[byte % ALPHABET.length]);
      if (characters.length === SECRET_LENGTH) break;
    }
  }

  const groups: string[] = [];
  for (let index = 0; index < GROUP_COUNT; index++) {
    groups.push(characters.slice(index * GROUP_SIZE, (index + 1) * GROUP_SIZE).join(''));
  }

  const secret = groups.join('-') as GuestSecret;
  return { secret, secretHash: hashGuestSecret(secret) };
}

/**
 * Compare two hex digests without leaking their divergence point through
 * timing.
 *
 * Reached only after an indexed lookup has already selected a candidate row, so
 * this is defence in depth rather than the primary control — but a digest
 * comparison written with `===` is exactly the kind of detail that stops being
 * defence in depth the moment the lookup shape changes.
 */
export function guestSecretHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Why a guest credential was refused. Never distinguishes these to the caller. */
export type GuestRejection =
  | 'unknown_occurrence'
  | 'invalid_secret'
  | 'expired'
  | 'revoked'
  | 'removed'
  | 'occurrence_cancelled'
  | 'outside_join_window';

/**
 * The credential state stored against one occurrence participant, as the
 * verifier needs to see it.
 */
export type GuestCredentialRow = {
  guestTokenHash: string | null;
  guestTokenExpiresAt: Date | null;
  guestTokenRevokedAt: Date | null;
  removedAt: Date | null;
};

/** The occurrence state a guest credential is evaluated against. */
export type GuestOccurrenceRow = {
  status: string;
  joinOpensAt: Date;
  joinClosesAt: Date;
};

/**
 * Decide whether a presented secret admits its holder to an occurrence.
 *
 * PURE, so the whole decision table is testable without a database and without
 * a clock. The caller supplies the rows and `now`; this returns a verdict.
 *
 * Every failure returns a REASON for the server's own use, and callers are
 * expected to collapse them all into one indistinguishable client-facing error
 * — an "expired" that is distinguishable from an "invalid secret" tells an
 * attacker which occurrence ids and which secrets were ever real.
 */
export function evaluateGuestCredential(args: {
  credential: GuestCredentialRow;
  occurrence: GuestOccurrenceRow;
  presentedSecret: string;
  now: Date;
}): { ok: true } | { ok: false; reason: GuestRejection } {
  const { credential, occurrence, presentedSecret, now } = args;

  if (!credential.guestTokenHash) return { ok: false, reason: 'invalid_secret' };
  if (!guestSecretHashesMatch(credential.guestTokenHash, hashGuestSecret(presentedSecret))) {
    return { ok: false, reason: 'invalid_secret' };
  }

  // Revocation and removal are checked BEFORE expiry so that an operator who
  // has explicitly withdrawn access sees that reason in the server log, rather
  // than it being masked once the clock passes the expiry.
  if (credential.guestTokenRevokedAt) return { ok: false, reason: 'revoked' };
  if (credential.removedAt) return { ok: false, reason: 'removed' };

  // The CHECK constraint `meeting_occurrence_participants_guest_token_check`
  // makes a hash without an expiry impossible to store, so a null here is a
  // corrupt row rather than a permanent credential — treated as expired, which
  // is the fail-closed reading.
  if (!credential.guestTokenExpiresAt) return { ok: false, reason: 'expired' };
  if (credential.guestTokenExpiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (occurrence.status === 'CANCELLED') return { ok: false, reason: 'occurrence_cancelled' };

  if (
    now.getTime() < occurrence.joinOpensAt.getTime() ||
    now.getTime() > occurrence.joinClosesAt.getTime()
  ) {
    return { ok: false, reason: 'outside_join_window' };
  }

  return { ok: true };
}

/**
 * The expiry to stamp on a freshly minted guest credential.
 *
 * DERIVED FROM THE OCCURRENCE, not from an invented duration. The
 * `MeetingOccurrenceParticipant` model doc states the rule this implements —
 * "Everything here expires with the occurrence it belongs to" — so the
 * credential dies when the occurrence stops being joinable, which is already
 * data on the row. That keeps the value out of the `link TTL` decision the
 * owner still has to make: whatever TTL they choose, it can only be SHORTER
 * than this, and it is applied by lowering `joinClosesAt` or by passing an
 * explicit cap here.
 */
export function guestSecretExpiryFor(
  occurrence: { joinClosesAt: Date },
  options: { maxTtlMs?: number; now?: Date } = {}
): Date {
  const closes = occurrence.joinClosesAt;
  if (options.maxTtlMs === undefined) return new Date(closes);
  const now = options.now ?? new Date();
  const capped = new Date(now.getTime() + options.maxTtlMs);
  return capped.getTime() < closes.getTime() ? capped : new Date(closes);
}
