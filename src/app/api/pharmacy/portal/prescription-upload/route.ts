import { portalContext, portalResponse } from '@/lib/pharmacy/customer-portal-http';
import { MAX_PRESCRIPTION_FILE_BYTES } from '@/lib/pharmacy/prescription-files';
import { uploadPost } from '@/lib/uploads/multipart-request';

export const runtime = 'nodejs';

export const POST = uploadPost(async (request, readUploadForm) => {
  const context = await portalContext(request);
  if (!context) return portalResponse.notFound();
  return context.uploadPrescription((customerId, organizationId) =>
    readUploadForm(customerId, organizationId, 'text', MAX_PRESCRIPTION_FILE_BYTES)
  );
});

export {
  uploadMethodResponse as GET,
  uploadMethodResponse as HEAD,
  uploadMethodResponse as PUT,
  uploadMethodResponse as PATCH,
  uploadMethodResponse as DELETE,
  uploadMethodResponse as OPTIONS,
} from '@/lib/uploads/multipart-request';
