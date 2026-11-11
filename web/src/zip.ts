/**
 * A small ZIP writer for chat exports (exporter.ts), so the browser can save everything as one file
 * without a library. Text is compressed (the browser's own deflate, when it has one); photos and videos
 * are stored as they are (they're compressed already). File names are UTF-8. No ZIP64: an export has to
 * stay under 4 GB, which `add` checks.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const canDeflate = typeof CompressionStream !== 'undefined';
type Bytes = Uint8Array<ArrayBuffer>;
async function deflate(data: Bytes): Promise<Bytes> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const LIMIT = 0xffffffff;

export class ZipWriter {
  private parts: BlobPart[] = [];
  private central: Bytes[] = [];
  private offset = 0;
  private count = 0;
  private names = new Set<string>();
  private readonly time: number;
  private readonly date: number;

  constructor(now = new Date()) {
    this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    this.date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  /** A path that isn't in the ZIP yet: "a.jpg", then "a (2).jpg" … */
  freeName(path: string) {
    if (!this.names.has(path)) return path;
    const dot = path.lastIndexOf('.');
    const [base, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
    for (let i = 2; ; i++) if (!this.names.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  }

  async add(path: string, content: string | Blob | Bytes, compress = typeof content === 'string') {
    const raw: Bytes =
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content instanceof Blob
          ? new Uint8Array(await content.arrayBuffer())
          : content;
    const crc = crc32(raw);
    let data = raw;
    let method = 0;
    if (compress && canDeflate && raw.length > 64) {
      const packed = await deflate(raw);
      if (packed.length < raw.length) {
        data = packed;
        method = 8;
      }
    }
    if (this.count >= 65534) throw new Error('This export has too many files for one ZIP (over 65,000). Export fewer chats at a time.');
    if (this.offset + data.length + 100 > LIMIT) throw new Error('This export is too big for one file (over 4 GB). Export fewer chats at a time, or without photos and files.');
    const name = new TextEncoder().encode(path);
    this.names.add(path);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, this.time, true);
    local.setUint16(12, this.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // made by
    cd.setUint16(6, 20, true); // needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, this.time, true);
    cd.setUint16(14, this.date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(cd.buffer), name);

    this.parts.push(local.buffer, name, data);
    this.offset += 30 + name.length + data.length;
    this.count++;
  }

  finish(): Blob {
    const size = this.central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
