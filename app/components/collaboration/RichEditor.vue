<script setup lang="ts">
import { Bold, Heading2, Italic, List, Pilcrow } from 'lucide-vue-next';
import type { TiptapNode } from '~/types/collaboration';

const props = defineProps<{ modelValue: TiptapNode; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: TiptapNode] }>();
const editor = ref<HTMLElement | null>(null);

function plain(node?: TiptapNode): string {
  if (!node) return '';
  return node.text || (node.content || []).map(plain).join(node.type === 'paragraph' ? '' : '\n');
}

function hydrate() {
  if (editor.value && editor.value.innerText !== plain(props.modelValue)) {
    editor.value.innerText = plain(props.modelValue);
  }
}

function publish() {
  const lines = (editor.value?.innerText || '').split('\n');
  emit('update:modelValue', {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  });
}

function command(name: string, value?: string) {
  editor.value?.focus();
  document.execCommand(name, false, value);
  publish();
}

onMounted(hydrate);
watch(() => props.modelValue, hydrate, { deep: true });
</script>

<template>
  <div class="rich-editor" :class="{ readonly }">
    <div v-if="!readonly" class="toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" aria-label="Paragraph" @click="command('formatBlock', 'p')">
        <Pilcrow :size="16" />
      </button>
      <button type="button" aria-label="Heading" @click="command('formatBlock', 'h2')">
        <Heading2 :size="16" />
      </button>
      <button type="button" aria-label="Bold" @click="command('bold')"><Bold :size="16" /></button>
      <button type="button" aria-label="Italic" @click="command('italic')">
        <Italic :size="16" />
      </button>
      <button type="button" aria-label="Bulleted list" @click="command('insertUnorderedList')">
        <List :size="16" />
      </button>
    </div>
    <div
      ref="editor"
      class="editor-sheet"
      :contenteditable="!readonly"
      :aria-label="readonly ? 'Note content' : 'Note content editor'"
      role="textbox"
      aria-multiline="true"
      @input="publish"
    />
  </div>
</template>

<style scoped>
.rich-editor {
  border: 1px solid var(--border);
  background: var(--paper);
}
.toolbar {
  display: flex;
  gap: 4px;
  padding: 7px;
  border-bottom: 1px solid var(--border);
  background: var(--linen);
}
.toolbar button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 32px;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.toolbar button:hover,
.toolbar button:focus-visible {
  border-color: var(--border);
  background: var(--paper);
  outline: 0;
}
.editor-sheet {
  min-height: 360px;
  padding: 28px clamp(20px, 5vw, 64px);
  white-space: pre-wrap;
  line-height: 1.75;
  outline: none;
}
.editor-sheet:focus {
  box-shadow: inset 3px 0 var(--clay-500);
}
.readonly {
  border: 0;
}
.readonly .editor-sheet {
  padding: 16px 0;
}
</style>
