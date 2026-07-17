export interface UploadedFile {
  url: string;
  name: string;
  size: number;
  type: string;
}

export function useUploads() {
  const { request } = useApi();

  const upload = (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<UploadedFile>('/api/upload', { method: 'POST', body });
  };

  return { upload };
}
