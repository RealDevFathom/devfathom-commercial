import { assertBodyHasStop } from '@/lib/growth/templates';

import type { WhatsAppProvider, WhatsAppSendResult } from './provider';
import { NotOptedIn, type GrowthCustomer } from './types';

/**
 * The only outbound path for campaign and queue sends. Refuses a customer
 * who is not opted in, and refuses a body that dropped the STOP line.
 */
export async function sendText(input: {
  provider: WhatsAppProvider;
  customer: GrowthCustomer | null;
  body: string;
}): Promise<WhatsAppSendResult> {
  if (!input.customer?.whatsappOptIn || !input.customer.whatsappE164) throw new NotOptedIn();
  assertBodyHasStop(input.body);
  return input.provider.sendText(input.customer.whatsappE164, input.body);
}
