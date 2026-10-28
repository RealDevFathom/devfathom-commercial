import type { StoreUnit } from './queue';
import { handleInboundText } from '@/lib/growth/consent';

import { parseEvolutionWebhook } from './evolution';
import type { WhatsAppProvider } from './provider';
import type { GrowthWhatsAppStore, MessageStatus } from './types';

const RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 0,
  received: 0,
  failed: 1,
  sent: 1,
  delivered: 2,
  read: 3,
};

function forwardStatus(current: MessageStatus, incoming: 'sent' | 'delivered' | 'read' | 'failed') {
  if (incoming === 'failed') {
    return current === 'delivered' || current === 'read' ? current : 'failed';
  }
  return RANK[incoming] > RANK[current] ? incoming : current;
}

export async function handleGrowthWebhook(input: {
  store: GrowthWhatsAppStore;
  provider: WhatsAppProvider;
  organizationId: string;
  payload: unknown;
  businessName: string;
  now?: Date;
  afterCommit?: (send: () => Promise<void>) => void;
  confirmationUnit?: StoreUnit;
}): Promise<{ ignored: boolean }> {
  const parsed = parseEvolutionWebhook(input.payload);
  if (!parsed || parsed.kind === 'ignore') return { ignored: true };
  if (parsed.kind === 'status') {
    const row = await input.store.findOutboundByProviderId(
      input.organizationId,
      parsed.waMessageId
    );
    if (row) {
      const status = forwardStatus(row.status, parsed.status);
      if (status !== row.status) await input.store.markMessage(row.id, { status });
    }
    return { ignored: false };
  }
  await handleInboundText({
    store: input.store,
    afterCommit: input.afterCommit,
    confirmationUnit: input.confirmationUnit,
    provider: input.provider,
    organizationId: input.organizationId,
    fromE164: parsed.fromE164,
    text: parsed.text,
    waMessageId: parsed.waMessageId,
    businessName: input.businessName,
    now: input.now ?? new Date(),
  });
  return { ignored: false };
}
