import { deflateSync } from 'node:zlib';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
];

export function syntheticLicencePdf(padding = 0) {
  let pdf = '%PDF-1.7\n';
  if (padding) pdf += `%${' '.repeat(padding)}\n`;
  const entries = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    entries.push(`${String(pdf.length).padStart(10, '0')} 00000 n \n`);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${entries.length}\n${entries.join('')}trailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function stream(id: number, fields: string, data: Buffer) {
  const compressed = deflateSync(data);
  return Buffer.concat([
    Buffer.from(
      `${id} 0 obj\n<< ${fields} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`
    ),
    compressed,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
}

export function syntheticLicencePdfWithObjectStream() {
  const header = Buffer.from('%PDF-1.7\n');
  let values = '';
  const index =
    objects
      .map((object, i) => {
        const pair = `${i + 1} ${values.length}`;
        values += `${object} `;
        return pair;
      })
      .join(' ') + ' ';
  const objectStream = stream(
    4,
    `/Type /ObjStm /N 3 /First ${index.length}`,
    Buffer.from(index + values)
  );
  const xrefOffset = header.length + objectStream.length;
  const rows = Buffer.alloc(6 * 7);
  for (const [id, [type, field1, field2]] of [
    [0, 0, 65535],
    [2, 4, 0],
    [2, 4, 1],
    [2, 4, 2],
    [1, header.length, 0],
    [1, xrefOffset, 0],
  ].entries()) {
    rows.writeUInt8(type, id * 7);
    rows.writeUInt32BE(field1, id * 7 + 1);
    rows.writeUInt16BE(field2, id * 7 + 5);
  }
  return Buffer.concat([
    header,
    objectStream,
    stream(5, '/Type /XRef /W [1 4 2] /Size 6 /Root 1 0 R', rows),
    Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`),
  ]);
}
