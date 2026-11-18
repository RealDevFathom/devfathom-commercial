/**
 * The counter that issued a receipt, printed on paper and shown in the returns
 * dialog. Receipt numbers are now unique per branch (DEV-637), but receipts issued
 * before that were sequenced per counter device and can repeat a number; the label
 * tells those apart. It is the registered counter name when there is one, otherwise
 * a short stable code from the device id, never the raw id.
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
