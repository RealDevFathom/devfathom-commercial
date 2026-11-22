import { inflateSync, type Inflate } from 'node:zlib';

class InvalidPdf extends Error {}
function requirePdf(condition: unknown): asserts condition {
  if (!condition) throw new InvalidPdf();
}

type Reference = { id: number; generation: number };
type Dictionary = Map<string, PdfValue>;
type PdfValue = number | string | boolean | null | Reference | Dictionary | PdfValue[];
type Entry = { offset: number; generation: number } | { container: number; index: number };
type Section = {
  offset: number;
  end: number;
  trailer: Dictionary;
  entries: Map<number, Entry | null>;
  stream?: Indirect;
};
type Region = { offset: number; end: number };
type Indirect = { id: number; generation: number; value: PdfValue; stream?: Buffer; end: number };

const MAX_OBJECTS = 4_096;
const MAX_REVISIONS = 64;
const MAX_INDEX_ENTRIES = 65_536;
const MAX_POLICY_VALUES = 1_000_000;
const MAX_STRUCTURAL_BYTES = 8 * 1024 * 1024;
const whitespace = /[\0\t\n\f\r ]+/y;
const boundary = '(?=[\\0\\t\\n\\f\\r ()<>\\[\\]/%]|$)';
const numberToken = new RegExp(`[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)${boundary}`, 'y');
const integerToken = new RegExp(`\\d+${boundary}`, 'y');
const nameToken = /\/[^\0\t\n\f\r ()<>\[\]{}/%]*/y;
const comment = /%[^\r\n]*/y;

class Reader {
  constructor(
    readonly source: string,
    public at: number
  ) {}

  match(pattern: RegExp) {
    pattern.lastIndex = this.at;
    const match = pattern.exec(this.source);
    if (match) this.at = pattern.lastIndex;
    return match;
  }

  skip() {
    while (this.match(whitespace) || this.match(comment)) {
      // PDF whitespace and comments separate tokens.
    }
  }

  take(text: string) {
    if (!this.source.startsWith(text, this.at)) return false;
    this.at += text.length;
    return true;
  }

  word(text: string) {
    const start = this.at;
    if (this.take(text) && /[\0\t\n\f\r ()<>\[\]/%]/.test(this.source[this.at] ?? ' ')) return true;
    this.at = start;
    return false;
  }

  integer() {
    this.skip();
    const match = this.match(integerToken);
    requirePdf(match);
    const value = Number(match[0]);
    requirePdf(Number.isSafeInteger(value));
    return value;
  }

