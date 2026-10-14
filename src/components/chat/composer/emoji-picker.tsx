'use client';

import React, { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';

interface EmojiEntry {
  /** The emoji glyph. */
  e: string;
  /** Space-separated search keywords. */
  k: string;
}
interface EmojiGroup {
  name: string;
  emojis: EmojiEntry[];
}

// A hand-curated set (~140) grouped into a few familiar categories. Keywords
// power the search box. Kept inline so the picker is fully self-contained.
const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: 'Smileys',
    emojis: [
      { e: '😀', k: 'grin happy smile' },
      { e: '😁', k: 'beaming grin smile' },
      { e: '😂', k: 'joy laugh tears lol' },
      { e: '🤣', k: 'rofl rolling laugh' },
      { e: '😊', k: 'blush smile happy' },
      { e: '😇', k: 'innocent angel halo' },
      { e: '🙂', k: 'slight smile' },
      { e: '🙃', k: 'upside down silly' },
      { e: '😉', k: 'wink' },
      { e: '😍', k: 'heart eyes love' },
      { e: '😘', k: 'kiss blow love' },
      { e: '😋', k: 'yum tasty tongue' },
      { e: '😎', k: 'cool sunglasses' },
      { e: '🤩', k: 'star struck excited wow' },
      { e: '🥳', k: 'party celebrate hat' },
      { e: '🤔', k: 'thinking hmm' },
      { e: '🤨', k: 'raised eyebrow skeptical' },
      { e: '😐', k: 'neutral meh' },
      { e: '😴', k: 'sleep tired zzz' },
      { e: '😭', k: 'sob cry tears sad' },
      { e: '😅', k: 'sweat smile nervous' },
      { e: '😬', k: 'grimace awkward' },
      { e: '🙄', k: 'eye roll annoyed' },
      { e: '😏', k: 'smirk' },
      { e: '😡', k: 'angry mad rage' },
      { e: '🥲', k: 'smiling tear' },
      { e: '🤯', k: 'mind blown explode' },
      { e: '🥺', k: 'pleading puppy eyes' },
    ],
  },
  {
    name: 'Gestures & People',
    emojis: [
      { e: '👍', k: 'thumbs up like yes approve' },
      { e: '👎', k: 'thumbs down dislike no' },
      { e: '👏', k: 'clap applause bravo' },
      { e: '🙌', k: 'raised hands praise hooray' },
      { e: '🙏', k: 'pray thanks please' },
      { e: '👋', k: 'wave hi hello bye' },
      { e: '🤝', k: 'handshake deal agree' },
      { e: '💪', k: 'muscle strong flex' },
      { e: '✌️', k: 'peace victory' },
      { e: '🤞', k: 'fingers crossed luck hope' },
      { e: '👌', k: 'ok perfect okay' },
      { e: '🤙', k: 'call me shaka' },
      { e: '👀', k: 'eyes look watch' },
      { e: '🫡', k: 'salute respect yes sir' },
      { e: '🫶', k: 'heart hands love' },
      { e: '🤦', k: 'facepalm' },
      { e: '🤷', k: 'shrug dunno idk' },
      { e: '🧠', k: 'brain smart mind' },
    ],
  },
  {
    name: 'Hearts',
    emojis: [
      { e: '❤️', k: 'red heart love' },
      { e: '🧡', k: 'orange heart' },
      { e: '💛', k: 'yellow heart' },
      { e: '💚', k: 'green heart' },
      { e: '💙', k: 'blue heart' },
      { e: '💜', k: 'purple heart' },
      { e: '🖤', k: 'black heart' },
      { e: '🤍', k: 'white heart' },
      { e: '💔', k: 'broken heart sad' },
      { e: '❤️‍🔥', k: 'heart fire burning' },
      { e: '💖', k: 'sparkling heart' },
      { e: '💯', k: 'hundred perfect score' },
    ],
  },
  {
    name: 'Animals & Nature',
    emojis: [
      { e: '🐶', k: 'dog puppy' },
      { e: '🐱', k: 'cat kitten' },
      { e: '🦊', k: 'fox' },
      { e: '🐻', k: 'bear' },
      { e: '🐼', k: 'panda' },
      { e: '🐨', k: 'koala' },
      { e: '🦁', k: 'lion' },
      { e: '🐯', k: 'tiger' },
      { e: '🦄', k: 'unicorn' },
      { e: '🐝', k: 'bee' },
      { e: '🦋', k: 'butterfly' },
      { e: '🐢', k: 'turtle' },
      { e: '🐙', k: 'octopus' },
      { e: '🌸', k: 'blossom flower' },
      { e: '🌳', k: 'tree' },
      { e: '🌵', k: 'cactus' },
      { e: '🍀', k: 'clover luck' },
      { e: '🌈', k: 'rainbow' },
    ],
  },
  {
    name: 'Food',
    emojis: [
      { e: '🍎', k: 'apple fruit' },
      { e: '🍌', k: 'banana' },
      { e: '🍓', k: 'strawberry' },
      { e: '🍕', k: 'pizza' },
      { e: '🍔', k: 'burger hamburger' },
      { e: '🍟', k: 'fries' },
      { e: '🌮', k: 'taco' },
      { e: '🍣', k: 'sushi' },
      { e: '🍜', k: 'ramen noodles' },
      { e: '🍩', k: 'donut' },
      { e: '🍪', k: 'cookie' },
      { e: '🎂', k: 'cake birthday' },
      { e: '🍫', k: 'chocolate' },
      { e: '☕', k: 'coffee' },
      { e: '🍵', k: 'tea matcha' },
      { e: '🍺', k: 'beer' },
      { e: '🍷', k: 'wine' },
      { e: '🥑', k: 'avocado' },
    ],
  },
  {
    name: 'Activity',
    emojis: [
      { e: '⚽', k: 'soccer football' },
      { e: '🏀', k: 'basketball' },
      { e: '🏈', k: 'football' },
      { e: '🎾', k: 'tennis' },
      { e: '🎯', k: 'dart target bullseye' },
      { e: '🎮', k: 'game controller' },
      { e: '🎲', k: 'dice' },
      { e: '🎸', k: 'guitar music' },
      { e: '🎧', k: 'headphones music' },
      { e: '🏆', k: 'trophy win' },
      { e: '🥇', k: 'gold medal first' },
      { e: '🚀', k: 'rocket launch ship' },
      { e: '🎉', k: 'party tada celebrate' },
      { e: '🎈', k: 'balloon' },
    ],
  },
  {
    name: 'Objects',
    emojis: [
      { e: '💻', k: 'laptop computer code' },
      { e: '🖥️', k: 'desktop monitor' },
      { e: '📱', k: 'phone mobile' },
      { e: '⌨️', k: 'keyboard' },
      { e: '🖱️', k: 'mouse' },
      { e: '💾', k: 'floppy save disk' },
      { e: '📅', k: 'calendar date' },
      { e: '📌', k: 'pin pushpin' },
      { e: '📎', k: 'paperclip attach' },
      { e: '✏️', k: 'pencil write' },
      { e: '📝', k: 'memo note' },
      { e: '📖', k: 'book read' },
      { e: '💡', k: 'bulb idea' },
      { e: '🔑', k: 'key' },
      { e: '🔒', k: 'lock secure' },
      { e: '🔔', k: 'bell notification' },
    ],
  },
  {
    name: 'Symbols',
    emojis: [
      { e: '✅', k: 'check done complete' },
      { e: '❌', k: 'cross wrong no' },
      { e: '⚠️', k: 'warning caution' },
      { e: '❓', k: 'question' },
      { e: '❗', k: 'exclamation important' },
      { e: '⭐', k: 'star favorite' },
      { e: '🔥', k: 'fire hot lit' },
      { e: '✨', k: 'sparkles shiny new' },
      { e: '🎊', k: 'confetti party' },
      { e: '💢', k: 'anger' },
      { e: '💤', k: 'sleep zzz' },
      { e: '➕', k: 'plus add' },
      { e: '➖', k: 'minus' },
      { e: '♻️', k: 'recycle' },
      { e: '🔗', k: 'link chain' },
      { e: '🆗', k: 'ok button' },
    ],
  },
];

