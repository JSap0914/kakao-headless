import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serialize, deserialize, Long } from 'bson';
import { SendGuard } from '../src/guard.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sendguard-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let clock = 1000000, writes = 0;
  const stateDir = path.join(base, 'private');
  const transport = {
    identity: '11',
    getChat: async chat_id => ({ chat_id, title: 'Room', display_name: 'Room', type: 'group', active_members: 2 }),
    getMembers: async () => [{ user_id: '22', nickname: 'B' }, { user_id: '11', nickname: 'A' }],
    writeOnce: async () => { writes++; return { statusCode: 0, body: { status: 0, logId: '9223372036854775807', chatId: '42' } }; },
    getMessages: async () => [{ log_id: '9223372036854775807', author_id: '11', message: 'hello' }],
  };
  const guard = new SendGuard({ stateDir, transport, now: () => clock });
  return { guard, transport, stateDir, writes: () => writes, advance: n => { clock += n; }, clone: () => new SendGuard({ stateDir, transport, now: () => clock }) };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code && e.message === code);

test('preview preserves exact text, account, sorted IDs, fingerprint and private permissions', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', ' hello\n');
  assert.equal(p.identity, '11'); assert.equal(p.text, ' hello\n');
  assert.deepEqual(p.memberIds, ['11', '22']); assert.equal(p.expiresAt - p.createdAt, 600000);
  const file = path.join(f.stateDir, p.previewId + '.preview.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), p);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.stateDir)).mode & 0o777, 0o700);
  assert.match(p.fingerprint, /^[a-f0-9]{64}$/);
});

test('validates canonical positive signed64 chat IDs and UTF8 byte limit', async t => {
  const { guard } = await fixture(t);
  for (const v of ['0', '-1', '+1', '01', '1.0', '1e3', ' 1', '9223372036854775808', 42, 9007199254740992, null]) await rejects(guard.preview(v, 'hello'), 'INVALID_ID');
  for (const v of ['', ' \n\t', '가'.repeat(1334), 'x'.repeat(4001), null]) await rejects(guard.preview('42', v), 'INVALID_TEXT');
  await guard.preview('9223372036854775807', 'x'.repeat(4000));
  await guard.preview('42', '가'.repeat(1333));
});

test('one write, durable reservation before network, verified receipt and restart duplicate block', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const raw = f.transport.writeOnce;
  f.transport.writeOnce = async (chatId, text) => {
    assert.equal(chatId, '42'); assert.equal(text, 'hello');
    const file = path.join(f.stateDir, p.previewId + '.reservation.json');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'unknown');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    return raw();
  };
  const r = await f.guard.send(p.previewId);
  assert.equal(r.status, 'verified'); assert.equal(r.logId, '9223372036854775807');
  assert.deepEqual(await f.clone().receipt(p.previewId), r);
  assert.equal((await fs.stat(path.join(f.stateDir, p.previewId + '.receipt.json'))).mode & 0o777, 0o600);
  await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(f.writes(), 1);
});

test('concurrent instances reserve exclusively', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => f.clone().send(p.previewId)));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  for (const o of outcomes.filter(o => o.status === 'rejected')) assert.equal(o.reason.code, 'ALREADY_ATTEMPTED');
  assert.equal(f.writes(), 1);
});

for (const [name, mutate, code] of [
  ['expired', f => f.advance(600000), 'PREVIEW_EXPIRED'],
  ['clock rollback', f => f.advance(-1), 'PREVIEW_EXPIRED'],
  ['account changed', f => { f.transport.identity = '33'; }, 'ACCOUNT_CHANGED'],
  ['members changed same count', f => { f.transport.getMembers = async () => [{ user_id: '11' }, { user_id: '33' }]; }, 'RECIPIENT_CHANGED'],
  ['title changed', f => { f.transport.getChat = async chat_id => ({ chat_id, title: 'Other', display_name: 'Room', type: 'group' }); }, 'RECIPIENT_CHANGED'],
]) test(name + ' prevents any write', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello'); mutate(f);
  await rejects(f.guard.send(p.previewId), code); assert.equal(f.writes(), 0);
});

