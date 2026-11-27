import 'server-only';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import type { UniversityContext } from './office-types';
import { PortalError, portalHash } from './portal';

export const PART_BYTES = 256 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
type DocumentRow = {
  id: string;
  person_id: string;
  byte_size: number;
  file_hash: string;
  complete: boolean;
  mime: string;
  filename: string;
};
const uploadSchema = z.object({
  label: z.enum(['Identity', 'Qualification', 'Equivalence', 'Supporting evidence']),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[^/\\\x00-\x1F\x7F]+$/),
  mime: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  size: z.number().int().min(1).max(MAX_BYTES),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export async function beginDocument(ctx: UniversityContext, input: unknown) {
  const doc = uploadSchema.parse(input);
  const { db, organizationId: org, userId: person } = ctx;
  await db.$queryRaw`SELECT id FROM university_people WHERE organization_id=${org} AND id=${person} FOR UPDATE`;
  let [row] = await db.$queryRaw<
    DocumentRow[]
  >`SELECT * FROM university_documents WHERE organization_id=${org} AND person_id=${person} AND file_hash=${doc.hash} AND label=${doc.label}`;
  if (!row) {
    const [count] = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM university_documents WHERE organization_id=${org} AND person_id=${person}`;
    if (count.n >= 20)
      throw new PortalError(409, 'Your document allowance is full. Contact admissions.');
    [row] = await db.$queryRaw<
      DocumentRow[]
    >`INSERT INTO university_documents(organization_id,person_id,label,filename,mime,byte_size,file_hash) VALUES(${org},${person},${doc.label},${doc.filename},${doc.mime},${doc.size},${doc.hash}) RETURNING *`;
  }
  if (row.byte_size !== doc.size || row.mime !== doc.mime)
    throw new PortalError(409, 'File metadata changed. Choose the original file.');
  const parts = await db.$queryRaw<
    { part: number }[]
  >`SELECT part FROM university_document_parts WHERE organization_id=${org} AND document_id=${row.id} ORDER BY part`;
  return { id: row.id, received: parts.map((p) => p.part), complete: row.complete };
}
async function ownedDocument(ctx: UniversityContext, id: string) {
  const [row] = await ctx.db.$queryRaw<
    DocumentRow[]
  >`SELECT * FROM university_documents WHERE organization_id=${ctx.organizationId} AND person_id=${ctx.userId} AND id=${id} FOR UPDATE`;
  if (!row) throw new PortalError(404, 'Document unavailable.');
  return row;
}
export async function storeDocumentPart(ctx: UniversityContext, input: unknown) {
  const data = z
    .object({
      id: z.string().uuid(),
      part: z.number().int().min(0).max(19),
      base64: z
        .string()
        .min(1)
        .max(350000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .parse(input);
  const doc = await ownedDocument(ctx, data.id);
  if (doc.complete) return;
  const bytes = Buffer.from(data.base64, 'base64');
  const expected = Math.min(PART_BYTES, doc.byte_size - data.part * PART_BYTES);
  if (bytes.length !== expected || bytes.toString('base64') !== data.base64)
    throw new PortalError(400, 'The upload part is incomplete.');
  await ctx.db
    .$executeRaw`INSERT INTO university_document_parts(organization_id,document_id,part,ciphertext) VALUES(${ctx.organizationId},${doc.id},${data.part},${encryptSecret(data.base64)}) ON CONFLICT(organization_id,document_id,part) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`;
}
export function validSignature(mime: string, bytes: Buffer) {
  if (mime === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mime === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return (
    mime === 'image/png' &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
}
async function fileBytes(ctx: UniversityContext, id: string) {
  const parts = await ctx.db.$queryRaw<
    { ciphertext: string }[]
  >`SELECT ciphertext FROM university_document_parts WHERE organization_id=${ctx.organizationId} AND document_id=${id} ORDER BY part`;
  return Buffer.concat(parts.map((p) => Buffer.from(decryptSecret(p.ciphertext), 'base64')));
}
export async function finishDocument(ctx: UniversityContext, id: string) {
  const doc = await ownedDocument(ctx, id);
  if (doc.complete) return;
  const bytes = await fileBytes(ctx, doc.id);
  if (
    bytes.length !== doc.byte_size ||
    portalHash(bytes) !== doc.file_hash ||
    !validSignature(doc.mime, bytes)
  )
    throw new PortalError(
      400,
      'The file failed verification. Upload the original PDF, PNG or JPEG.'
    );
  await ctx.db
    .$executeRaw`UPDATE university_documents SET complete=true WHERE organization_id=${ctx.organizationId} AND id=${doc.id}`;
}
export async function downloadDocument(
  ctx: UniversityContext,
  id: string,
  personId: string,
  realm: 'learner' | 'staff'
) {
  const [doc] = await ctx.db.$queryRaw<
    DocumentRow[]
  >`SELECT d.* FROM university_documents d JOIN university_people p ON (d.organization_id,d.person_id)=(p.organization_id,p.id) WHERE d.organization_id=${ctx.organizationId} AND p.id=${personId} AND d.id=${id} AND d.complete`;
  if (!doc) throw new PortalError(404, 'Document unavailable.');
  const bytes = await fileBytes(ctx, doc.id);
  await ctx.db
    .$executeRaw`INSERT INTO university_document_reads(organization_id,document_id,actor_id,actor_realm) VALUES(${ctx.organizationId},${doc.id},${ctx.userId},${realm})`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': doc.mime,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(doc.filename),
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
