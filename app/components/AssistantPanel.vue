<script setup lang="ts">
import { Send, Sparkles, X } from 'lucide-vue-next';
const { open, messages, approvals, streaming, error, send, approve } = useAssistant();
const draft = ref('');
async function submit() {
  const value = draft.value;
  draft.value = '';
  await send(value);
}
</script>

<template>
  <Transition name="assistant">
    <aside v-if="open" class="assistant-panel" aria-label="DevFathom assistant">
      <header>
        <div><Sparkles :size="17" /><span>Workspace assistant</span></div>
        <button aria-label="Close assistant" @click="open = false"><X :size="18" /></button>
      </header>
      <div class="assistant-transcript" aria-live="polite">
        <div v-if="!messages.length" class="assistant-empty">
          <Sparkles :size="28" />
          <h2>Ask the firm desk</h2>
          <p>
            I can summarize workspace context. Changes still require the normal product controls.
          </p>
        </div>
        <article v-for="message in messages" :key="message.id" :class="message.role">
          <small>{{ message.role === 'user' ? 'You' : 'Assistant' }}</small>
          <p>{{ message.content || 'Thinking…' }}</p>
        </article>
        <article v-for="approval in approvals" :key="approval.approvalId" class="approval">
          <small>Explicit approval required</small>
          <p>Create task: {{ approval.arguments.title || 'Untitled task' }}</p>
          <button class="button" :disabled="streaming" @click="approve(approval)">
            Approve once
          </button>
        </article>
        <p v-if="error" class="assistant-error">{{ error }}</p>
      </div>
      <form @submit.prevent="submit">
        <textarea
          v-model="draft"
          rows="3"
          aria-label="Ask the assistant"
          placeholder="Ask about the workspace…"
          @keydown.ctrl.enter.prevent="submit"
        /><button class="button" :disabled="streaming || !draft.trim()"><Send :size="15" /></button>
      </form>
    </aside>
  </Transition>
</template>

<style scoped>
.assistant-panel {
  position: fixed;
  z-index: 50;
  top: 72px;
  right: 0;
  bottom: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: min(430px, 100vw);
  color: var(--text);
  background: var(--paper);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgba(32, 39, 32, 0.12);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 54px;
  padding: 0 16px;
  background: var(--linen);
  border-bottom: 1px solid var(--border);
}
header div {
  display: flex;
  gap: 8px;
  align-items: center;
  font:
    500 10px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.11em;
}
header button {
  color: var(--text);
  background: none;
  border: 0;
  cursor: pointer;
}
.assistant-transcript {
  overflow-y: auto;
  padding: 18px;
}
.assistant-empty {
  padding: 70px 30px;
  text-align: center;
}
.assistant-empty h2 {
  margin: 14px 0 8px;
}
.assistant-empty p {
  color: var(--muted);
  line-height: 1.5;
}
article {
  max-width: 88%;
  margin: 10px 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
}
article.user {
  margin-left: auto;
  background: var(--forest-900);
  color: white;
}
article.assistant {
  background: var(--linen);
}
article small {
  display: block;
  margin-bottom: 5px;
  opacity: 0.7;
  font:
    8px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
article p {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.55;
  font-size: 13px;
}
.assistant-error {
  color: var(--clay-500);
}
.approval {
  max-width: 100%;
  background: var(--clay-100);
  border-color: #ddb4a6;
}
.approval button {
  margin-top: 12px;
}
form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 14px;
  background: var(--linen);
  border-top: 1px solid var(--border);
}
textarea {
  resize: none;
  padding: 10px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
}
.assistant-enter-active,
.assistant-leave-active {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.assistant-enter-from,
.assistant-leave-to {
  transform: translateX(30px);
  opacity: 0;
}
</style>
