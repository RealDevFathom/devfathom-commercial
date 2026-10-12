import type { Metadata } from 'next';
import { TrelloImportContent } from './trello-import-content';

export const metadata: Metadata = {
  title: 'Import from Trello',
};

export default function TrelloImportPage() {
  return <TrelloImportContent />;
}
