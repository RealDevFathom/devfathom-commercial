import 'server-only';
import { customerWhatsAppText } from './customer-pwa';

type CustomerSmsEnv = Record<string, string | undefined>;

/** Explicit tenant binding prevents a shared deployment from using another store's sender. */
export function customerSmsConfigured(organizationId: string, env: CustomerSmsEnv = process.env) {
  return (
    env.PHARMACY_CUSTOMER_SMS_ORGANIZATION_ID === organizationId &&
    /^AC[0-9a-f]{32}$/i.test(env.PHARMACY_CUSTOMER_SMS_ACCOUNT_SID ?? '') &&
    Boolean(env.PHARMACY_CUSTOMER_SMS_AUTH_TOKEN && env.PHARMACY_CUSTOMER_SMS_FROM)
  );
}

export async function sendCustomerSms(
  organizationId: string,
  phone: string,
  code: string,
  fetchImpl = fetch,
  env: CustomerSmsEnv = process.env
) {
  if (
    !customerSmsConfigured(organizationId, env) ||
    !/^[1-9]\d{7,14}$/.test(phone) ||
    !/^\d{6}$/.test(code)
  )
    throw new Error('CUSTOMER_SMS_UNAVAILABLE');
  const sid = env.PHARMACY_CUSTOMER_SMS_ACCOUNT_SID!;
  const response = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${env.PHARMACY_CUSTOMER_SMS_AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: `+${phone}`,
        From: env.PHARMACY_CUSTOMER_SMS_FROM!,
        Body: customerWhatsAppText('OTP', code),
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    }
  );
  const result = (await response.json().catch(() => null)) as {
    sid?: string;
    status?: string;
  } | null;
  if (!response.ok || !result?.sid || result.status === 'failed' || result.status === 'undelivered')
    throw new Error('CUSTOMER_SMS_DELIVERY_FAILED');
}
