import { type ComponentProps } from 'react';
import { ReactRenderer } from '@tiptap/react';
import { Mention, type MentionNodeAttrs } from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import type { ChatUserLite } from '@/lib/chat/contract';
import { MENTION_NODE } from '@/lib/chat/tiptap';
import { MentionList, type MentionListHandle } from './mention-list';

/**
 * Dedicated plugin key for the chat @-mention suggestion. Exporting it lets the
 * composer ask "is the mention popup currently open?" before deciding whether
 * Enter should submit the message or pick a mention.
 */
export const ChatMentionPluginKey = new PluginKey('chatMention');

// The bundled Mention extension is already named `mention` (= MENTION_NODE),
// which the server relies on to flatten plaintext + extract mention ids. Assert
// it once so a future TipTap rename fails loudly here instead of silently
// breaking attribution downstream.
if (Mention.name !== MENTION_NODE) {
  console.warn(
    `[chat] Mention node name "${Mention.name}" does not match MENTION_NODE "${MENTION_NODE}".`
  );
}

export interface CreateMentionExtensionOptions {
  /** Channel whose roster powers the autocomplete. */
  channelId: string;
  /** Resolve mention candidates — the composer wires this to `chat.getMentionTargets`. */
  getMentionTargets: (channelId: string, query: string) => Promise<ChatUserLite[]>;
}

/**
 * Configure `@tiptap/extension-mention` for chat. The node name stays `mention`
 * (= `MENTION_NODE`) so `tiptapToPlainText` / `extractMentionIds` on the server
 * recognise it. Attributes stored: `{ id, label }` (+ the extension's own
 * `mentionSuggestionChar`). Renders as an inline primary-tinted chip.
 *
 * The render()/ReactRenderer popup wiring mirrors note-link-extension.ts.
 */
export function createMentionExtension({
  channelId,
  getMentionTargets,
}: CreateMentionExtensionOptions) {
  return Mention.configure({
    // Inline chip — primary tint (brass is too loud for an in-flow mention).
    HTMLAttributes: { class: 'rounded bg-primary/10 px-1 text-primary font-medium' },
    suggestion: {
      char: '@',
      pluginKey: ChatMentionPluginKey,
      items: async ({ query }) => {
        try {
          return await getMentionTargets(channelId, query);
        } catch {
          return [];
        }
      },
      render: () => {
        let component: ReactRenderer<MentionListHandle, ComponentProps<typeof MentionList>> | null =
          null;
        let popup: HTMLDivElement | null = null;

        // Anchor the popup to the caret. The composer usually lives at the
        // bottom of the screen, so flip the popup above the caret when there
        // isn't enough room below.
        const positionPopup = (rect: DOMRect | null) => {
          if (!popup || !rect) return;
          const popupHeight = popup.offsetHeight || 288;
          const spaceBelow = window.innerHeight - rect.bottom;
          popup.style.left = `${Math.round(rect.left)}px`;
          popup.style.top =
            spaceBelow < popupHeight + 12
              ? `${Math.max(8, Math.round(rect.top - popupHeight - 6))}px`
              : `${Math.round(rect.bottom + 6)}px`;
        };

        const teardown = () => {
          popup?.remove();
          popup = null;
          component?.destroy();
          component = null;
        };

        return {
          onStart: (props) => {
            popup = document.createElement('div');
            popup.style.position = 'fixed';
            popup.style.zIndex = '9999';
            document.body.appendChild(popup);

            component = new ReactRenderer<MentionListHandle, ComponentProps<typeof MentionList>>(
              MentionList,
              {
                props: {
                  items: props.items as ChatUserLite[],
                  query: props.query,
                  // props.command runs the Mention extension's own insert command
                  // (creates a `mention` node with these attrs + a trailing space).
                  command: (item: ChatUserLite) =>
                    props.command({ id: item.id, label: item.name } as MentionNodeAttrs),
                },
                editor: props.editor,
              }
            );

            popup.appendChild(component.element);
            positionPopup(props.clientRect?.() ?? null);
          },
          onUpdate: (props) => {
            component?.updateProps({
              items: props.items as ChatUserLite[],
              query: props.query,
              command: (item: ChatUserLite) =>
                props.command({ id: item.id, label: item.name } as MentionNodeAttrs),
            });
            positionPopup(props.clientRect?.() ?? null);
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              teardown();
              return true;
            }
            return component?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit: () => {
            teardown();
          },
        };
      },
    },
  });
}
