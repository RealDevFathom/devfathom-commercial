import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { GrowthMessage } from '@/lib/growth/view';

import { formatWhen } from './format';

const TONE: Record<GrowthMessage['status'], StatusTone> = {
  queued: 'warning',
  sent: 'info',
  delivered: 'info',
  read: 'success',
  failed: 'danger',
  received: 'success',
};

export function MessageLog({
  messages,
  empty = 'No messages yet. A test or a sent campaign shows up here.',
}: {
  messages: GrowthMessage[];
  empty?: string;
}) {
  if (!messages.length) return <p className="text-sm text-text-muted">{empty}</p>;
  return (
    <div className="min-w-0" data-testid="message-log">
      <Table className="min-w-[640px]">
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Direction</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.map((message) => (
            <TableRow key={message.id}>
              <TableCell className="whitespace-nowrap font-mono text-xs text-text-muted">
                {formatWhen(message.createdAt)}
              </TableCell>
              <TableCell>{message.direction === 'out' ? 'Out' : 'In'}</TableCell>
              <TableCell>
                <StatusPill status={message.status} tone={TONE[message.status]} />
              </TableCell>
              <TableCell className="max-w-md whitespace-normal">
                <p className="break-words text-sm text-text-body">{message.body}</p>
                {message.error ? (
                  <p className="mt-1 text-xs text-destructive">{message.error}</p>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