  name() {
    const match = this.match(nameToken);
    requirePdf(match && !/#(?![0-9a-f]{2})/i.test(match[0]));
    return match[0].replace(/#([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }

  value(depth = 0): PdfValue {
    requirePdf(depth <= 32);
    this.skip();
    if (this.take('<<')) {
      const dictionary: Dictionary = new Map();
      this.skip();
      while (!this.take('>>')) {
        const key = this.name();
        requirePdf(!dictionary.has(key));
        dictionary.set(key, this.value(depth + 1));
        this.skip();
      }
      return dictionary;
    }
    if (this.take('[')) {
      const values: PdfValue[] = [];
      this.skip();
      while (!this.take(']')) {
        values.push(this.value(depth + 1));
        this.skip();
      }
      return values;
    }
    if (this.source[this.at] === '/') return this.name();
    if (this.take('(')) {
      let nesting = 1;
      for (; this.at < this.source.length; this.at++) {
        const char = this.source[this.at];
        if (char === '\\') this.at++;
        else if (char === '(') nesting++;
        else if (char === ')' && --nesting === 0) {
          this.at++;
          return null;
        }
      }
      throw new InvalidPdf();
    }
    if (this.take('<')) {
      requirePdf(this.match(/[0-9a-f\0\t\n\f\r ]*>/iy));
      return null;
    }
    if (this.word('null')) return null;
    if (this.word('true')) return true;
    if (this.word('false')) return false;

    const match = this.match(numberToken);
    requirePdf(match);
    const value = Number(match[0]);
    requirePdf(Number.isFinite(value));
    if (/^\d+$/.test(match[0])) {
      const end = this.at;
      this.skip();
      const generation = this.match(integerToken);
      if (generation) {
        this.skip();
        if (this.word('R')) {
          requirePdf(Number.isSafeInteger(value) && Number(generation[0]) <= 65535);
          return { id: value, generation: Number(generation[0]) };
        }
      }
      this.at = end;
    }
    return value;
  }
}

function directInteger(value: PdfValue | undefined): number {
  requirePdf(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  return value;
}

function reference(value: PdfValue | undefined): Reference {
  requirePdf(value && typeof value === 'object' && 'id' in value);
  return value;
}

function dictionary(value: PdfValue | undefined): Dictionary {
  requirePdf(value instanceof Map);
  return value;
}

function objectAt(
  source: string,
  bytes: Buffer,
  offset: number,
  resolveLength?: (ref: Reference) => PdfValue
): Indirect {
  const reader = new Reader(source, offset);
  requirePdf(/^\d/.test(source[offset] ?? ''));
  const id = reader.integer();
  const generation = reader.integer();
  reader.skip();
  requirePdf(reader.word('obj'));
  const value = reader.value();
  reader.skip();
  let stream: Buffer | undefined;
  if (reader.word('stream')) {
    requirePdf(reader.take('\r\n') || reader.take('\n'));
    const length = dictionary(value).get('/Length');
    const size = directInteger(
      typeof length === 'number' ? length : resolveLength?.(reference(length))
    );
    requirePdf(size <= bytes.length - reader.at);
    stream = bytes.subarray(reader.at, reader.at + size);
    reader.at += size;
    if (!reader.take('\r\n') && !reader.take('\n')) reader.take('\r');
    requirePdf(reader.word('endstream'));
    reader.skip();
  }
  requirePdf(reader.word('endobj'));
  return { id, generation, value, stream, end: reader.at };
}

function decodeStructure(object: Indirect, maxBytes: number) {
  const info = dictionary(object.value);
  const filter = info.get('/Filter');
  const stream = object.stream;
  requirePdf(stream && maxBytes > 0);
  if (filter === undefined) {
    requirePdf(stream.length <= maxBytes);
    return stream;
  }
  requirePdf(
    filter === '/FlateDecode' ||
      (Array.isArray(filter) && filter.length === 1 && filter[0] === '/FlateDecode')
  );
  const { buffer, engine } = inflateSync(stream, {
    maxOutputLength: maxBytes,
    info: true,
  }) as unknown as { buffer: Buffer; engine: Inflate };
  requirePdf(engine.bytesWritten === stream.length);
  return buffer;
}

function xrefStreamContents(object: Indirect, decoded: Buffer, rowSize: number, rows: number) {
  let params = dictionary(object.value).get('/DecodeParms');
  if (Array.isArray(params)) {
    requirePdf(params.length === 1);
    params = params[0];
  }
  if (params == null) {
    requirePdf(decoded.length === rows * rowSize);
    return decoded;
  }
  const settings = dictionary(params);
  const predictor = settings.get('/Predictor') ?? 1;
  if (predictor === 1) {
    requirePdf(decoded.length === rows * rowSize);
    return decoded;
  }
  requirePdf(typeof predictor === 'number' && predictor >= 10 && predictor <= 15);
  requirePdf((settings.get('/Columns') ?? 1) === rowSize);
  requirePdf(
    (settings.get('/Colors') ?? 1) === 1 && (settings.get('/BitsPerComponent') ?? 8) === 8
  );
  requirePdf(decoded.length === rows * (rowSize + 1));
  const data = Buffer.alloc(rows * rowSize);
  for (let row = 0; row < rows; row++) {
    const filter = decoded[row * (rowSize + 1)];
    requirePdf(filter <= 4);
    for (let col = 0; col < rowSize; col++) {
      const index = row * rowSize + col;
      const left = col > 0 ? data[index - 1] : 0;
      const up = row > 0 ? data[index - rowSize] : 0;
      const diagonal = row > 0 && col > 0 ? data[index - rowSize - 1] : 0;
      const p = left + up - diagonal;
      const a = Math.abs(p - left);
      const b = Math.abs(p - up);
      const c = Math.abs(p - diagonal);
      const paeth = a <= b && a <= c ? left : b <= c ? up : diagonal;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      data[index] = decoded[index + row + 1] + predicted;
    }
  }
  return data;
}

const footerPattern =
  /startxref[\t ]*(?:\r\n|[\r\n])[\t ]*(\d+)[\t ]*(?:\r\n|[\r\n])%%EOF[\t ]*(?:\r\n|[\r\n]|$)/y;
const lastFooterPattern =
  /(?:^|[\r\n])startxref[\t ]*(?:\r\n|[\r\n])[\t ]*(\d+)[\t ]*(?:\r\n|[\r\n])%%EOF[\t\r\n ]*$/;

function footerAt(source: string, offset: number, expected: number, optional = false) {
  const reader = new Reader(source, offset);
  reader.match(whitespace);
  const footer = reader.match(footerPattern);
  if (optional && !footer) return offset;
  requirePdf(footer && Number(footer[1]) === expected);
  return reader.at;
}

function readSection(
  source: string,
  bytes: Buffer,
  offset: number,
  decode: typeof decodeStructure
): Section {
  const reader = new Reader(source, offset);
  const entries = new Map<number, Entry | null>();
  const add = (id: number, entry: Entry | null) => {
    requirePdf(id < MAX_OBJECTS && !entries.has(id) && (id !== 0 || entry === null));
    entries.set(id, entry);
  };

  let trailer: Dictionary;
  let stream: Indirect | undefined;
  if (reader.word('xref')) {
    reader.skip();
    while (!reader.word('trailer')) {
      const first = reader.integer();
      const count = reader.integer();
      requirePdf(count > 0 && first + count <= MAX_OBJECTS);
      for (let id = first; id < first + count; id++) {
        const offset = reader.integer();
        const generation = reader.integer();
        reader.skip();
        if (reader.word('n')) {
          requirePdf(generation <= 65535);
          add(id, { offset, generation });
        } else {
          // Pillow uses 65536 for the reserved free object zero.
          requirePdf(
            reader.word('f') && (generation <= 65535 || (id === 0 && generation === 65536))
          );
          add(id, null);
        }
      }
      reader.skip();
    }
    trailer = dictionary(reader.value());
  } else {
    stream = objectAt(source, bytes, offset);
    trailer = dictionary(stream.value);
    requirePdf(trailer.get('/Type') === '/XRef');
    const widths = trailer.get('/W');
    const index = trailer.get('/Index') ?? [0, directInteger(trailer.get('/Size'))];
    requirePdf(
      Array.isArray(widths) && widths.length === 3 && Array.isArray(index) && index.length % 2 === 0
    );
    const [a, b, c] = widths.map(directInteger);
    requirePdf(a <= 1 && b >= 1 && b <= 4 && c <= 4);
    const rowSize = a + b + c;
    const ranges = index.map(directInteger);
    const rows = ranges.reduce((total, n, i) => (i % 2 ? total + n : total), 0);
    requirePdf(rows > 0 && rows <= MAX_OBJECTS);
    const data = xrefStreamContents(stream, decode(stream, rows * (rowSize + 1)), rowSize, rows);
    let cursor = 0;
    for (let range = 0; range < ranges.length; range += 2) {
      const first = ranges[range];
      const count = ranges[range + 1];
      requirePdf(first + count <= MAX_OBJECTS);
      for (let i = 0; i < count; i++) {
        const type = a ? data.readUIntBE(cursor, a) : 1;
        const n = data.readUIntBE(cursor + a, b);
        const m = c ? data.readUIntBE(cursor + a + b, c) : 0;
        cursor += rowSize;
        requirePdf(type <= 2 && (type !== 1 || m <= 65535));
        add(
          first + i,
          type === 0 ? null : type === 1 ? { offset: n, generation: m } : { container: n, index: m }
        );
      }
    }
    reader.at = stream.end;
  }

  const size = directInteger(trailer.get('/Size'));
  requirePdf(size <= MAX_OBJECTS && [...entries.keys()].every((id) => id < size));
  requirePdf(!trailer.has('/Encrypt'));
  return { offset, end: reader.at, trailer, entries, stream };
}

function readObjectStream(
  object: Indirect,
  decode: typeof decodeStructure
): Array<{ id: number; value: PdfValue }> {
  const info = dictionary(object.value);
  requirePdf(info.get('/Type') === '/ObjStm' && (info.get('/DecodeParms') ?? null) === null);
  const decoded = decode(object, MAX_STRUCTURAL_BYTES);
  const first = directInteger(info.get('/First'));
  const count = directInteger(info.get('/N'));
  requirePdf(count <= MAX_OBJECTS && first <= decoded.length);
  const source = decoded.toString('latin1');
  const index = new Reader(source.slice(0, first), 0);
  const offsets: Array<{ id: number; offset: number }> = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const id = index.integer();
    const offset = first + index.integer();
    requirePdf(id > 0 && id < MAX_OBJECTS && !seen.has(id));
    requirePdf(offset < decoded.length && (i ? offset > offsets[i - 1].offset : offset === first));
    seen.add(id);
    offsets.push({ id, offset });
  }
  index.skip();
  requirePdf(index.at === first && (count > 0 || first === decoded.length));
  return offsets.map(({ id, offset }, i) => {
    const end = offsets[i + 1]?.offset ?? decoded.length;
    const reader = new Reader(source.slice(offset, end), 0);
    const value = reader.value();
    reader.skip();
    requirePdf(reader.at === end - offset);
    return { id, value };
  });
}

const forbiddenKeys = new Set([
  '/Encrypt',
  '/JS',
  '/JavaScript',
  '/Launch',
  '/EmbeddedFiles',
  '/EF',
  '/RichMedia',
  '/RichMediaContent',
  '/RichMediaSettings',
  '/3DD',
  '/3DA',
  '/XFA',
]);
const executableActions = new Set([
  '/JavaScript',
  '/Launch',
  '/Rendition',
  '/RichMediaExecute',
  '/Movie',
  '/Sound',
  '/GoToE',
  '/GoTo3DView',
]);
const embeddedTypes = new Set([
  '/EmbeddedFile',
  '/RichMedia',
  '/Movie',
  '/Sound',
  '/Screen',
  '/3D',
]);

function isReference(value: PdfValue | undefined): value is Reference {
  return Boolean(value && typeof value === 'object' && 'id' in value);
}

// PDF names have already been decoded by the reader. Strings and stream data are
// never interpreted as script and cannot be mistaken for dictionary names.
function assertInactive(
  value: PdfValue,
  resolve: (ref: Reference) => PdfValue,
  charge: () => void
) {
  function dereference(value: PdfValue | undefined) {
    for (let hops = 0; isReference(value); hops++) {
      requirePdf(hops < 32);
      value = resolve(value);
    }
    return value;
  }
  function visit(value: PdfValue) {
    charge();
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!(value instanceof Map)) return;
    if (dereference(value.get('/Type')) === '/Filespec') {
      requirePdf(!value.has('/RF'));
      for (const key of ['/F', '/UF', '/DOS', '/Mac', '/Unix'])
        requirePdf(!(dereference(value.get(key)) instanceof Map));
    }
    for (const [key, entry] of value) {
      requirePdf(!forbiddenKeys.has(key));
      if (key === '/S' || key === '/Type' || key === '/Subtype' || key === '/Filter') {
        const name = dereference(entry);
        if (typeof name === 'string') {
          requirePdf(
            key === '/S'
              ? !executableActions.has(name)
              : key === '/Filter'
                ? name !== '/Crypt'
                : !embeddedTypes.has(name)
          );
        }
        if (key === '/Filter' && Array.isArray(name))
          requirePdf(name.every((filter) => dereference(filter) !== '/Crypt'));
      }
      if (key === '/OpenAction' || key === '/AA') {
        const action = dereference(entry);
        requirePdf(
          action === null ||
            action instanceof Map ||
            (key === '/OpenAction' && Array.isArray(action))
        );
      }
      visit(entry);
    }
  }
  visit(value);
}

function countPages(catalog: Dictionary, resolve: (ref: Reference) => PdfValue) {
  requirePdf(catalog.get('/Type') === '/Catalog');
  const seen = new Set<number>();
  function count(ref: Reference, parent?: Reference, depth = 0): number {
    requirePdf(depth <= 32 && !seen.has(ref.id));
    seen.add(ref.id);
    const page = dictionary(resolve(ref));
    if (parent) {
      const link = reference(page.get('/Parent'));
      requirePdf(link.id === parent.id && link.generation === parent.generation);
      if (page.get('/Type') === '/Page') return 1;
    }
    requirePdf(page.get('/Type') === '/Pages');
    const kids = page.get('/Kids');
    requirePdf(Array.isArray(kids) && kids.length <= MAX_OBJECTS);
    const total = kids.reduce<number>((sum, kid) => sum + count(reference(kid), ref, depth + 1), 0);
    requirePdf(total === directInteger(page.get('/Count')));
    return total;
  }
  return count(reference(catalog.get('/Pages')));
}

function validatePdf(bytes: Buffer) {
  const source = bytes.toString('latin1');
  const header = /^%PDF-(?:1\.[0-7]|2\.0)[\t ]*(?:\r\n|[\r\n])/.exec(source);
  const footer = lastFooterPattern.exec(source);
  requirePdf(header && footer);
  const headerEnd = header[0].length;
  const regions = new Map<number, Region>();
  const physicalObjects = new Map<number, Indirect>();
  const objectStreams = new Map<Indirect, ReturnType<typeof readObjectStream>>();
  const sections = new Map<number, Section>();
  let remainingDecoded = MAX_STRUCTURAL_BYTES;
  let remainingEntries = MAX_INDEX_ENTRIES;
  let remainingPolicy = MAX_POLICY_VALUES;
  const decode: typeof decodeStructure = (object, limit) => {
    const decoded = decodeStructure(object, Math.min(limit, remainingDecoded));
    remainingDecoded -= decoded.length;
    return decoded;
  };
  const chargePolicy = () => requirePdf(--remainingPolicy >= 0);

  function section(offset: number) {
    requirePdf(
      Number.isSafeInteger(offset) &&
        offset >= headerEnd &&
        offset < footer!.index &&
        !sections.has(offset)
    );
    const parsed = readSection(source, bytes, offset, decode);
    remainingEntries -= parsed.entries.size;
    requirePdf(remainingEntries >= 0);
    if (parsed.stream) physicalObjects.set(offset, parsed.stream);
    sections.set(offset, parsed);
    return parsed;
  }

  function parts(primary: Section): Section[] {
    const supplementOffset = primary.trailer.get('/XRefStm');
    if (supplementOffset === undefined) return [primary];
    const offset = directInteger(supplementOffset);
    requirePdf(!primary.stream && offset < primary.offset);
    const supplemental = section(offset);
    requirePdf(supplemental.stream && !supplemental.trailer.has('/XRefStm'));
    if (supplemental.trailer.has('/Prev')) directInteger(supplemental.trailer.get('/Prev'));
    regions.set(offset, supplemental);
    // Hybrid stream entries take precedence over the classic table's entries.
    return [primary, supplemental];
  }

  type Revision = { primary: Section; sections: Section[]; end: number; linearization?: Indirect };
  const revisions: Revision[] = [];
  let offset: number | undefined = Number(footer[1]);
  while (offset !== undefined) {
    requirePdf(revisions.length < MAX_REVISIONS);
    const primary = section(offset);
    const primaryParts = parts(primary);
    const previous = primary.trailer.get('/Prev');
    const prev = previous === undefined ? undefined : directInteger(previous);
    requirePdf(prev !== offset);
    if (prev !== undefined && prev > offset) {
      // Linearization places the first-page section up front and points
      // forward to the main cross-reference at the end of the first revision.
      const first = new Reader(source, headerEnd);
      first.skip();
      const parametersOffset = first.at;
      const parameters = objectAt(source, bytes, parametersOffset);
      const info = dictionary(parameters.value);
      requirePdf(!parameters.stream && info.get('/Linearized') === 1 && parameters.end <= 1024);
      first.at = parameters.end;
      first.skip();
      requirePdf(first.at === offset);
      const main = section(prev);
      requirePdf(!main.trailer.has('/Prev'));
      const end = footerAt(source, main.end, offset);
      const declaredLength = directInteger(info.get('/L'));
      requirePdf(
        declaredLength >= end &&
          declaredLength <= bytes.length &&
          /^[\0\t\n\f\r ]*$/.test(source.slice(end, declaredLength))
      );
      const firstPageEnd = directInteger(info.get('/E'));
      const mainIndex = directInteger(info.get('/T'));
      const hints = info.get('/H');
      requirePdf(firstPageEnd > offset && firstPageEnd <= prev);
      // For a stream, /T can point at the padding immediately before its header.
      requirePdf(
        main.stream
          ? mainIndex >= offset &&
              mainIndex <= prev &&
              /^[\0\t\n\f\r ]*$/.test(source.slice(mainIndex, prev))
          : mainIndex >= prev && mainIndex <= main.end
      );
      requirePdf(Array.isArray(hints) && (hints.length === 2 || hints.length === 4));
      for (let i = 0; i < hints.length; i += 2) {
        const start = directInteger(hints[i]);
        const length = directInteger(hints[i + 1]);
        requirePdf(start >= headerEnd && length > 0 && start + length <= prev);
      }
      physicalObjects.set(parametersOffset, parameters);
      regions.set(primary.offset, {
        offset: primary.offset,
        end: footerAt(source, primary.end, 0, true),
      });
      regions.set(main.offset, { offset: main.offset, end });
      revisions.push({
        primary,
        sections: [...parts(main), ...primaryParts],
        end,
        linearization: parameters,
      });
      break;
    }
    const end = footerAt(source, primary.end, offset);
    regions.set(primary.offset, { offset: primary.offset, end });
    revisions.push({ primary, sections: primaryParts, end });
    offset = prev;
  }
  requirePdf(/^[\0\t\n\f\r ]*$/.test(source.slice(revisions[0].end)));

  for (const section of sections.values()) {
    // A hybrid stream can carry a pointer to the corresponding older index.
    // Primary pointers have already been consumed by the revision walker.
    const prev = section.trailer.get('/Prev');
    if (prev !== undefined) {
      const linked = directInteger(prev);
      requirePdf(sections.has(linked) || (linked === 0 && section.stream));
    }
  }

  const active = new Map<number, Entry | null>();
  let root: PdfValue | undefined;
  let previousEnd = headerEnd;
  for (const revision of revisions.reverse()) {
    requirePdf(revision.end > previousEnd);
    const parts = revision.sections;
    for (const part of parts) {
      requirePdf(part.offset >= previousEnd && part.end <= revision.end);
      for (const [id, entry] of part.entries) active.set(id, entry);
    }
    requirePdf(active.get(0) === null);
    for (const part of parts) {
      const stream = part.stream;
      if (!stream) continue;
      // Some incremental writers omit the stream itself from the index. The
      // section pointer already locates it, and any explicit entry must agree.
      requirePdf(stream.id > 0);
      if (!active.has(stream.id)) {
        active.set(stream.id, { offset: part.offset, generation: stream.generation });
      }
      const entry = active.get(stream.id);
      requirePdf(
        entry &&
          'offset' in entry &&
          entry.offset === part.offset &&
          entry.generation === stream.generation
      );
    }
    const size = directInteger(revision.primary.trailer.get('/Size'));
    requirePdf([...active.keys()].every((id) => id < size));
    root = revision.primary.trailer.get('/Root') ?? root;
    const resolving = new Set<number>();

    function physical(id: number, entry: Extract<Entry, { offset: number }>): Indirect {
      requirePdf(entry.offset >= headerEnd && entry.offset < revision.end);
      let object = physicalObjects.get(entry.offset);
      if (!object) {
        requirePdf(entry.offset >= previousEnd);
        object = objectAt(source, bytes, entry.offset, resolve);
        physicalObjects.set(entry.offset, object);
      }
      requirePdf(
        object.id === id && object.generation === entry.generation && object.end <= revision.end
      );
      if (object.stream && !sections.has(entry.offset)) {
        const length = dictionary(object.value).get('/Length');
        requirePdf(
          object.stream.length === directInteger(isReference(length) ? resolve(length) : length)
        );
      }
      if (!regions.has(entry.offset))
        regions.set(entry.offset, { offset: entry.offset, end: object.end });
      return object;
    }

    function compressed(object: Indirect) {
      const existing = objectStreams.get(object);
      if (existing) return existing;
      const values = readObjectStream(object, decode);
      objectStreams.set(object, values);
      return values;
    }

    function resolve(ref: Reference): PdfValue {
      const entry = active.get(ref.id);
      requirePdf(entry && !resolving.has(ref.id) && resolving.size < 32);
      resolving.add(ref.id);
      let value: PdfValue;
      if ('offset' in entry) {
        requirePdf(entry.generation === ref.generation);
        value = physical(ref.id, entry).value;
      } else {
        const container = active.get(entry.container);
        requirePdf(
          ref.generation === 0 && container && 'offset' in container && container.generation === 0
        );
        const object = compressed(physical(entry.container, container))[entry.index];
        requirePdf(object?.id === ref.id);
        value = object.value;
      }
      resolving.delete(ref.id);
      return value;
    }

    const inspect = (value: PdfValue) => assertInactive(value, resolve, chargePolicy);
    for (const part of parts) {
      inspect(part.trailer);
      for (const [id, entry] of part.entries) {
        if (entry && 'offset' in entry) {
          const obj = physical(id, entry);
          inspect(obj.value);
          // Inspect every member, even entries omitted from this xref or
          // superseded in a later update.
          if (obj.value instanceof Map && obj.value.get('/Type') === '/ObjStm')
            for (const item of compressed(obj)) inspect(item.value);
        } else if (entry) {
          const container = active.get(entry.container);
          requirePdf(container && 'offset' in container && container.generation === 0);
          const object = compressed(physical(entry.container, container))[entry.index];
          requirePdf(object?.id === id);
          inspect(object.value);
        }
      }
    }
    // An update can change an indirect action name referenced by older objects.
    for (const [id, entry] of active) {
      if (entry) inspect(resolve({ id, generation: 'offset' in entry ? entry.generation : 0 }));
    }
    const pages = countPages(dictionary(resolve(reference(root))), resolve);
    requirePdf(pages > 0);
    if (revision.linearization) {
      const parameters = revision.linearization;
      const entry = active.get(parameters.id);
      const info = dictionary(parameters.value);
      requirePdf(
        entry && 'offset' in entry && physical(parameters.id, entry).end === parameters.end
      );
      requirePdf(
        info.get('/N') === pages &&
          dictionary(resolve({ id: directInteger(info.get('/O')), generation: 0 })).get('/Type') ===
            '/Page'
      );
      const hints = info.get('/H') as PdfValue[];
      for (let i = 0; i < hints.length; i += 2) {
        const offset = directInteger(hints[i]);
        const end = offset + directInteger(hints[i + 1]);
        const hint = physicalObjects.get(offset);
        requirePdf(
          hint?.stream && hint.end <= end && /^[\0\t\n\f\r ]*$/.test(source.slice(hint.end, end))
        );
      }
    }
    previousEnd = revision.end;
  }

  // Every byte is part of an indexed object, a cross-reference section, or PDF padding.
  const cursor = new Reader(source, headerEnd);
  for (const { offset, end } of [...regions.values()].sort((a, b) => a.offset - b.offset)) {
    cursor.skip();
    requirePdf(cursor.at === offset);
    cursor.at = end;
  }
  cursor.skip();
  requirePdf(cursor.at === source.length);
}

/** Validate the complete PDF container and inspect every revision for active content. */
export function hasPdfStructure(bytes: Buffer): boolean {
  try {
    validatePdf(bytes);
    return true;
  } catch (error) {
    if (
      error instanceof InvalidPdf ||
      error instanceof RangeError ||
      (error instanceof Error && 'code' in error)
    )
      return false;
    throw error;
  }
}
