import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_IMAGE_BYTES, inspectImageBytes, validateImageMetadata, readImageFile } from '../src/image.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length, 0); typeBytes.copy(result, 4); body.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return result;
}
function png(width = 1, height = 1) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT'), chunk('IEND')]);
}
function jpeg(width = 1, height = 1) {
  const sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const sos = Buffer.from([3, 1, 0, 2, 0, 3, 0, 0x3f, 0]);
  return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xc0,0,sof.length + 2]), sof, Buffer.from([0xff,0xda,0,sos.length + 2]), sos, Buffer.from([0xff,0xd9])]);
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kh-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function rejects(value, code) { return assert.throws(value, { code }); }

test('inspects PNG with generic name and content hashes', () => {
  const data = png(); const image = inspectImageBytes(data);
  assert.deepEqual(image, { kind: 'image', filename: 'image.png', mimeType: 'image/png', width: 1, height: 1, bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), sha1: createHash('sha1').update(data).digest('hex') });
  assert.doesNotThrow(() => validateImageMetadata(image));
});
test('inspects JPEG marker dimensions with generic name', () => {
  assert.deepEqual(inspectImageBytes(jpeg(23, 17)).filename, 'image.jpg');
  const image = inspectImageBytes(jpeg(23, 17)); assert.equal(image.mimeType, 'image/jpeg'); assert.equal(image.width, 23); assert.equal(image.height, 17);
});
test('rejects unsupported, malformed, and truncated image data', () => {
  rejects(() => inspectImageBytes(Buffer.from('GIF89a')), 'IMAGE_UNSUPPORTED_FORMAT');
  rejects(() => inspectImageBytes(png().subarray(0, -1)), 'IMAGE_INVALID_DATA');
  const corrupt = png(); corrupt[20] ^= 1; rejects(() => inspectImageBytes(corrupt), 'IMAGE_INVALID_DATA');
  rejects(() => inspectImageBytes(jpeg().subarray(0, -2)), 'IMAGE_INVALID_DATA');
  rejects(() => inspectImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 'IMAGE_INVALID_DATA');
  rejects(() => inspectImageBytes('not a buffer'), 'IMAGE_INVALID_DATA');
});
test('enforces byte, dimension, and pixel limits', () => {
  assert.equal(inspectImageBytes(png(20_000, 5_000)).width, 20_000);
  rejects(() => inspectImageBytes(png(20_001, 1)), 'IMAGE_TOO_LARGE');
  rejects(() => inspectImageBytes(png(20_000, 5_001)), 'IMAGE_TOO_LARGE');
  rejects(() => inspectImageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1)), 'IMAGE_TOO_LARGE');
});
test('metadata validation requires exact safe metadata', () => {
  const image = inspectImageBytes(png());
  for (const bad of [
    { ...image, filename: 'private-name.png' }, { ...image, mimeType: 'image/jpeg' }, { ...image, width: 0 },
    { ...image, bytes: MAX_IMAGE_BYTES + 1 }, { ...image, sha256: image.sha256.toUpperCase() }, { ...image, sha1: 'x'.repeat(40) },
    { ...image, extra: true }, { ...image, kind: 'file' }
  ]) rejects(() => validateImageMetadata(bad), 'IMAGE_INVALID_METADATA');
});
test('readImageFile snapshots a regular file without retaining its name', async t => {
  const dir = await fixture(t); const file = join(dir, 'sensitive-original-name.png'); const first = png(2, 3); const second = png(4, 5);
  await writeFile(file, first); const result = await readImageFile(file); await writeFile(file, second);
  assert.deepEqual(result.data, first); assert.equal(result.image.filename, 'image.png'); assert.equal(result.image.width, 2); assert.ok(!JSON.stringify(result).includes('sensitive-original-name'));
});
test('readImageFile rejects unavailable, directory, and final symlink files', async t => {
  const dir = await fixture(t); const target = join(dir, 'target.png'); await writeFile(target, png());
  await assert.rejects(readImageFile(join(dir, 'missing.png')), { code: 'IMAGE_FILE_UNAVAILABLE' });
  await assert.rejects(readImageFile(dir), { code: 'IMAGE_FILE_UNAVAILABLE' });
  const link = join(dir, 'link.png'); await symlink(target, link);
  await assert.rejects(readImageFile(link), error => error.code === 'IMAGE_FILE_UNAVAILABLE' && !error.message.includes(dir));
});
test('readImageFile applies its bounded MAX+1 read limit', async t => {
  const dir = await fixture(t); const file = join(dir, 'large.png');
  await writeFile(file, Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES + 1 - png().length)]));
  await assert.rejects(readImageFile(file), { code: 'IMAGE_TOO_LARGE' });
});
