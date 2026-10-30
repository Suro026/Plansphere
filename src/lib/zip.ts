/**
 * A minimal ZIP writer — stored (uncompressed) entries only.
 *
 * Every export format the app produces beyond CSV needs a container: an
 * .xlsx is a ZIP of XML parts, and a PDF does not need one at all. Pulling in
 * a compression library for this is disproportionate — stored entries are a
 * perfectly valid ZIP, every reader (Excel, Numbers, Sheets, `unzip`)
 * accepts them, and at the size of a registration export the size difference
 * against DEFLATE is not worth a dependency. What follows is the format's
 * three structures, verbatim: a local file header before each entry, a
 * central directory listing them, and one end-of-central-directory record.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte range, as ZIP's central directory requires per entry. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** MS-DOS date/time, both fixed: the file's age is not information an export needs to carry. */
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01, the format's own epoch

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const writeUint32LE = (view: DataView, offset: number, value: number) => view.setUint32(offset, value, true);
const writeUint16LE = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true);

/** Builds a valid ZIP archive from stored (uncompressed) entries. */
export const zipStore = (entries: readonly ZipEntry[]): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    writeUint32LE(lv, 0, 0x04034b50); // local file header signature
    writeUint16LE(lv, 4, 20); // version needed
    writeUint16LE(lv, 6, 0); // flags
    writeUint16LE(lv, 8, 0); // method: 0 = stored
    writeUint16LE(lv, 10, DOS_TIME);
    writeUint16LE(lv, 12, DOS_DATE);
    writeUint32LE(lv, 14, crc);
    writeUint32LE(lv, 18, size); // compressed size == size, stored
    writeUint32LE(lv, 22, size);
    writeUint16LE(lv, 26, nameBytes.length);
    writeUint16LE(lv, 28, 0); // extra field length
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralEntry.buffer);
    writeUint32LE(cv, 0, 0x02014b50); // central directory signature
    writeUint16LE(cv, 4, 20); // version made by
    writeUint16LE(cv, 6, 20); // version needed
    writeUint16LE(cv, 8, 0);
    writeUint16LE(cv, 10, 0);
    writeUint16LE(cv, 12, DOS_TIME);
    writeUint16LE(cv, 14, DOS_DATE);
    writeUint32LE(cv, 16, crc);
    writeUint32LE(cv, 20, size);
    writeUint32LE(cv, 24, size);
    writeUint16LE(cv, 28, nameBytes.length);
    writeUint16LE(cv, 30, 0); // extra length
    writeUint16LE(cv, 32, 0); // comment length
    writeUint16LE(cv, 34, 0); // disk number start
    writeUint16LE(cv, 36, 0); // internal attributes
    writeUint32LE(cv, 38, 0); // external attributes
    writeUint32LE(cv, 42, offset); // offset of local header
    centralEntry.set(nameBytes, 46);
    central.push(centralEntry);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  writeUint32LE(ev, 0, 0x06054b50); // end of central directory signature
  writeUint16LE(ev, 4, 0); // disk number
  writeUint16LE(ev, 6, 0); // disk with central directory
  writeUint16LE(ev, 8, entries.length); // entries on this disk
  writeUint16LE(ev, 10, entries.length); // entries total
  writeUint32LE(ev, 12, centralSize);
  writeUint32LE(ev, 16, centralOffset);
  writeUint16LE(ev, 20, 0); // comment length

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
};
