/**
 * Receipt numbers are sequenced per counter device, so a branch can hold several
 * "Receipt 1". The label below is what tells them apart on paper and in the
 * returns dialog: the registered counter name when there is one, otherwise a
 * short stable code from the device id, never the raw id.
 */
export function counterLabel(
  deviceId: string | null | undefined,
  registeredName?: string | null
): string | null {
  const name = registeredName?.trim();
  if (name) return name.slice(0, 40);
  if (!deviceId) return null;
  const code = deviceId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
  return code ? `Counter ${code}` : null;
}
