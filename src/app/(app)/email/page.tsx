import type { Metadata } from 'next';
import { EmailContent } from './email-content';

export const metadata: Metadata = { title: 'Email' };

export default function EmailPage() {
  return <EmailContent />;
}
