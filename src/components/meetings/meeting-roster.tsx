'use client';

import { Users } from 'lucide-react';

export function MeetingRoster({ participants }: { participants: string[] }) {
  return (
    <aside
      className="rounded-lg border border-border bg-surface-card p-4"
      aria-label="Participant roster"
    >
      <div className="mb-4 flex items-center gap-2">
        <Users aria-hidden className="size-4" />
        <h2 className="font-display text-sm font-semibold">People</h2>
        <span className="ml-auto font-mono text-xs text-text-muted">{participants.length}</span>
      </div>
      {participants.length ? (
        <ul className="space-y-2">
          {participants.map((name, index) => (
            <li
              key={`${name}-${index}`}
              className="flex min-h-11 items-center gap-3 rounded-sm border border-border px-3 text-sm"
            >
              <span aria-hidden className="size-2 rounded-full bg-success" />
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted">No one else is here yet.</p>
      )}
    </aside>
  );
}
