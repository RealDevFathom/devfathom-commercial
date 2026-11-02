export function paymentSandboxAdmitted(
  env: { NODE_ENV?: string; PHARMACY_PAYMENT_SANDBOX_ADMITTED?: string; DATABASE_URL?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    PHARMACY_PAYMENT_SANDBOX_ADMITTED: process.env.PHARMACY_PAYMENT_SANDBOX_ADMITTED,
    DATABASE_URL: process.env.DATABASE_URL,
  }
) {
  if (env.NODE_ENV === 'production' || env.PHARMACY_PAYMENT_SANDBOX_ADMITTED !== 'true')
    return false;
  try {
    const url = new URL(env.DATABASE_URL ?? '');
    return (
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '55625' &&
      /^\/wha1364_business_disposable_20261008(?:_[a-z0-9]+)?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