test('member ordering and nicknames do not affect recipient fingerprint', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  f.transport.getMembers = async () => [{ user_id: '11', nickname: 'changed' }, { user_id: '22' }];
  assert.equal((await f.guard.send(p.previewId)).status, 'verified');
});

for (const response of [
  { statusCode: -2, body: { status: 0, logId: '123' } },
  { statusCode: 0, body: { status: 7, logId: '123' } },
]) test('packet or body nonzero status rejects permanently: ' + JSON.stringify(response), async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello'); let count = 0;
  f.transport.writeOnce = async () => { count++; return response; };
  assert.equal((await f.guard.send(p.previewId)).status, 'rejected');
  await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(count, 1);
});

for (const logId of [9007199254740992, 123, '0', '-1', '01', '9223372036854775808', undefined]) test('unsafe or invalid response logId: ' + String(logId), async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  f.transport.writeOnce = async () => ({ statusCode: 0, body: { logId } });
  const r = await f.guard.send(p.previewId); assert.equal(r.status, 'unknown'); assert.equal(r.code, 'INVALID_RESPONSE');
  await rejects(f.guard.send(p.previewId), 'ALREADY_ATTEMPTED');
});

test('accepts bson.Long-compatible exact IDs without numeric coercion', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const long = { _bsontype: 'Long', toString: () => '9223372036854775807', valueOf: () => { throw new Error('must not coerce'); } };
  f.transport.writeOnce = async () => ({ statusCode: 0, body: { logId: long } });
  assert.equal((await f.guard.send(p.previewId)).status, 'verified');
});

for (const chatId of ['43', 43, 0, -1, 42.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) test('optional echoed chatId must match exactly: ' + JSON.stringify(chatId), async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  f.transport.writeOnce = async () => ({ statusCode: 0, body: { logId: '123', chatId } });
  assert.equal((await f.guard.send(p.previewId)).status, 'unknown');
});

for (const message of [
  { log_id: '9', author_id: '11', message: 'hello' },
  { log_id: '9223372036854775807', author_id: '22', message: 'hello' },
  { log_id: '9223372036854775807', author_id: '11', message: 'hello ' },
  { log_id: 9223372036854775807, author_id: '11', message: 'hello' },
]) test('history mismatch remains accepted_unverified: ' + JSON.stringify(message), async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  f.transport.getMessages = async () => [message];
  const r = await f.guard.send(p.previewId); assert.equal(r.status, 'accepted_unverified');
  assert.equal('delivered' in r, false); assert.equal('read' in r, false);
});

test('network exception is sanitized unknown and never retried', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello'); let count = 0;
  f.transport.writeOnce = async () => { count++; throw new Error('SECRET provider token'); };
  const r = await f.guard.send(p.previewId);
  assert.equal(r.status, 'unknown'); assert.equal(r.code, 'NETWORK_FAILURE');
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
  await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(count, 1);
});

test('history failure preserves acceptance and sanitized receipt', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  f.transport.getMessages = async () => { assert.equal((await f.guard.receipt(p.previewId)).status, 'accepted_unverified'); throw new Error('SECRET'); };
  assert.equal((await f.guard.send(p.previewId)).status, 'accepted_unverified');
});

test('orphan reservation prevents restart retry', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const r = { previewId: p.previewId, status: 'unknown', code: 'ATTEMPT_RESERVED' };
  await fs.writeFile(path.join(f.stateDir, p.previewId + '.reservation.json'), JSON.stringify(r), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await f.guard.receipt(p.previewId), r);
  await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(f.writes(), 0);
});

test('lookup errors and path traversal expose only safe codes', async t => {
  const f = await fixture(t);
  await rejects(f.guard.send('../secret'), 'INVALID_PREVIEW_ID');
  await rejects(f.guard.receipt('../secret'), 'INVALID_PREVIEW_ID');
  f.transport.getChat = async () => { throw new Error('SECRET'); };
  await rejects(f.guard.preview('42', 'hello'), 'RECIPIENT_LOOKUP_FAILED');
});

test('null transport permits offline receipts and safely blocks online methods', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const offline = new SendGuard({ stateDir: f.stateDir, transport: null, now: () => p.createdAt });
  await rejects(offline.preview('42', 'hello'), 'INVALID_ACCOUNT');
  await rejects(offline.send(p.previewId), 'INVALID_ACCOUNT');
  await rejects(offline._room('42'), 'RECIPIENT_LOOKUP_FAILED');
  assert.deepEqual(await f.guard.send(p.previewId), await offline.receipt(p.previewId));
});

