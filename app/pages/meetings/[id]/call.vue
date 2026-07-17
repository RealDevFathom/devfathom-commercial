<script setup lang="ts">
import { AlertTriangle, ArrowLeft, LoaderCircle, Video } from 'lucide-vue-next';
const route = useRoute();
const api = useMeetings();
const config = useRuntimeConfig();
const { token: accessToken } = useAuth();
const id = computed(() => String(route.params.id));
const meeting = await api.get(id.value);
useHead({ title: `Call · ${meeting.title}` });
const loading = ref(true);
const error = ref('');
const roomUrl = ref('');
let joined = false;

async function leaveCall(keepalive = false) {
  if (!joined) return;
  joined = false;
  if (!keepalive) {
    await api.callLeave(id.value).catch(() => undefined);
    return;
  }
  const base = String(config.public.apiBase || '').replace(/\/$/, '');
  fetch(`${base}/api/v1/meetings/${id.value}/call/leave`, {
    method: 'POST',
    keepalive: true,
    headers: accessToken.value ? { Authorization: `Bearer ${accessToken.value}` } : {},
  }).catch(() => undefined);
}

function handlePageHide() {
  void leaveCall(true);
}

onMounted(async () => {
  window.addEventListener('pagehide', handlePageHide);
  try {
    const token = await api.callToken(id.value);
    await api.callJoin(id.value);
    joined = true;
    roomUrl.value = `https://8x8.vc/${token.roomName}?jwt=${encodeURIComponent(token.jwt)}`;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The secure call room could not be opened.';
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', handlePageHide);
  void leaveCall();
});
</script>
<template>
  <section class="call-page">
    <header>
      <NuxtLink :to="`/meetings/${id}`" title="Back to meeting"><ArrowLeft :size="16" /></NuxtLink>
      <span class="video-icon"><Video :size="14" /></span>
      <h1>{{ meeting.title }}</h1>
    </header>
    <div v-if="loading" class="call-state">
      <LoaderCircle class="spin" :size="24" />
      <p>Connecting to the call…</p>
    </div>
    <div v-else-if="error" class="call-state">
      <span class="error-icon"><AlertTriangle :size="24" /></span>
      <p>{{ error }}</p>
      <NuxtLink class="return-button" :to="`/meetings/${id}`">Back to meetings</NuxtLink>
    </div>
    <iframe
      v-else
      :src="roomUrl"
      allow="camera; microphone; display-capture; autoplay; clipboard-write"
      title="Secure meeting room"
      referrerpolicy="no-referrer"
    />
  </section>
</template>
<style scoped>
.call-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--card);
  border: 0;
}
.call-page header {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 56px;
  flex: none;
  padding: 0 16px;
  color: var(--foreground);
  background: var(--card);
  border-bottom: 1px solid var(--border-subtle);
}
header a {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  margin-left: -4px;
  color: var(--text-muted);
  border-radius: 8px;
}
header a:hover {
  color: var(--foreground);
  background: var(--secondary);
}
.video-icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  border-radius: 6px;
}
header h1 {
  margin: 0;
  color: var(--foreground);
  font-size: 14px;
  font-weight: 650;
}
iframe {
  width: 100%;
  min-height: 0;
  flex: 1;
  border: 0;
}
.call-state {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--primary);
  text-align: center;
}
.call-state p {
  margin: 0;
  color: var(--text-muted);
  font-size: 14px;
}
.error-icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
  border-radius: 50%;
}
.return-button {
  margin-top: 2px;
  padding: 8px 16px;
  color: white;
  background: var(--primary);
  border-radius: 10px;
  font-size: 12px;
  font-weight: 650;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
