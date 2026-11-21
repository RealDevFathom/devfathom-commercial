import { inflateSync, type Inflate } from 'node:zlib';

class InvalidPdf extends Error {}
function requirePdf(condition: unknown): asserts condition {
  if (!condition) throw new InvalidPdf();
}

type Reference = { id: number; generation: number };
type Dictionary = Map<string, PdfValue>;
type PdfValue = number | string | boolean | null | Reference | Dictionary | PdfValue[];
type Entry = { offset: number; generation: number } | { container: number; index: number };
type Indirect = { id: number; generation: number; value: PdfValue; stream?: Buffer; end: number };

const MAX_OBJECTS = 4_096;
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

/** Validate a complete unencrypted, single-revision PDF container and its indexed objects. */
export function hasPdfStructure(bytes: Buffer): boolean {
  try {
    const source = bytes.toString('latin1');
    const header = /^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|[\r\n])/.exec(source);
    const footer =
      /(?:^|[\r\n])startxref[\t ]*(?:\r\n|[\r\n])[\t ]*(\d+)[\t ]*(?:\r\n|[\r\n])%%EOF[\t\r\n ]*$/.exec(
        source
      );
    requirePdf(header && footer);
    const xrefOffset = Number(footer[1]);
    requirePdf(
      Number.isSafeInteger(xrefOffset) &&
        xrefOffset >= header[0].length &&
        xrefOffset < footer.index
    );
    const xref = new Reader(source, xrefOffset);
    const entries = new Map<number, Entry>();
    const used = new Set<number>();
    let structuralBudget = MAX_STRUCTURAL_BYTES;
    let trailer: Dictionary;
    let xrefObject: Indirect | undefined;
    const add = (id: number, entry?: Entry) => {
      requirePdf(id < MAX_OBJECTS && !used.has(id));
      used.add(id);
      if (entry) entries.set(id, entry);
    };
    if (xref.word('xref')) {
      xref.skip();
      while (!xref.word('trailer')) {
        const first = xref.integer();
        const count = xref.integer();
        requirePdf(count > 0 && first + count <= MAX_OBJECTS);
        for (let i = 0; i < count; i++) {
          const offset = xref.integer();
          const generation = xref.integer();
          xref.skip();
          requirePdf(generation <= 65535);
          if (xref.word('n')) add(first + i, { offset, generation });
          else {
            requirePdf(xref.word('f'));
            add(first + i);
          }
        }
        xref.skip();
      }
      trailer = dictionary(xref.value());
    } else {
      xrefObject = objectAt(source, bytes, xrefOffset);
      trailer = dictionary(xrefObject.value);
      requirePdf(trailer.get('/Type') === '/XRef');
      const widths = trailer.get('/W');
      const index = trailer.get('/Index') ?? [0, directInteger(trailer.get('/Size'))];
      requirePdf(
        Array.isArray(widths) &&
          widths.length === 3 &&
          Array.isArray(index) &&
          index.length % 2 === 0
      );
      const [a, b, c] = widths.map(directInteger);
      requirePdf(a <= 1 && b >= 1 && b <= 4 && c <= 4);
      const rowSize = a + b + c;
      const ranges = index.map(directInteger);
      const rows = ranges.reduce((total, n, i) => (i % 2 ? total + n : total), 0);
      requirePdf(rows <= MAX_OBJECTS);
      const decoded = decodeStructure(xrefObject, rows * (rowSize + 1));
      structuralBudget -= decoded.length;
      const data = xrefStreamContents(xrefObject, decoded, rowSize, rows);
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
          if (type === 1) add(first + i, { offset: n, generation: m });
          else if (type === 2) add(first + i, { container: n, index: m });
          else {
            requirePdf(type === 0);
            add(first + i);
          }
        }
      }
      xref.at = xrefObject.end;
    }
    const trailerEnd = xref.at;
    // The footer must be the next non-padding data after this cross-reference.
    requirePdf(
      trailerEnd <= footer.index && /^[\0\t\n\f\r ]*$/.test(source.slice(trailerEnd, footer.index))
    );
    requirePdf(!trailer.has('/Prev') && !trailer.has('/XRefStm') && !trailer.has('/Encrypt'));
    const size = directInteger(trailer.get('/Size'));
    requirePdf(
      size <= MAX_OBJECTS && [...used].every((id) => id < size) && used.has(0) && !entries.has(0)
    );

    const objects = new Map<number, Indirect>();
    if (xrefObject) {
      const entry = entries.get(xrefObject.id);
      requirePdf(
        entry &&
          'offset' in entry &&
          entry.offset === xrefOffset &&
          entry.generation === xrefObject.generation
      );
      objects.set(xrefObject.id, xrefObject);
    }
    const resolving = new Set<number>();
    function resolve(ref: Reference): Indirect {
      const cached = objects.get(ref.id);
      if (cached) {
        requirePdf(cached.generation === ref.generation);
        return cached;
      }
      const entry = entries.get(ref.id);
      requirePdf(entry && resolving.size < 32 && !resolving.has(ref.id));
      resolving.add(ref.id);
      if ('offset' in entry) {
        requirePdf(
          entry.offset >= header![0].length &&
            entry.offset < xrefOffset &&
            entry.generation === ref.generation
        );
        const obj = objectAt(source, bytes, entry.offset, (ref) => resolve(ref).value);
        requirePdf(obj.id === ref.id && obj.generation === ref.generation && obj.end <= xrefOffset);
        objects.set(ref.id, obj);
      } else {
        requirePdf(ref.generation === 0);
        const container = resolve({ id: entry.container, generation: 0 });
        const info = dictionary(container.value);
        requirePdf(info.get('/Type') === '/ObjStm' && (info.get('/DecodeParms') ?? null) === null);
        const decoded = decodeStructure(container, structuralBudget);
        structuralBudget -= decoded.length;
        const first = directInteger(info.get('/First'));
        const count = directInteger(info.get('/N'));
        requirePdf(count <= MAX_OBJECTS && first <= decoded.length);
        const objectSource = decoded.toString('latin1');
        const index = new Reader(objectSource.slice(0, first), 0);
        const offsets: Array<{ id: number; offset: number }> = [];
        for (let i = 0; i < count; i++) {
          const id = index.integer();
          const offset = first + index.integer();
          const entry = entries.get(id);
          requirePdf(
            entry && 'container' in entry && entry.container === container.id && entry.index === i
          );
          requirePdf(
            offset < decoded.length && (i ? offset > offsets[i - 1].offset : offset === first)
          );
          offsets.push({ id, offset });
        }
        index.skip();
        requirePdf(index.at === first);
        for (const [i, { id, offset }] of offsets.entries()) {
          const end = offsets[i + 1]?.offset ?? decoded.length;
          const reader = new Reader(objectSource.slice(offset, end), 0);
          const value = reader.value();
          reader.skip();
          requirePdf(reader.at === end - offset);
          objects.set(id, { id, generation: 0, value, end: 0 });
        }
      }
      resolving.delete(ref.id);
      const object = objects.get(ref.id);
      requirePdf(object);
      return object;
    }

    const physical = [...entries]
      .flatMap(([id, entry]) =>
        'offset' in entry && entry.offset < xrefOffset ? [{ id, ...entry }] : []
      )
      .sort((a, b) => a.offset - b.offset);
    const gap = new Reader(source, header[0].length);
    for (const entry of physical) {
      gap.skip();
      requirePdf(gap.at === entry.offset);
      gap.at = resolve(entry).end;
    }
    gap.skip();
    requirePdf(gap.at === xrefOffset);
    for (const [id, entry] of entries)
      resolve({ id, generation: 'offset' in entry ? entry.generation : 0 });

    const catalog = dictionary(resolve(reference(trailer.get('/Root'))).value);
    requirePdf(catalog.get('/Type') === '/Catalog');
    const seenPages = new Set<number>();
    function pageCount(ref: Reference, parent?: Reference, depth = 0): number {
      requirePdf(depth <= 32 && !seenPages.has(ref.id));
      seenPages.add(ref.id);
      const page = dictionary(resolve(ref).value);
      if (parent) {
        const link = reference(page.get('/Parent'));
        requirePdf(link.id === parent.id && link.generation === parent.generation);
        if (page.get('/Type') === '/Page') return 1;
      }
      requirePdf(page.get('/Type') === '/Pages');
      const kids = page.get('/Kids');
      requirePdf(Array.isArray(kids) && kids.length <= MAX_OBJECTS);
      const count = kids.reduce<number>(
        (sum, kid) => sum + pageCount(reference(kid), ref, depth + 1),
        0
      );
      requirePdf(count === directInteger(page.get('/Count')));
      return count;
    }
    requirePdf(pageCount(reference(catalog.get('/Pages'))) > 0);
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
