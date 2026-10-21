const URDU_DIGITS = /[۰-۹٠-٩]/g;

function asciiDigits(value: string): string {
  return value.replace(URDU_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * Pakistani local mobiles (`03xxxxxxxxx`, `3xxxxxxxxx`) become `+923…`.
 * Other international numbers keep their country code. Returns null when the
 * digits are not a plausible E.164 subscriber number.
 */
export function normalizeWhatsAppE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = asciiDigits(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('3')) digits = `92${digits}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

export class InvalidWhatsAppPhone extends Error {
  constructor() {
    super('Enter a WhatsApp mobile number.');
    this.name = 'InvalidWhatsAppPhone';
  }
}