test('nullable room names provide meaningful labels and retain raw title fingerprint', async t => {
  const f = await fixture(t);
  f.transport.getChat = async chat_id => ({ chat_id, title: null, display_name: ' Alice ', type: 'direct' });
  const p = await f.guard.preview('42', 'hello');
  assert.equal(p.title, null); assert.equal(p.label, 'Alice');
  assert.equal((await f.guard.send(p.previewId)).status, 'verified');
  const p2 = await f.guard.preview('42', 'hello');
  f.transport.getChat = async chat_id => ({ chat_id, title: '', display_name: ' Alice ', type: 'direct' });
  await rejects(f.guard.send(p2.previewId), 'RECIPIENT_CHANGED');
  f.transport.getChat = async chat_id => ({ chat_id, title: 'Group', display_name: null });
  const p3 = await f.guard.preview('42', 'hello'); assert.equal(p3.label, 'Group');
  assert.equal((await f.guard.send(p3.previewId)).status, 'verified');
});

for (const [title, display_name] of [[null, null], ['', '  '], [' ', null], [null, 123], [123, 'Alice']]) test('invalid room labels ' + JSON.stringify([title, display_name]), async t => {
  const f = await fixture(t);
  f.transport.getChat = async chat_id => ({ chat_id, title, display_name });
  await rejects(f.guard.preview('42', 'hello'), 'INVALID_RECIPIENT');
});

for (const [name, response] of [
  ['disconnect', { statusCode: -1, body: { logId: '123' } }],
  ['absent packet', { body: { logId: '123' } }],
  ['null packet', { statusCode: null, body: { logId: '123' } }],
  ['string packet', { statusCode: '0', body: { logId: '123' } }],
  ['infinite packet', { statusCode: Infinity, body: { logId: '123' } }],
  ['NaN packet', { statusCode: NaN, body: { logId: '123' } }],
  ['null body status', { statusCode: 0, body: { status: null, logId: '123' } }],
  ['string body status', { statusCode: 0, body: { status: '0', logId: '123' } }],
  ['infinite body status', { statusCode: 0, body: { status: Infinity, logId: '123' } }],
  ['NaN body status', { statusCode: 0, body: { status: NaN, logId: '123' } }],
  ['fractional packet', { statusCode: 0.5, body: { logId: '123' } }],
  ['fractional body', { statusCode: 0, body: { status: -0.5, logId: '123' } }],
  ['unsafe packet', { statusCode: Number.MAX_SAFE_INTEGER + 1, body: { logId: '123' } }],
  ['absent response', undefined],
]) test('unknown and permanently reserved: ' + name, async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello'); let count = 0;
  f.transport.writeOnce = async () => { count++; return response; };
  const r = await f.guard.send(p.previewId); assert.equal(r.status, 'unknown');
  assert.equal(r.code, name === 'disconnect' ? 'NETWORK_FAILURE' : 'INVALID_RESPONSE');
  await rejects(f.clone().send(p.previewId), 'ALREADY_ATTEMPTED'); assert.equal(count, 1);
});

for (const [name, patch] of [
  ['version', p => { p.version = 2; }],
  ['missing version', p => { delete p.version; }],
  ['createdAt string', p => { p.createdAt = String(p.createdAt); }],
  ['expiresAt null', p => { p.expiresAt = null; }],
  ['extended TTL', p => { p.expiresAt++; }],
  ['missing createdAt', p => { delete p.createdAt; }],
  ['negative time', p => { p.createdAt = -1; p.expiresAt = 599999; }],
  ['fractional time', p => { p.createdAt += 0.5; p.expiresAt += 0.5; }],
  ['unsafe chat ID', p => { p.chatId = '9223372036854775808'; }],
  ['numeric chat ID', p => { p.chatId = 42; }],
  ['invalid member ID', p => { p.memberIds[0] = '0'; }],
  ['blank identity', p => { p.identity = ' '; }],
  ['empty text', p => { p.text = ''; }],
  ['whitespace text', p => { p.text = ' \n'; }],
  ['oversized UTF8 text', p => { p.text = '가'.repeat(1334); }],
  ['wrong preview ID', p => { p.previewId = 'wrong'; }],
  ['wrong label', p => { p.label = 'Wrong'; }],
]) test('saved preview edits rejected before lookup/write: ' + name, async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello'), key = p.previewId;
  patch(p);
  // Recomputing text hash must not bypass text validation.
  const { createHash } = await import('node:crypto');
  p.textFingerprint = createHash('sha256').update(JSON.stringify(p.text)).digest('hex');
  await fs.writeFile(path.join(f.stateDir, key + '.preview.json'), JSON.stringify(p));
  let lookups = 0; f.transport.getChat = async () => { lookups++; throw new Error('should not look up'); };
  await rejects(f.guard.send(key), 'INVALID_PREVIEW'); assert.equal(f.writes(), 0); assert.equal(lookups, 0);
});

