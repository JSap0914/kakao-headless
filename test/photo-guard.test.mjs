import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SendGuard } from '../src/guard.mjs';
import { inspectImageBytes } from '../src/image.mjs';

const testPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAElEQVQ1rwYeAAAAAElFTkSuQmCC', 'base64');
const testImage = inspectImageBytes(testPng);
const logId = '9223372036854775807';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-guard-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let clock = 1_000_000;
  let uploads = 0;
  let history = [];
  const stateDir = path.join(base, 'private');
  const photo = () => ({ authorId: '11', type: 2, sentAt: 1000, attachment: { k: 'fixture-key', cs: testImage.sha1.toUpperCase(), s: testImage.bytes, w: testImage.width, h: testImage.height, mt: testImage.mimeType } });
  const matchingHistory = () => ({ log_id: logId, author_id: '11', sent_at: 1000, chat_id: '42', type: 2, attachment: { ...photo().attachment } });
  const transport = {
    identity: '11',
    getChat: async chat_id => ({ chat_id, title: 'Room', display_name: 'Room', type: 'group' }),
    getMembers: async () => [{ user_id: '22' }, { user_id: '11' }],
    writeImageOnce: async (chatId, data, image) => {
      uploads++;
      assert.equal(chatId, '42'); assert.deepEqual(data, testPng); assert.deepEqual(image, testImage);
      return { statusCode: 0, body: { status: 0, logId, chatId: '42', photo: photo() } };
    },
    getMessages: async () => history
  };
  const guard = new SendGuard({ stateDir, transport, now: () => clock });
  const file = path.join(base, 'source-private-name.png');
  await fs.writeFile(file, testPng);
  return { guard, transport, stateDir, file, photo, matchingHistory, uploads: () => uploads, setHistory: value => { history = value; }, advance: n => { clock += n; }, clone: () => new SendGuard({ stateDir, transport, now: () => clock }) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code);
async function preview(f) { return f.guard.previewImage('42', f.file); }

