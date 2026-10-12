import type { Metadata } from 'next';
import { ApiDocsContent } from './api-docs-content';

export const metadata: Metadata = { title: 'API Documentation' };

export default function ApiDocsPage() {
  return <ApiDocsContent />;
}
