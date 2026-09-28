// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const storage = vi.hoisted(() => ({
  putUpload: vi.fn(),
  getUpload: vi.fn(),
  objects: new Map<string, Buffer>(),
}));
vi.mock('@/lib/storage', () => storage);

import {
  loadPrescriptionFile,
  MAX_PRESCRIPTION_FILE_BYTES,
  persistPrescriptionFile,
  prescriptionFileId,
  prescriptionFileRefSchema,
  prescriptionUploadSchema,
} from './prescription-files';

async function uploadInput(format: 'png' | 'jpeg' | 'webp' = 'png') {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
    .toFormat(format)
    .toBuffer();
  return {
    patientId: 'patient-a',
    contentType: `image/${format}` as 'image/png' | 'image/jpeg' | 'image/webp',
    dataBase64: bytes.toString('base64'),
  };
}

describe('private prescription file persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.objects.clear();
    storage.putUpload.mockImplementation(async (org, name, bytes) => {
      storage.objects.set(`${org}/${name}`, bytes);
    });
    storage.getUpload.mockImplementation(async (org, name) => {
      const bytes = storage.objects.get(`${org}/${name}`);
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return bytes;
    });
  });

  it.each(['png', 'jpeg', 'webp'] as const)(
    'persists and reads validated %s bytes with patient/tenant binding',
    async (format) => {
      const input = await uploadInput(format);
      const receipt = await persistPrescriptionFile('org-a', 'user-a', input);
      const read = await loadPrescriptionFile('org-a', receipt.sourceFileRef);
      expect(read.bytes.toString('base64')).toBe(input.dataBase64);
      expect(read).toMatchObject({
        patientId: 'patient-a',
        organizationId: 'org-a',
        uploadedByUserId: 'user-a',
        contentType: input.contentType,
      });
      expect(receipt).toEqual({
        sourceFileRef: receipt.url,
        url: expect.stringMatching(/^\/api\/pharmacy\/prescription-files\?id=/),
        size: read.bytes.length,
        contentType: input.contentType,
      });
      expect(storage.putUpload).toHaveBeenCalledWith(
        'org-a/pharmacy-prescriptions',
        `${read.id}.json`,
        expect.any(Buffer),
        'application/json'
      );
      expect(receipt.url).not.toContain('patient-a');
    }
  );

  it('does not return success before storage settles', async () => {
    let release!: () => void;
    storage.putUpload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = persistPrescriptionFile('org-a', 'user-a', await uploadInput()).then(
      (value) => {
        settled = true;
        return value;
      }
    );
    await vi.waitFor(() => expect(storage.putUpload).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects storage failure without leaking provider details', async () => {
    storage.putUpload.mockRejectedValue(new Error('sensitive provider payload'));
    await expect(
      persistPrescriptionFile('org-a', 'user-a', await uploadInput())
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Prescription upload failed. Retry the upload.',
    });
  });

  it.each([
    'capture://rx.png',
    '/api/files/foreign.png',
    'https://example.test/rx.png',
    '/api/pharmacy/prescription-files?id=../secret',
    '/api/pharmacy/prescription-files?id=%2e%2e%2fsecret',
  ])('rejects noncanonical reference %s before storage', async (reference) => {
    expect(prescriptionFileRefSchema.safeParse(reference).success).toBe(false);
    await expect(loadPrescriptionFile('org-a', reference)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(storage.getUpload).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant references and metadata copied into a foreign namespace', async () => {
    const receipt = await persistPrescriptionFile('org-a', 'user-a', await uploadInput());
    await expect(loadPrescriptionFile('org-b', receipt.url)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    storage.getUpload.mockResolvedValue([...storage.objects.values()][0]);
    await expect(loadPrescriptionFile('org-b', receipt.url)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.each(['id', 'dataBase64', 'sha256'])('rejects corrupted file identity: %s', async (field) => {
    const receipt = await persistPrescriptionFile('org-a', 'user-a', await uploadInput());
    const stored = JSON.parse([...storage.objects.values()][0].toString());
    stored[field] = 'corrupted';
    storage.getUpload.mockResolvedValue(Buffer.from(JSON.stringify(stored)));
    await expect(loadPrescriptionFile('org-a', receipt.url)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports transient read failures as retryable storage errors', async () => {
    const receipt = await persistPrescriptionFile('org-a', 'user-a', await uploadInput());
    storage.getUpload.mockRejectedValue(new Error('provider credential details'));
    await expect(loadPrescriptionFile('org-a', receipt.url)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Prescription storage unavailable. Retry later.',
    });
  });

  it('rejects MIME spoofing, truncated images, empty/invalid base64 and excessive size', async () => {
    const input = await uploadInput();
    for (const invalid of [
      { ...input, contentType: 'image/jpeg' as const },
      {
        ...input,
        dataBase64: Buffer.from(input.dataBase64, 'base64').subarray(0, 30).toString('base64'),
      },
      { ...input, dataBase64: '' },
      { ...input, dataBase64: 'data:image/png;base64,' + input.dataBase64 },
      { ...input, dataBase64: Buffer.alloc(MAX_PRESCRIPTION_FILE_BYTES + 1).toString('base64') },
    ])
      await expect(persistPrescriptionFile('org-a', 'user-a', invalid)).rejects.toBeDefined();
    expect(
      prescriptionUploadSchema.safeParse({ ...input, contentType: 'image/svg+xml' }).success
    ).toBe(false);
    expect(storage.putUpload).not.toHaveBeenCalled();
  });

  it('rejects decompression-sized images using the pixel limit', async () => {
    const bytes = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(
      persistPrescriptionFile('org-a', 'user-a', {
        patientId: 'patient-a',
        contentType: 'image/png',
        dataBase64: bytes.toString('base64'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(storage.putUpload).not.toHaveBeenCalled();
  });

  it('concurrent uploads get distinct identities without overwriting', async () => {
    const input = await uploadInput();
    const receipts = await Promise.all([
      persistPrescriptionFile('org-a', 'user-a', input),
      persistPrescriptionFile('org-a', 'user-a', input),
    ]);
    expect(new Set(receipts.map((receipt) => prescriptionFileId(receipt.url))).size).toBe(2);
    expect(storage.objects.size).toBe(2);
  });
});
