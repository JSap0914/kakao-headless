import { promises as fs, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 20_000;
const MAX_PIXELS = 100_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_MIME = 'image/png';
const JPEG_MIME = 'image/jpeg';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function checkedDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('IMAGE_INVALID_DATA');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) fail('IMAGE_TOO_LARGE');
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(data) {
  if (data.length < 8 + 12) fail('IMAGE_INVALID_DATA');
  let offset = 8;
  let width;
  let height;
  let chunks = 0;
  let idat = false;
  while (offset < data.length) {
    if (data.length - offset < 12) fail('IMAGE_INVALID_DATA');
    const length = data.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > data.length) fail('IMAGE_INVALID_DATA');
    const type = data.toString('ascii', typeStart, typeStart + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('IMAGE_INVALID_DATA');
    if (data.readUInt32BE(dataEnd) !== crc32(data, typeStart, dataEnd)) fail('IMAGE_INVALID_DATA');
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) fail('IMAGE_INVALID_DATA');
      width = data.readUInt32BE(dataStart);
      height = data.readUInt32BE(dataStart + 4);
      checkedDimensions(width, height);
    } else if (type === 'IHDR') {
      fail('IMAGE_INVALID_DATA');
    }
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') {
      if (length !== 0 || !idat || crcEnd !== data.length) fail('IMAGE_INVALID_DATA');
      return { width, height };
    }
    offset = crcEnd;
    chunks++;
  }
  fail('IMAGE_INVALID_DATA');
}

function inspectJpeg(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) fail('IMAGE_INVALID_DATA');
  let offset = 2;
  let width;
  let height;
  let sawScan = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) fail('IMAGE_INVALID_DATA');
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) fail('IMAGE_INVALID_DATA');
    const marker = data[offset++];
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) fail('IMAGE_INVALID_DATA');
    if (marker === 0xd9) {
      if (!sawScan || width === undefined || offset !== data.length) fail('IMAGE_INVALID_DATA');
      return { width, height };
    }
    if (offset + 2 > data.length) fail('IMAGE_INVALID_DATA');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) fail('IMAGE_INVALID_DATA');
    const segment = offset + 2;
    const end = offset + length;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (width !== undefined || length < 8) fail('IMAGE_INVALID_DATA');
      const components = data[segment + 5];
      if (components < 1 || length !== 8 + components * 3) fail('IMAGE_INVALID_DATA');
      height = data.readUInt16BE(segment + 1);
      width = data.readUInt16BE(segment + 3);
      checkedDimensions(width, height);
    }
    if (marker === 0xda) {
      if (width === undefined || length < 8) fail('IMAGE_INVALID_DATA');
      sawScan = true;
      // Header validation only: entropy coding is not decoded. An EOI marker is still required.
      for (let i = end; i + 1 < data.length; i++) {
        if (data[i] !== 0xff) continue;
        let next = i + 1;
        while (next < data.length && data[next] === 0xff) next++;
        if (next >= data.length) break;
        if (data[next] === 0x00 || (data[next] >= 0xd0 && data[next] <= 0xd7)) { i = next; continue; }
        if (data[next] === 0xd9) {
          if (next + 1 !== data.length) fail('IMAGE_INVALID_DATA');
          return { width, height };
        }
        // Later scans and tables are not decoded; SOF dimensions above remain authoritative.
        i = next;
      }
      fail('IMAGE_INVALID_DATA');
    }
    offset = end;
  }
  fail('IMAGE_INVALID_DATA');
}

export function inspectImageBytes(data) {
  if (!Buffer.isBuffer(data)) fail('IMAGE_INVALID_DATA');
  if (data.length > MAX_IMAGE_BYTES) fail('IMAGE_TOO_LARGE');
  let mimeType;
  let dimensions;
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    mimeType = PNG_MIME;
    dimensions = inspectPng(data);
  } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    mimeType = JPEG_MIME;
    dimensions = inspectJpeg(data);
  } else {
    fail('IMAGE_UNSUPPORTED_FORMAT');
  }
  return {
    kind: 'image',
    filename: mimeType === PNG_MIME ? 'image.png' : 'image.jpg',
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    sha1: createHash('sha1').update(data).digest('hex')
  };
}

export function validateImageMetadata(image) {
  try {
    if (!image || typeof image !== 'object' || Object.getPrototypeOf(image) !== Object.prototype) fail('IMAGE_INVALID_METADATA');
    const expected = ['kind', 'filename', 'mimeType', 'width', 'height', 'bytes', 'sha256', 'sha1'];
    if (Object.keys(image).length !== expected.length || expected.some(key => !Object.hasOwn(image, key))) fail('IMAGE_INVALID_METADATA');
    if (image.kind !== 'image' || ![PNG_MIME, JPEG_MIME].includes(image.mimeType) ||
        image.filename !== (image.mimeType === PNG_MIME ? 'image.png' : 'image.jpg') ||
        !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 ||
        !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES ||
        typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256) ||
        typeof image.sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(image.sha1)) fail('IMAGE_INVALID_METADATA');
    if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) fail('IMAGE_INVALID_METADATA');
  } catch { fail('IMAGE_INVALID_METADATA'); }
}

export async function readImageFile(file) {
  if (typeof file !== 'string' || !file) fail('IMAGE_FILE_UNAVAILABLE');
  let handle;
  let data;
  try {
    const before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile()) fail('IMAGE_FILE_UNAVAILABLE');
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) fail('IMAGE_FILE_UNAVAILABLE');
    const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    data = Buffer.from(buffer.subarray(0, total));
  } catch (error) {
    if (error?.code === 'IMAGE_FILE_UNAVAILABLE') throw error;
    fail('IMAGE_FILE_UNAVAILABLE');
  } finally {
    await handle?.close().catch(() => {});
  }
  return { data, image: inspectImageBytes(data) };
}
