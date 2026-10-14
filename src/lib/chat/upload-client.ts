import type { SendAttachmentInput } from '@/lib/chat/contract';

/**
 * Upload a file to the app's upload endpoint and return an attachment input
 * shape ready to be passed to `chat.sendMessage({ attachments: [...] })`.
 *
 * Throws on network failure or a non-2xx response (message sourced from the
 * response body when available, falling back to the HTTP status text).
 */
export async function uploadAttachment(file: File): Promise<SendAttachmentInput> {
  const body = new FormData();
  body.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body,
  });

  if (!res.ok) {
    let message: string;
    try {
      const json = await res.json();
      message = json?.error ?? res.statusText;
    } catch {
      message = res.statusText;
    }
    throw new Error(`Upload failed: ${message}`);
  }

  const json = await res.json();

  return {
    name: json.name as string,
    url: json.url as string,
    type: (json.type as string) || null,
    size: (json.size as number) ?? null,
  };
}