test('previewImage writes a private immutable generic snapshot without source path', async t => {
  const f = await fixture(t); const p = await preview(f);
  const previewFile = path.join(f.stateDir, `${p.previewId}.preview.json`);
  const snapshotFile = path.join(f.stateDir, `${p.previewId}.image.bin`);
  assert.equal(p.version, 2); assert.deepEqual(p.image, testImage); assert.equal(p.image.filename, 'image.png');
  assert.equal((await fs.stat(previewFile)).mode & 0o777, 0o600); assert.equal((await fs.stat(snapshotFile)).mode & 0o777, 0o600);
  const raw = await fs.readFile(previewFile, 'utf8'); assert.ok(!raw.includes('source-private-name')); assert.ok(!raw.includes(f.file));
  await fs.unlink(f.file); assert.deepEqual(await fs.readFile(snapshotFile), testPng);
});
test('source deletion or mutation after preview does not change the uploaded snapshot', async t => {
  const f = await fixture(t); const p = await preview(f); await fs.writeFile(f.file, Buffer.from('changed')); await fs.unlink(f.file); f.setHistory([f.matchingHistory()]);
  const receipt = await f.guard.send(p.previewId); assert.equal(receipt.status, 'verified'); assert.equal(f.uploads(), 1);
});
test('tampered private snapshot fails before any upload', async t => {
  const f = await fixture(t); const p = await preview(f); await fs.writeFile(path.join(f.stateDir, `${p.previewId}.image.bin`), testPng.subarray(0, -1));
  await rejects(f.guard.send(p.previewId), 'IMAGE_SNAPSHOT_UNAVAILABLE'); assert.equal(f.uploads(), 0);
});
test('invalid photo preview metadata fails before any upload', async t => {
  const f = await fixture(t); const p = await preview(f); const file = path.join(f.stateDir, `${p.previewId}.preview.json`); const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.image.filename = 'leaked.png'; await fs.writeFile(file, JSON.stringify(saved));
  await rejects(f.guard.send(p.previewId), 'INVALID_PREVIEW'); assert.equal(f.uploads(), 0);
});
for (const [name, mutate, code] of [
  ['expired', f => f.advance(600000), 'PREVIEW_EXPIRED'],
  ['recipient changed', f => { f.transport.getMembers = async () => [{ user_id: '11' }, { user_id: '33' }]; }, 'RECIPIENT_CHANGED'],
  ['account changed', f => { f.transport.identity = '33'; }, 'ACCOUNT_CHANGED']
]) test(`${name} prevents upload`, async t => { const f = await fixture(t); const p = await preview(f); mutate(f); await rejects(f.guard.send(p.previewId), code); assert.equal(f.uploads(), 0); });
test('reservation is durable before the one upload', async t => {
  const f = await fixture(t); const p = await preview(f); const upload = f.transport.writeImageOnce;
  f.transport.writeImageOnce = async (...args) => { const reservation = JSON.parse(await fs.readFile(path.join(f.stateDir, `${p.previewId}.reservation.json`), 'utf8')); assert.equal(reservation.status, 'unknown'); return upload(...args); };
  f.setHistory([f.matchingHistory()]); await f.guard.send(p.previewId);
});
test('twelve concurrent photo sends make one upload', async t => {
  const f = await fixture(t); const p = await preview(f); f.setHistory([f.matchingHistory()]); const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => f.clone().send(p.previewId)));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.uploads(), 1);
  for (const outcome of outcomes.filter(x => x.status === 'rejected')) assert.equal(outcome.reason.code, 'ALREADY_ATTEMPTED');
});
test('throwing upload remains unknown and is never retried', async t => {
  const f = await fixture(t); const p = await preview(f); f.transport.writeImageOnce = async () => { throw Error('offline source path must not leak'); };
  const receipt = await f.guard.send(p.previewId); assert.equal(receipt.status, 'unknown'); assert.equal(receipt.code, 'NETWORK_FAILURE'); await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED');
});
for (const [name, mutate] of [
  ['checksum', m => { m.attachment.cs = '0'.repeat(40); }], ['type', m => { m.type = 1; }], ['author', m => { m.author_id = '12'; }],
  ['size', m => { m.attachment.s++; }], ['dimensions', m => { m.attachment.w++; }], ['MIME', m => { m.attachment.mt = 'image/jpeg'; }],
  ['key', m => { m.attachment.k = 'other-key'; }], ['time', m => { m.sent_at = 1121; }], ['chat', m => { m.chat_id = '43'; }]
]) test(`strict image history ${name} mismatch is accepted_unverified`, async t => {
  const f = await fixture(t); const p = await preview(f); const message = f.matchingHistory(); mutate(message); f.setHistory([message]);
  const receipt = await f.guard.send(p.previewId); assert.equal(receipt.status, 'accepted_unverified'); assert.equal(receipt.code, 'HISTORY_NOT_VERIFIED'); assert.equal(receipt.imageSha256, testImage.sha256);
});
test('matched image history verifies and receipt retains media evidence across restart', async t => {
  const f = await fixture(t); const p = await preview(f); f.setHistory([f.matchingHistory()]); const receipt = await f.guard.send(p.previewId);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.mediaType, 'image'); assert.equal(receipt.imageSha256, testImage.sha256); assert.equal(receipt.imageKey, 'fixture-key');
  assert.deepEqual(await f.clone().receipt(p.previewId), receipt); await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(f.uploads(), 1);
});
test('read-only reconciliation verifies unknown exact-hash history without another upload', async t => {
  const f = await fixture(t); const p = await preview(f); f.transport.writeImageOnce = async () => ({ statusCode: -1, body: { status: -1 } });
  await f.guard.send(p.previewId); f.setHistory([f.matchingHistory()]); const verification = await f.guard.reconcile(p.previewId, logId);
  assert.equal(verification.status, 'history_verified'); assert.equal(f.uploads(), 0);
});
test('reconciliation rejects bad image hash without another upload', async t => {
  const f = await fixture(t); const p = await preview(f); f.transport.writeImageOnce = async () => ({ statusCode: -1, body: { status: -1 } });
  await f.guard.send(p.previewId); const message = f.matchingHistory(); message.attachment.cs = 'bad'; f.setHistory([message]);
  await rejects(f.guard.reconcile(p.previewId, logId), 'HISTORY_MISMATCH'); assert.equal(f.uploads(), 0);
});
