import type { inferRouterOutputs } from '@trpc/server';

import type { AppRouter } from '@/server/routers/_app';

type WebhookJobStatus =
  inferRouterOutputs<AppRouter>['restaurantNotifications']['webhookStatus']['deliveries'][number]['status'];

export function retryWebhookNotice(status: WebhookJobStatus): string {
  switch (status) {
    case 'QUEUED':
      return 'Webhook retry is queued.';
    case 'RUNNING':
      return 'Webhook retry is currently running.';
    case 'SUCCEEDED':
      return 'Webhook retry already succeeded.';
    case 'FAILED':
      return 'Webhook retry finished with a permanent failure.';
    case 'DEAD':
      return 'Webhook retry is dead-lettered.';
  }
}