for (const key of ['chatId', 'chat_id']) for (const location of ['body', 'packet']) {
  test('BSON promotes safe echoed ' + location + '.' + key + ' but preserves large logId Long', async t => {
    const f = await fixture(t), p = await f.guard.preview('42', 'hello');
    const wire = { statusCode: 0, body: { status: 0, logId: Long.fromString('9223372036854775807') } };
    (location === 'body' ? wire.body : wire)[key] = Long.fromString('42');
    const decoded = deserialize(serialize(wire));
    assert.equal((location === 'body' ? decoded.body : decoded)[key], 42);
    assert.ok(Long.isLong(decoded.body.logId));
    f.transport.writeOnce = async () => decoded;
    assert.equal((await f.guard.send(p.previewId)).status, 'verified');
  });
}
test('BSON promoted numeric logId is still rejected', async t => {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const decoded = deserialize(serialize({ statusCode: 0, body: { logId: Long.fromString('123'), chatId: Long.fromString('42') } }));
  assert.equal(decoded.body.logId, 123);
  f.transport.writeOnce = async () => decoded;
  assert.equal((await f.guard.send(p.previewId)).code, 'INVALID_RESPONSE');
});
for (const chatId of [String(Number.MAX_SAFE_INTEGER), '9007199254740993']) test('BSON exact boundary chat ID ' + chatId, async t => {
  const f = await fixture(t), p = await f.guard.preview(chatId, 'hello');
  f.transport.writeOnce = async () => deserialize(serialize({ statusCode: 0, body: { logId: Long.fromString('9223372036854775807'), chatId: Long.fromString(chatId) } }));
  assert.equal((await f.guard.send(p.previewId)).status, 'verified');
});

const reconcileLog = '9223372036854775807';
async function reconciliationFixture(t, receipt = true) {
  const f = await fixture(t), p = await f.guard.preview('42', 'hello');
  const reservation = { previewId: p.previewId, chatId: p.chatId, status: 'unknown', code: 'ATTEMPT_RESERVED', attemptedAt: p.createdAt + 501 };
  const original = { ...reservation, code: 'INVALID_RESPONSE', updatedAt: p.createdAt + 502 };
  const file = kind => path.join(f.stateDir, p.previewId + '.' + kind + '.json');
  await fs.writeFile(file('reservation'), JSON.stringify(reservation), { flag: 'wx', mode: 0o600 });
  if (receipt) await fs.writeFile(file('receipt'), JSON.stringify(original), { flag: 'wx', mode: 0o600 });
  f.advance(700000); // Expired preview still supplies immutable historical evidence.
  let forbidden = 0;
  f.transport.writeOnce = async () => { forbidden++; throw new Error('forbidden WRITE'); };
  f.transport.acquireSession = async () => { forbidden++; throw new Error('forbidden reacquire'); };
  t.after(() => assert.equal(forbidden, 0));
  const message = { log_id: reconcileLog, author_id: '11', message: 'hello', type: 1, sent_at: 1001 };
  f.transport.getMessages = async (chatId, options) => { assert.equal(chatId, '42'); assert.deepEqual(options, { count: 200 }); return [message]; };
  return { ...f, p, file, reservation, original: receipt ? original : reservation, message };
}

