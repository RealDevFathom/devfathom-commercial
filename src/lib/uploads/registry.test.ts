import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  claimUploadReference,
  registerUpload,
  uploadNameFromRef,
  UploadReferenceError,
} from './registry';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const uploadedFile = {
  create: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
};
const uploadedFileLegacyBinding = { findFirst: vi.fn() };
const db = { uploadedFile, uploadedFileLegacyBinding } as unknown as Pick<
  ScopedDb,
  'uploadedFile' | 'uploadedFileLegacyBinding'
>;
const OWNER = { type: 'PROJECT_FILE' as const, id: 'pf_new' };

beforeEach(() => {
  vi.resetAllMocks();
  uploadedFile.updateMany.mockResolvedValue({ count: 1 });
});

describe('uploadNameFromRef', () => {
  it.each([
    ['/api/files/abc-plan.pdf', 'abc-plan.pdf'],
    ['  /api/files/abc-plan.pdf ', 'abc-plan.pdf'],
    ['https://drive.example.com/contract.pdf', null],
    ['Licence held at head office', null],
    ['/api/files/', undefined],
    ['/api/files/../other/plan.pdf', undefined],
    ['/api/files/nested/plan.pdf', undefined],
    ['https://app.example.com/api/files/abc-plan.pdf', undefined],
    ['https://app.example.com/%61pi%2Ffiles/abc-plan.pdf', undefined],
  ])('%s -> %s', (ref, expected) => {
    expect(uploadNameFromRef(ref)).toBe(expected);
  });
});

describe('registerUpload', () => {
  it('records the uploader the server saw, unbound', async () => {
    await registerUpload(db, { name: 'u1-plan.pdf', uploadedById: 'user_a' });
    expect(uploadedFile.create).toHaveBeenCalledWith({
      data: { name: 'u1-plan.pdf', uploadedById: 'user_a' },
      select: { id: true },
    });
  });
});

describe('claimUploadReference', () => {
  const claim = (ref: string | null | undefined, userId = 'user_a') =>
    claimUploadReference(db, { ref, userId, owner: OWNER });

  it('binds the caller own unattached upload to the record', async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: 'user_a',
      ownerType: null,
      ownerId: null,
    });
    await expect(claim('/api/files/u1-plan.pdf')).resolves.toBeUndefined();
    expect(uploadedFile.findFirst).toHaveBeenCalledWith({
      where: { name: 'u1-plan.pdf' },
      select: { id: true, uploadedById: true, ownerType: true, ownerId: true },
    });
    expect(uploadedFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'upl_1', ownerType: null },
      data: { ownerType: 'PROJECT_FILE', ownerId: 'pf_new', boundAt: expect.any(Date) },
    });
  });

  it("refuses someone else's unattached upload and binds nothing", async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: 'user_victim',
      ownerType: null,
      ownerId: null,
    });
    await expect(claim('/api/files/logo.png')).rejects.toBeInstanceOf(UploadReferenceError);
    expect(uploadedFile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an upload already bound to another record and leaves it bound', async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: 'user_a',
      ownerType: 'CONTRACT',
      ownerId: 'contract_9',
    });
    await expect(claim('/api/files/contract.pdf')).rejects.toBeInstanceOf(UploadReferenceError);
    expect(uploadedFile.updateMany).not.toHaveBeenCalled();
  });

  it('accepts a re-save through a binding grandfathered to this record', async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: null,
      ownerType: 'TASK_ATTACHMENT',
      ownerId: 'ta_earlier',
    });
    uploadedFileLegacyBinding.findFirst.mockResolvedValue({ id: 'uflb_1' });
    await expect(claim('/api/files/shared.pdf')).resolves.toBeUndefined();
    expect(uploadedFileLegacyBinding.findFirst).toHaveBeenCalledWith({
      where: { name: 'shared.pdf', ownerType: 'PROJECT_FILE', ownerId: 'pf_new' },
      select: { id: true },
    });
    expect(uploadedFile.updateMany).not.toHaveBeenCalled();
  });

  it('accepts a re-save of the upload already bound to this record', async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: 'user_other',
      ownerType: 'PROJECT_FILE',
      ownerId: 'pf_new',
    });
    await expect(claim('/api/files/plan.pdf')).resolves.toBeUndefined();
    expect(uploadedFile.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown upload', null],
    ['a legacy registration with no recorded uploader', { uploadedById: null }],
  ])('refuses %s', async (_label, row) => {
    uploadedFile.findFirst.mockResolvedValue(
      row && { id: 'upl_1', ownerType: null, ownerId: null, ...row }
    );
    await expect(claim('/api/files/x.pdf')).rejects.toBeInstanceOf(UploadReferenceError);
    expect(uploadedFile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a malformed file reference before any lookup', async () => {
    await expect(claim('/api/files/../x.pdf')).rejects.toBeInstanceOf(UploadReferenceError);
    expect(uploadedFile.findFirst).not.toHaveBeenCalled();
  });

  it('refuses when another attach won the race for the same upload', async () => {
    uploadedFile.findFirst.mockResolvedValue({
      id: 'upl_1',
      uploadedById: 'user_a',
      ownerType: null,
      ownerId: null,
    });
    uploadedFile.updateMany.mockResolvedValue({ count: 0 });
    await expect(claim('/api/files/u1-plan.pdf')).rejects.toBeInstanceOf(UploadReferenceError);
  });

  it.each([undefined, null, '', 'https://drive.example.com/contract.pdf'])(
    'leaves a reference that is not a workspace upload (%s) alone',
    async (ref) => {
      await expect(claim(ref)).resolves.toBeUndefined();
      expect(uploadedFile.findFirst).not.toHaveBeenCalled();
      expect(uploadedFile.updateMany).not.toHaveBeenCalled();
    }
  );
});
