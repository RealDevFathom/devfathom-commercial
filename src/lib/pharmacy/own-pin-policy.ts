/**
 * DEV-931 — the rules and words for a person's own approval PIN, shared by the server and
 * the "Your PIN" screen. Pure: no database, no secrets.
 *
 * The PIN itself is the existing operator credential (4 to 8 digits, hashed with bcrypt in
 * `src/lib/restaurant/operator-credentials.ts`). A PIN a person chooses for themselves is
 * also refused when it is trivially guessable: one digit repeated, a straight run up or
 * down, or one pair of digits repeated.
 */

/**
 * The operator credential's PIN length (`PIN_MIN_LENGTH`/`PIN_MAX_LENGTH` in the server-only
 * `operator-credentials.ts`), repeated here so the screen can explain it. A test keeps the two equal.
 */
export const OWN_PIN_MIN_LENGTH = 4;
export const OWN_PIN_MAX_LENGTH = 8;

/** Where a person creates or changes their own PIN. */
export const OWN_PIN_PATH = '/pharmacy/settings/pin';

/** Every "no PIN set" refusal in the pharmacy uses exactly these words, so the screen can link them. */
export const NO_PIN_SET_MESSAGE =
  'You have not set up your PIN yet. Create it in Settings, Your PIN, then try again.';

export const OWN_PIN_RULES = `Use ${OWN_PIN_MIN_LENGTH} to ${OWN_PIN_MAX_LENGTH} digits. Easy PINs are not accepted: 1111, 1234, 1212, a year such as 1990, or the end of your phone number.`;

/**
 * True for a PIN anyone would guess first: one digit repeated (0000), a straight run up or
 * down (1234, 9876), one pair repeated (1212), or a four-digit year from 1900 to 2099.
 */
export function isTriviallyWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  if (/^(\d\d)\1+$/.test(pin)) return true;
  if (/^(19|20)\d\d$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]!);
  return (
    steps.length > 0 && (steps.every((step) => step === 1) || steps.every((step) => step === -1))
  );
}

/** True when the PIN is the last digits of the person's own phone number. */
export function isPhoneNumberTail(pin: string, phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= pin.length && digits.endsWith(pin);
}

/**
 * Why a chosen PIN cannot be saved, or null when it can. The one rule for a person's own
 * PIN: the screen explains it, and the server enforces it with the person's phone number.
 */
export function ownPinProblem(
  pin: string,
  confirmation: string,
  person: { phone?: string | null } = {}
): string | null {
  if (pin.length < OWN_PIN_MIN_LENGTH || pin.length > OWN_PIN_MAX_LENGTH || !/^\d+$/.test(pin))
    return `Your PIN must be ${OWN_PIN_MIN_LENGTH} to ${OWN_PIN_MAX_LENGTH} digits.`;
  if (isTriviallyWeakPin(pin)) return 'That PIN is too easy to guess. Choose a different one.';
  if (isPhoneNumberTail(pin, person.phone))
    return 'That PIN is the end of your phone number. Choose a different one.';
  if (pin !== confirmation) return 'The two PINs do not match.';
  return null;
}

/** True when a refusal is the shared "no PIN set" message. */
export function isNoPinSetMessage(message: string | null | undefined): boolean {
  return message === NO_PIN_SET_MESSAGE;
}