test('reconciliation preserves originals, persists separate verification and offline receipt, and never unlocks send', async t => {
  const f = await reconciliationFixture(t);
  const before = await Promise.all(['preview', 'reservation', 'receipt'].map(k => fs.readFile(f.file(k), 'utf8')));
  const v = await f.guard.reconcile(f.p.previewId, reconcileLog);
  assert.deepEqual(v, { status: 'history_verified', code: 'HISTORY_RECONCILED', logId: reconcileLog, chatId: '42', checkedAt: 1700000, originalStatus: 'unknown', originalCode: 'INVALID_RESPONSE' });
  assert.deepEqual(await Promise.all(['preview', 'reservation', 'receipt'].map(k => fs.readFile(f.file(k), 'utf8'))), before);
  assert.equal((await fs.stat(f.file('verification'))).mode & 0o777, 0o600);
  const offline = new SendGuard({ stateDir: f.stateDir, transport: null });
  assert.deepEqual(await offline.receipt(f.p.previewId), { ...f.original, verification: v });
  f.transport.getMessages = async () => { throw new Error('must use existing verification'); };
  f.advance(1000);
  assert.deepEqual(await f.clone().reconcile(f.p.previewId, reconcileLog), v);
  assert.deepEqual(await offline.receipt(f.p.previewId), { ...f.original, verification: v });
  await rejects(f.guard.reconcile(f.p.previewId, '123'), 'VERIFICATION_LOG_MISMATCH');
  await rejects(f.clone().send(f.p.previewId), 'ALREADY_ATTEMPTED');
});

test('reservation alone reconciles without creating a base receipt', async t => {
  const f = await reconciliationFixture(t, false);
  const v = await f.guard.reconcile(f.p.previewId, reconcileLog);
  assert.equal(v.originalCode, 'ATTEMPT_RESERVED');
  await assert.rejects(fs.stat(f.file('receipt')), { code: 'ENOENT' });
  assert.deepEqual(await f.guard.receipt(f.p.previewId), { ...f.reservation, verification: v });
});

