// zip.js — an EPUB is a zip "suitcase" of web pages, pictures and a
// table of contents. This reads the suitcase's packing list and unpacks
// single items on demand, using the browser's built-in decompression.

export class ZipArchive {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.entries = new Map();
    this.lowerCase = new Map();
    this.readDirectory();
  }

  static async fromBlob(blob) {
    return new ZipArchive(await blob.arrayBuffer());
  }

  readDirectory() {
    const b = this.bytes;
    const v = this.view;
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This file is damaged or is not a valid EPUB.');

    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();

    for (let n = 0; n < count; n++) {
      if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) {
        throw new Error('This file is damaged or is not a valid EPUB.');
      }
      const method = v.getUint16(p + 10, true);
      const compSize = v.getUint32(p + 20, true);
      const size = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!name.endsWith('/')) {
        const entry = { method, compSize, size, local };
        this.entries.set(name, entry);
        this.lowerCase.set(name.toLowerCase(), entry);
      }
    }
  }

  entry(path) {
    return this.entries.get(path) || this.lowerCase.get(path.toLowerCase()) || null;
  }

  has(path) {
    return !!this.entry(path);
  }

  async bytesOf(path) {
    const e = this.entry(path);
    if (!e) return null;
    const v = this.view;
    if (v.getUint32(e.local, true) !== 0x04034b50) throw new Error('This EPUB is damaged.');
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    const raw = this.bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('This EPUB uses an unsupported compression method.');
  }

  async text(path) {
    const bytes = await this.bytesOf(path);
    return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
  }
}
