import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Restaurant terminal',
  description: 'Device-authenticated restaurant terminal operations.',
};

export default function TerminalPage() {
  redirect('/pos');
}