for (const [name, mutate, code] of [
  ['wrong sender', f => { f.message.author_id = '22'; }, 'HISTORY_MISMATCH'],
  ['numeric sender', f => { f.message.author_id = 11; }, 'HISTORY_MISMATCH'],
  ['wrong text', f => { f.message.message = 'hello '; }, 'HISTORY_MISMATCH'],
  ['old lookalike', f => { f.message.sent_at = 999; }, 'HISTORY_MISMATCH'],
  ['too late', f => { f.message.sent_at = 1122; }, 'HISTORY_MISMATCH'],
  ['fractional time', f => { f.message.sent_at = 1001.5; }, 'HISTORY_MISMATCH'],
  ['missing time', f => { delete f.message.sent_at; }, 'HISTORY_MISMATCH'],
  ['string time', f => { f.message.sent_at = '1001'; }, 'HISTORY_MISMATCH'],
  ['wrong type', f => { f.message.type = 2; }, 'HISTORY_MISMATCH'],
  ['string type', f => { f.message.type = '1'; }, 'HISTORY_MISMATCH'],
  ['missing type', f => { delete f.message.type; }, 'HISTORY_MISMATCH'],
  ['wrong log', f => { f.message.log_id = '123'; }, 'HISTORY_NOT_FOUND'],
  ['numeric log', f => { f.message.log_id = Number(reconcileLog); }, 'HISTORY_NOT_FOUND'],
  ['unsafe string log', f => { f.message.log_id = '9223372036854775808'; }, 'HISTORY_NOT_FOUND'],
  ['wrong message chat', f => { f.message.chat_id = '43'; }, 'HISTORY_MISMATCH'],
  ['wrong account', f => { f.transport.identity = '33'; }, 'ACCOUNT_CHANGED'],
  ['changed recipient', f => { f.transport.getMembers = async () => [{ user_id: '33' }]; }, 'RECIPIENT_CHANGED'],
  ['account changes during history', f => { f.transport.getMessages = async () => { f.transport.identity = '33'; return [f.message]; }; }, 'ACCOUNT_CHANGED'],
  ['account changes during room lookup', f => { const original = f.transport.getChat; f.transport.getChat = async chat => { f.transport.identity = '33'; return original(chat); }; }, 'ACCOUNT_CHANGED'],
  ['no messages', f => { f.transport.getMessages = async () => []; }, 'HISTORY_NOT_FOUND'],
  ['ambiguous messages', f => { f.transport.getMessages = async () => [f.message, { ...f.message }]; }, 'HISTORY_AMBIGUOUS'],
  ['conflicting duplicate', f => { f.transport.getMessages = async () => [f.message, { ...f.message, message: 'other' }]; }, 'HISTORY_AMBIGUOUS'],
  ['history error', f => { f.transport.getMessages = async () => { throw new Error('private'); }; }, 'HISTORY_UNAVAILABLE'],
  ['invalid history', f => { f.transport.getMessages = async () => null; }, 'HISTORY_UNAVAILABLE'],
  ['missing reservation', f => fs.unlink(f.file('reservation')), 'RESERVATION_NOT_FOUND'],
  ['missing preview', f => fs.unlink(f.file('preview')), 'PREVIEW_NOT_FOUND'],
  ['bad preview hash', f => fs.writeFile(f.file('preview'), JSON.stringify({ ...f.p, text: 'other' })), 'INVALID_PREVIEW'],
  ['bad room hash', f => fs.writeFile(f.file('preview'), JSON.stringify({ ...f.p, fingerprint: 'bad' })), 'INVALID_PREVIEW'],
  ['reservation wrong chat', f => fs.writeFile(f.file('reservation'), JSON.stringify({ ...f.reservation, chatId: '43' })), 'INVALID_RESERVATION'],
  ['reservation missing time', f => fs.writeFile(f.file('reservation'), JSON.stringify({ ...f.reservation, attemptedAt: null })), 'INVALID_RESERVATION'],
  ['reservation fractional time', f => fs.writeFile(f.file('reservation'), JSON.stringify({ ...f.reservation, attemptedAt: 1000000.5 })), 'INVALID_RESERVATION'],
]) test('reconciliation fails closed: ' + name, async t => {
  const f = await reconciliationFixture(t); await mutate(f);
  await rejects(f.guard.reconcile(f.p.previewId, reconcileLog), code);
  await assert.rejects(fs.stat(f.file('verification')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(f.file('receipt'), 'utf8')), f.original);
});
for (const sent_at of [1000, 1121]) test('reconciliation accepts inclusive second boundary ' + sent_at, async t => {
  const f = await reconciliationFixture(t); f.message.sent_at = sent_at;
  assert.equal((await f.guard.reconcile(f.p.previewId, reconcileLog)).status, 'history_verified');
});
for (const value of [123, Number(reconcileLog), '0', '01', '9223372036854775808', undefined]) test('reconciliation explicit log ID stays exact: ' + value, async t => {
  const f = await reconciliationFixture(t);
  await rejects(f.guard.reconcile(f.p.previewId, value), 'INVALID_ID');
});
test('repeated verification still rejects account or recipient changes', async t => {
  const f = await reconciliationFixture(t);
  await f.guard.reconcile(f.p.previewId, reconcileLog);
  f.transport.identity = '33';
  await rejects(f.guard.reconcile(f.p.previewId, reconcileLog), 'ACCOUNT_CHANGED');
  f.transport.identity = '11'; f.transport.getMembers = async () => [];
  await rejects(f.guard.reconcile(f.p.previewId, reconcileLog), 'RECIPIENT_CHANGED');
});

test('reconciliation accepts a BSON-decoded large Long history log without numeric coercion', async t => {
  const f = await reconciliationFixture(t);
  const decoded = deserialize(serialize({ ...f.message, log_id: Long.fromString(reconcileLog) }));
  assert.ok(Long.isLong(decoded.log_id));
  f.transport.getMessages = async () => [decoded];
  assert.equal((await f.guard.reconcile(f.p.previewId, reconcileLog)).logId, reconcileLog);
});
test('malformed base receipt fails closed without verification', async t => {
  const f = await reconciliationFixture(t);
  await fs.writeFile(f.file('receipt'), 'null');
  await rejects(f.guard.reconcile(f.p.previewId, reconcileLog), 'STATE_UNAVAILABLE');
  await assert.rejects(fs.stat(f.file('verification')), { code: 'ENOENT' });
});
