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

export function syntheticLicencePdfWithObjectStream(catalogEntries = '') {
  const header = Buffer.from('%PDF-1.7\n');
  let values = '';
  const index =
    [`<< /Type /Catalog /Pages 2 0 R ${catalogEntries} >>`, ...objects.slice(1)]
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

function object(id: number, value: string) {
  return Buffer.from(`${id} 0 obj\n${value}\nendobj\n`);
}

function xrefRow(offset: number) {
  return `${String(offset).padStart(10, '0')} 00000 n \n`;
}

export function syntheticClassicLicence(
  options: {
    header?: string;
    freeGeneration?: number;
    catalog?: string;
    extras?: Buffer[];
    page?: string;
    trailer?: string;
  } = {}
) {
  const header = Buffer.from(options.header ?? '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const all = [
    object(1, `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`),
    object(2, objects[1]),
    object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${options.page ?? ''} >>`),
    ...(options.extras ?? []),
  ];
  let offset = header.length;
  const rows = all.map((value) => {
    const row = xrefRow(offset);
    offset += value.length;
    return row;
  });
  const size = all.length + 1;
  return Buffer.concat([
    header,
    ...all,
    Buffer.from(
      `xref\n0 ${size}\n0000000000 ${options.freeGeneration ?? 65535} f \n${rows.join('')}trailer\n<< /Size ${size} /Root 1 0 R ${options.trailer ?? ''} >>\nstartxref\n${offset}\n%%EOF\n`
    ),
  ]);
}

export function syntheticLicenceRevision(
  base: Buffer,
  catalogEntries = '/Lang (en)',
  signed = false,
  layout = { catalog: 1, pages: 2, size: 4 }
) {
  const previous = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))![1];
  const form = signed ? '/AcroForm << /Fields [4 0 R] /SigFlags 3 >>' : '';
  const catalog = object(
    layout.catalog,
    `<< /Type /Catalog /Pages ${layout.pages} 0 R ${catalogEntries} ${form} >>`
  );
  // Inert signature metadata exercises the container, without authenticating a signature.
  const field = signed
    ? object(4, '<< /FT /Sig /T (Synthetic signature) /V 5 0 R >>')
    : Buffer.alloc(0);
  const signature = signed
    ? object(
        5,
        '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Contents <0000> /ByteRange [0 10 14 10] >>'
      )
    : Buffer.alloc(0);
  const at = base.length + catalog.length + field.length + signature.length;
  const signatureRows = signed
    ? `4 2\n${xrefRow(base.length + catalog.length)}${xrefRow(base.length + catalog.length + field.length)}`
    : '';
  return Buffer.concat([
    base,
    catalog,
    field,
    signature,
    Buffer.from(
      `xref\n${layout.catalog} 1\n${xrefRow(base.length)}${signatureRows}trailer\n<< /Size ${signed ? 6 : layout.size} /Root ${layout.catalog} 0 R /Prev ${previous} >>\nstartxref\n${at}\n%%EOF\n`
    ),
  ]);
}

export function syntheticHybridLicence() {
  const header = Buffer.from('%PDF-1.7\n');
  const first = object(1, objects[0]);
  const second = object(2, objects[1]);
  const objectStream = stream(4, '/Type /ObjStm /N 1 /First 4', Buffer.from(`3 0 ${objects[2]}`));
  const streamOffset = header.length + first.length + second.length;
  const sectionOffset = streamOffset + objectStream.length;
  const section = stream(
    5,
    '/Type /XRef /W [1 4 2] /Size 6 /Index [3 1]',
    Buffer.from([2, 0, 0, 0, 4, 0, 0])
  );
  const tableOffset = sectionOffset + section.length;
  return Buffer.concat([
    header,
    first,
    second,
    objectStream,
    section,
    Buffer.from(
      `xref\n0 6\n0000000003 65535 f \n${xrefRow(header.length)}${xrefRow(header.length + first.length)}0000000000 00000 f \n${xrefRow(streamOffset)}${xrefRow(sectionOffset)}trailer\n<< /Size 6 /Root 1 0 R /XRefStm ${sectionOffset} >>\nstartxref\n${tableOffset}\n%%EOF\n`
    ),
  ]);
}

export function syntheticLinearizedLicence() {
  const header = Buffer.from('%PDF-1.7\n');
  const number = (n: number) => String(n).padStart(6, '0');
  const parameters = (
    length: number,
    hint: number,
    hintLength: number,
    firstEnd: number,
    main: number
  ) =>
    object(
      2,
      `<< /Linearized 1 /L ${number(length)} /H [${number(hint)} ${number(hintLength)}] /O 4 /E ${number(firstEnd)} /N 1 /T ${number(main)} >>`
    );
  const firstOffset = header.length + parameters(0, 0, 0, 0, 0).length;
  const catalog = object(3, '<< /Type /Catalog /Pages 1 0 R >>');
  const hintStream = stream(5, '/S 36', Buffer.alloc(60));
  const page = object(4, '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] >>');
  const first = (
    catalogOffset: number,
    hintOffset: number,
    pageOffset: number,
    mainOffset: number
  ) =>
    Buffer.from(
      `xref\n2 4\n${xrefRow(header.length)}${xrefRow(catalogOffset)}${xrefRow(pageOffset)}${xrefRow(hintOffset)}trailer\n<< /Size 6 /Root 3 0 R /Prev ${number(mainOffset)} >>\nstartxref\n0\n%%EOF\n`
    );
  const catalogOffset = firstOffset + first(0, 0, 0, 0).length;
  const hintOffset = catalogOffset + catalog.length;
  const pageOffset = hintOffset + hintStream.length;
  const firstEnd = pageOffset + page.length;
  const pages = object(1, '<< /Type /Pages /Count 1 /Kids [4 0 R] >>');
  const mainOffset = firstEnd + pages.length;
  const mainHeader = 'xref\n0 2\n';
  const main = Buffer.from(
    `${mainHeader}0000000000 65535 f \n${xrefRow(firstEnd)}trailer\n<< /Size 2 >>\nstartxref\n${firstOffset}\n%%EOF\n`
  );
  return Buffer.concat([
    header,
    parameters(
      mainOffset + main.length,
      hintOffset,
      hintStream.length,
      firstEnd,
      mainOffset + mainHeader.length
    ),
    first(catalogOffset, hintOffset, pageOffset, mainOffset),
    catalog,
    hintStream,
    page,
    pages,
    main,
  ]);
}

export function syntheticScannerLicence() {
  return syntheticClassicLicence({
    page: '/Contents 4 0 R /Resources << /XObject << /Scan 5 0 R >> >>',
    extras: [
      stream(4, '', Buffer.from('q 1 0 0 1 0 0 cm /Scan Do Q')),
      stream(
        5,
        '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray',
        Buffer.from([255])
      ),
    ],
  });
}

export function syntheticWordLicence() {
  return syntheticClassicLicence({
    catalog: '/ViewerPreferences << /DisplayDocTitle true >> /OpenAction [3 0 R /Fit]',
    trailer: '/Info 4 0 R',
    page: '/Contents 5 0 R',
    extras: [
      object(4, '<< /Producer (Word-like fixture) /Title (Synthetic licence) >>'),
      stream(5, '', Buffer.from('q Q')),
    ],
  });
}

export function syntheticLicenceStreamRevision(base: Buffer) {
  const previous = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))![1];
  const info = object(4, '<< /Title (Synthetic revision) >>');
  const offset = base.length + info.length;
  const index = Buffer.alloc(7);
  index[0] = 1;
  index.writeUInt32BE(base.length, 1);
  return Buffer.concat([
    base,
    info,
    stream(
      5,
      `/Type /XRef /Size 6 /Root 1 0 R /Info 4 0 R /Prev ${previous} /Index [4 1] /W [1 4 2]`,
      index
    ),
    Buffer.from(`startxref\n${offset}\n%%EOF\n`),
  ]);
}
