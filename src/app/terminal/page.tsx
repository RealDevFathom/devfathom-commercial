import type { Metadata } from 'next';

import { TerminalConsole } from '@/components/terminal/terminal-console';

export const metadata: Metadata = {
  title: 'Restaurant terminal',
  description: 'Device-authenticated restaurant terminal operations.',
};

export default function TerminalPage() {
  return <TerminalConsole />;
}
