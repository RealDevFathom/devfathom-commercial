/**
 * DEV-957 phase 2: the pharmacy counter device secret's server-side lifetime. Pure, so the
 * counter route and the device service read one rule.
 */
/**
 * How long a counter's device secret is accepted for anything that
 * extends its offline selling (snapshots, receipt blocks, quotas). Enrolment sets it
 * (the column default), and every rotation or renewal moves it this far on.
 */
export const PHARMACY_DEVICE_SECRET_LIFETIME_DAYS = 30;
/** An online counter renews its own secret once fewer than this many days are left. */
export const PHARMACY_DEVICE_SECRET_RENEW_WITHIN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function pharmacyDeviceSecretExpiry(now: Date): Date {
  return new Date(now.getTime() + PHARMACY_DEVICE_SECRET_LIFETIME_DAYS * DAY_MS);
}

/** True once the server no longer issues snapshots, receipt blocks or quotas to this secret. */
export function pharmacyDeviceSecretExpired(
  device: { secretExpiresAt: Date },
  now: Date
): boolean {
  return device.secretExpiresAt.getTime() <= now.getTime();
}

/** True when an online counter should renew its own secret now. */
export function pharmacyDeviceSecretDueForRenewal(
  device: { secretExpiresAt: Date },
  now: Date
): boolean {
  return (
    !pharmacyDeviceSecretExpired(device, now) &&
    device.secretExpiresAt.getTime() - now.getTime() <=
      PHARMACY_DEVICE_SECRET_RENEW_WITHIN_DAYS * DAY_MS
  );
}

