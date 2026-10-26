import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/lib/pharmacy/supplier-action-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/supplier-action-links')>();
  return {
    ...actual,
    getSupplierLinkAuditTarget: vi.fn(),
    submitSupplierEvidence: vi.fn(),
    uploadSupplierDocument: vi.fn(),
  };
});

import { recordAudit } from '@/server/audit';
import {
  SupplierLinkError,
  getSupplierLinkAuditTarget,
  submitSupplierEvidence,
  uploadSupplierDocument,
} from '@/lib/pharmacy/supplier-action-links';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';

const target = { id: 'link_a', organizationId: 'org_a', branchId: 'branch_a' };
const context = {
  db: {},
  entitlements: { organizationId: 'org_a' },
  requestMeta: { ip: '192.0.2.1', userAgent: 'supplier-browser' },
};

describe('pharmacy supplier signed-link auditing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue(target as never);
  });

  it('audits a successful supplier response with its tenant, branch, link, and outcome', async () => {
    vi.mocked(submitSupplierEvidence).mockResolvedValue({ id: 'submission_a' } as never);

    await pharmacySupplierLinksRouter.createCaller(context as never).submit({
      token: 'link.secret.signature',
      kind: 'ACKNOWLEDGEMENT',
      idempotencyKey: 'idem_a',
      payload: {},
    });

    expect(getSupplierLinkAuditTarget).toHaveBeenCalledWith(
      context.db,
      'link.secret.signature',
      'org_a'
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.submit',
        targetId: 'link_a',
        outcome: 'SUCCESS',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'ACKNOWLEDGEMENT' },
      })
    );
  });

  it('audits a rejected supplier response and preserves the public error mapping', async () => {
    vi.mocked(submitSupplierEvidence).mockRejectedValue(
      new SupplierLinkError('IDEMPOTENCY_CONFLICT')
    );

    await expect(
      pharmacySupplierLinksRouter.createCaller(context as never).submit({
        token: 'link.secret.signature',
        kind: 'REJECTION',
        idempotencyKey: 'idem_rejection',
        payload: {},
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'IDEMPOTENCY_CONFLICT' });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.submit',
        targetId: 'link_a',
        outcome: 'FAILURE',
        errorCode: 'IDEMPOTENCY_CONFLICT',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'REJECTION' },
      })
    );
  });

  it('audits a successful document upload', async () => {
    vi.mocked(uploadSupplierDocument).mockResolvedValue({ id: 'document_a' } as never);

    await pharmacySupplierLinksRouter.createCaller(context as never).uploadDocument({
      token: 'link.secret.signature',
      idempotencyKey: 'idem_document_success',
      fileName: 'invoice.pdf',
      declaredMimeType: 'application/pdf',
      contentBase64: 'JVBERg==',
    });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.uploadDocument',
        targetId: 'link_a',
        outcome: 'SUCCESS',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'DOCUMENT' },
      })
    );
  });

  it('audits a rejected document upload and preserves the public error mapping', async () => {
    vi.mocked(uploadSupplierDocument).mockRejectedValue(new SupplierLinkError('INVALID_UPLOAD'));

    await expect(
      pharmacySupplierLinksRouter.createCaller(context as never).uploadDocument({
        token: 'link.secret.signature',
        idempotencyKey: 'idem_document',
        fileName: 'invoice.pdf',
        declaredMimeType: 'application/pdf',
        contentBase64: 'JVBERg==',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_UPLOAD' });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.uploadDocument',
        targetId: 'link_a',
        outcome: 'FAILURE',
        errorCode: 'INVALID_UPLOAD',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'DOCUMENT' },
      })
    );
  });

  it('audits submit input validation failures attributable to a signed link', async () => {
    await expect(
      pharmacySupplierLinksRouter.createCaller(context as never).submit({
        token: 'link.secret.signature',
        kind: 'UNSUPPORTED',
        idempotencyKey: '',
        payload: {},
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(submitSupplierEvidence).not.toHaveBeenCalled();
    expect(getSupplierLinkAuditTarget).toHaveBeenCalledWith(
      context.db,
      'link.secret.signature',
      'org_a'
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.submit',
        targetId: 'link_a',
        outcome: 'FAILURE',
        errorCode: 'BAD_REQUEST',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'UNSUPPORTED' },
      })
    );
  });

  it('audits document input validation failures attributable to a signed link', async () => {
    await expect(
      pharmacySupplierLinksRouter.createCaller(context as never).uploadDocument({
        token: 'link.secret.signature',
        idempotencyKey: 'idem_document',
        fileName: '',
        declaredMimeType: 'text/plain',
        contentBase64: '',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(uploadSupplierDocument).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        action: 'pharmacySupplierLinks.uploadDocument',
        targetId: 'link_a',
        outcome: 'FAILURE',
        errorCode: 'BAD_REQUEST',
        metadata: { branchId: 'branch_a', linkId: 'link_a', kind: 'DOCUMENT' },
      })
    );
  });

  it('does not attribute an unresolvable or cross-tenant link to the current tenant', async () => {
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue(null);
    vi.mocked(submitSupplierEvidence).mockRejectedValue(new SupplierLinkError('INVALID_LINK'));

    await expect(
      pharmacySupplierLinksRouter.createCaller(context as never).submit({
        token: 'unknown.secret.signature',
        kind: 'REJECTION',
        idempotencyKey: 'idem_unknown',
        payload: {},
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(recordAudit).not.toHaveBeenCalled();
  });
});
