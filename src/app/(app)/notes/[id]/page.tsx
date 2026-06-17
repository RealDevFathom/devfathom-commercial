import type { Metadata } from 'next';
import { NotesContent } from '../notes-content';

export const metadata: Metadata = {
  title: 'Note',
};

export default async function NoteDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <NotesContent selectedId={id} />;
}