const GRID_COLS = 8;

function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const { key } = e;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown')
    return;
  e.preventDefault();
  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (idx === -1) return;
  let next = idx;
  if (key === 'ArrowRight') next = Math.min(idx + 1, buttons.length - 1);
  else if (key === 'ArrowLeft') next = Math.max(idx - 1, 0);
  else if (key === 'ArrowDown') next = Math.min(idx + GRID_COLS, buttons.length - 1);
  else if (key === 'ArrowUp') next = Math.max(idx - GRID_COLS, 0);
  buttons[next]?.focus();
}

/**
 * Emoji picker rendered inside a Popover. The trigger is `children` when
 * provided, otherwise a default Smile icon button. Clicking an emoji calls
 * `onPick` and closes the popover.
 */
export function EmojiPicker({
  onPick,
  children,
}: {
  onPick: (emoji: string) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    return EMOJI_GROUPS.flatMap((g) => g.emojis).filter(
      (it) => it.k.includes(q) || it.e === query.trim()
    );
  }, [q, query]);

  const pick = (emoji: string) => {
    onPick(emoji);
    setOpen(false);
    setQuery('');
  };

  const renderEmoji = (it: EmojiEntry, i: number) => (
    <button
      key={it.e + i}
      type="button"
      role="gridcell"
      title={it.k}
      aria-label={it.k}
      onClick={() => pick(it.e)}
      className="flex size-7 items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-secondary"
    >
      <span aria-hidden>{it.e}</span>
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      {children ? (
        <PopoverTrigger render={children as ReactElement} />
      ) : (
        <PopoverTrigger
          aria-label="Add emoji"
          className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Smile className="size-4" />
        </PopoverTrigger>
      )}

      <PopoverContent align="start" sideOffset={8} className="w-72 gap-0 p-0">
        <div className="border-b border-border/60 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            className="h-8"
          />
        </div>
        <ScrollArea className="h-64">
          <div className="p-2">
            {matches ? (
              matches.length > 0 ? (
                <div
                  role="grid"
                  aria-label="Search results"
                  className="grid grid-cols-8 gap-0.5"
                  onKeyDown={handleGridKeyDown}
                >
                  {matches.map(renderEmoji)}
                </div>
              ) : (
                <p className="px-1 py-8 text-center text-xs text-muted-foreground">
                  No emoji found
                </p>
              )
            ) : (
              EMOJI_GROUPS.map((group) => (
                <div key={group.name} className="mb-1.5 last:mb-0">
                  <p className="px-1 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {group.name}
                  </p>
                  <div
                    role="grid"
                    aria-label={group.name}
                    className="grid grid-cols-8 gap-0.5"
                    onKeyDown={handleGridKeyDown}
                  >
                    {group.emojis.map(renderEmoji)}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
