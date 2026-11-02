const DECIMAL_MINOR_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

export function safeMinorFromBigInt(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe minor-unit range.`);
  }
  return Number(value);
}

export function addSafeMinor(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${label} contains an invalid minor-unit value.`);
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${label} exceeds the safe minor-unit range.`);
  }
  return total;
}

/** Parse non-negative decimal major units without a binary floating-point conversion. */
export function parseMajorUnitsToMinor(value: string | undefined): number | null {
  const match = value?.trim().match(DECIMAL_MINOR_PATTERN);
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
