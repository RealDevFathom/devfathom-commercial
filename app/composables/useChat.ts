import type { ErrorInfo, TokenRequest } from 'ably';
import type { Channel, Message } from '~/types/collaboration';

export function useChat() {
  const { request } = useApi();
  return {
    channels: () => request<Channel[]>('/api/v1/chat/channels'),
    browse: (q = '') => request<Channel[]>('/api/v1/chat/channels/browse', { query: { q } }),
    createChannel: (body: Record<string, unknown>) =>
      request<Channel>('/api/v1/chat/channels', { method: 'POST', body }),
    directMessage: (userId: string) =>
      request<Channel>('/api/v1/chat/channels/dm', { method: 'POST', body: { userId } }),
    join: (id: string) => request(`/api/v1/chat/channels/${id}/join`, { method: 'POST' }),
    leave: (id: string) => request(`/api/v1/chat/channels/${id}/leave`, { method: 'POST' }),
    mute: (id: string, muted: boolean) =>
      request(`/api/v1/chat/channels/${id}/mute`, { method: 'PUT', body: { muted } }),
    read: (id: string) => request(`/api/v1/chat/channels/${id}/read`, { method: 'POST' }),
    messages: (id: string, cursor?: string) =>
      request<{ items: Message[]; nextCursor?: string | null }>(
        `/api/v1/chat/channels/${id}/messages`,
        { query: { cursor } }
      ),
    send: (
      id: string,
      content: string,
      parentId?: string,
      attachments: Array<Record<string, unknown>> = []
    ) =>
      request<Message>(`/api/v1/chat/channels/${id}/messages`, {
        method: 'POST',
        body: { content, parentId, mentionIds: [], attachments },
      }),
    thread: (id: string) =>
      request<{ parent: Message; replies: Message[] }>(`/api/v1/chat/messages/${id}/thread`),
    edit: (id: string, content: string) =>
      request<Message>(`/api/v1/chat/messages/${id}`, {
        method: 'PATCH',
        body: { content, mentionIds: [] },
      }),
    remove: (id: string) => request(`/api/v1/chat/messages/${id}`, { method: 'DELETE' }),
    react: (id: string, emoji: string) =>
      request(`/api/v1/chat/messages/${id}/reaction`, { method: 'POST', body: { emoji } }),
    pin: (id: string) => request(`/api/v1/chat/messages/${id}/pin`, { method: 'POST' }),
    save: (id: string) => request(`/api/v1/chat/messages/${id}/save`, { method: 'POST' }),
    pins: (id: string) => request<Message[]>(`/api/v1/chat/channels/${id}/pins`),
    saved: () => request<Message[]>('/api/v1/chat/saved'),
    search: (query: string, channelId?: string) =>
      request<Message[]>('/api/v1/chat/search', { query: { query, channelId } }),
  };
}

export function useChatRealtime(channelId: Ref<string | null>, refresh: () => Promise<void>) {
  const { request } = useApi();
  let timer: ReturnType<typeof setInterval> | undefined;
  let realtime: import('ably').Realtime | undefined;
  let currentChannel: import('ably').RealtimeChannel | undefined;
  const mode = ref<'polling' | 'ably'>('polling');

  const subscribe = async (id: string | null) => {
    if (!realtime) return;
    if (currentChannel) {
      await currentChannel.unsubscribe();
      currentChannel = undefined;
    }
    if (!id) return;
    currentChannel = realtime.channels.get(`channel:${id}`);
    await currentChannel.subscribe(() => void refresh());
  };

  onMounted(async () => {
    timer = setInterval(() => {
      if (mode.value === 'polling' && channelId.value && !document.hidden) void refresh();
    }, 5000);

    try {
      const Ably = await import('ably');
      realtime = new Ably.Realtime({
        authCallback: async (_params, callback) => {
          try {
            const tokenRequest = await request<TokenRequest>('/api/ably-token');
            callback(null, tokenRequest);
          } catch (error) {
            callback(error as ErrorInfo, null);
          }
        },
      });
      realtime.connection.on('connected', () => {
        mode.value = 'ably';
      });
      realtime.connection.on(['disconnected', 'suspended', 'failed'], () => {
        mode.value = 'polling';
      });
      await subscribe(channelId.value);
    } catch {
      mode.value = 'polling';
    }
  });
  watch(channelId, (id) => void subscribe(id));
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    if (currentChannel) void currentChannel.unsubscribe();
    realtime?.close();
  });
  return { mode };
}
