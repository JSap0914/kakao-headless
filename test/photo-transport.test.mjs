import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Long } from 'bson';
import { inspectImageBytes } from '../src/image.mjs';
import { loadPhotoPrimitives, sendPhotoOnce } from '../src/photo-transport.mjs';

// Valid 1x1 PNG, used only as local bytes.
const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const image = inspectImageBytes(data);
const ID = '9007199254740993';
const CHAT = '9007199254740995';
function packet(statusCode, body) { return { statusCode, body }; }
function complete(overrides = {}) { return { ...packet(0, { chatLog: { logId: Long.fromString('9007199254740997'), chatId: Long.fromString(CHAT), authorId: Long.fromString(ID), type: 2, sendAt: 123, attachment: '{"url":"local"}', ...overrides } }), method: 'COMPLETE' };}
function fixture({ ship = packet(0, { k: 'ticket', vh: 'upload.local', p: 999 }), post = packet(0, { o: 0 }), pushed = complete(), pushDelay = 0 } = {}) {
  const calls = { acquire: 0, ship: [], connects: [], packets: [], raw: [], closes: 0 };
  class LocoConnection {
    onPush(handler) { this.handler = handler; }
    async connectSecure(host, port) { calls.connects.push([host, port]); }
    async sendPacket(method, body) { calls.packets.push([method, body]); if (method === 'POST' && pushed) setTimeout(() => this.handler(pushed), pushDelay); return post; }
    async writeRaw(bytes) { calls.raw.push(Buffer.from(bytes)); }
    close() { calls.closes++; }
  }
  const client = { async acquireSession() { calls.acquire++; return { async shipMedia(...args) { calls.ship.push(args); return ship; } }; } };
  return { calls, client, primitives: { LocoConnection, MCCMNC: '99999', getLocoDeviceConfig: () => ({ os: 'mac', appVersion: 'x' }) } };
}
function options(f, extra = {}) { return { primitives: f.primitives, deviceType: 'tablet', ...extra }; }

test('runs exactly one SHIP, connection, POST and raw write', async () => {
  const f = fixture(); const result = await sendPhotoOnce(f.client, ID, CHAT, data, image, options(f));
  assert.deepEqual(result, { statusCode: 0, body: { status: 0, logId: '9007199254740997', chatId: CHAT, photo: { authorId: ID, type: 2, sentAt: 123, attachment: { url: 'local' } } } });
  assert.equal(f.calls.acquire, 1); assert.equal(f.calls.ship.length, 1); assert.equal(f.calls.connects.length, 1); assert.equal(f.calls.packets.length, 1); assert.equal(f.calls.raw.length, 1); assert.equal(f.calls.closes, 1);
  assert.equal(f.calls.ship[0][0].toString(), CHAT); assert.equal(f.calls.ship[0][1], 2); assert.equal(f.calls.ship[0][2], data.length); assert.equal(f.calls.ship[0][3], createHash('sha1').update(data).digest('hex').toUpperCase()); assert.equal(f.calls.ship[0][4], 'png');
});
test('POST offset streams only remaining bytes and prevents invalid offsets', async () => {
  const f = fixture({ post: packet(0, { o: 3 }) }); await sendPhotoOnce(f.client, ID, CHAT, data, image, options(f)); assert.deepEqual(f.calls.raw[0], data.subarray(3));
  const bad = fixture({ post: packet(0, { o: data.length + 1 }) }); await assert.rejects(sendPhotoOnce(bad.client, ID, CHAT, data, image, options(bad)), { code: 'PHOTO_INVALID_RESPONSE' }); assert.equal(bad.calls.raw.length, 0); assert.equal(bad.calls.closes, 1);
});
test('POST rejection does not stream and explicit rejections are status-shaped', async () => {
  const f = fixture({ post: packet(7, { status: 41, o: 0 }) }); assert.deepEqual(await sendPhotoOnce(f.client, ID, CHAT, data, image, options(f)), { statusCode: 7, body: { status: 41 } }); assert.equal(f.calls.raw.length, 0); assert.equal(f.calls.closes, 1);
  const s = fixture({ ship: packet(5, { status: 8 }) }); assert.deepEqual(await sendPhotoOnce(s.client, ID, CHAT, data, image, options(s)), { statusCode: 5, body: { status: 8 } }); assert.equal(s.calls.connects.length, 0);
});
test('timeout closes dedicated connection and does not retry', async () => {
  const f = fixture({ pushed: null }); await assert.rejects(sendPhotoOnce(f.client, ID, CHAT, data, image, options(f, { completeTimeoutMs: 5 })), { code: 'PHOTO_COMPLETE_TIMEOUT' }); assert.equal(f.calls.acquire, 1); assert.equal(f.calls.ship.length, 1); assert.equal(f.calls.packets.length, 1); assert.equal(f.calls.closes, 1);
});
test('rejects unsafe numeric input and malformed COMPLETE without exposing response data', async () => {
  const f = fixture(); await assert.rejects(sendPhotoOnce(f.client, ID, Number(CHAT), data, image, options(f)), { code: 'PHOTO_INVALID_IDENTITY' }); assert.equal(f.calls.acquire, 0);
  const bad = fixture({ pushed: complete({ logId: 42 }) }); await assert.rejects(sendPhotoOnce(bad.client, ID, CHAT, data, image, options(bad)), { code: 'PHOTO_INVALID_RESPONSE' });
});
test('bytes and metadata mismatch fails before acquiring a session', async () => {
  const f = fixture(); const tampered = Buffer.from(data); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(sendPhotoOnce(f.client, ID, CHAT, tampered, image, options(f))); assert.equal(f.calls.acquire, 0);
});
test('optional pinned provider contract imports without network', { skip: process.env.TEST_PROVIDER !== '1' }, async () => {
  const primitives = await loadPhotoPrimitives(); assert.equal(typeof primitives.LocoConnection, 'function'); assert.equal(typeof primitives.getLocoDeviceConfig, 'function'); assert.equal(typeof primitives.MCCMNC, 'string');
});

test('strict positive signed64 IDs and explicit device are required before network', async () => {
  for (const invalid of ['0','01','-1','9223372036854775808',1,{}, {toString:()=>CHAT}]) {
    const f=fixture();await assert.rejects(sendPhotoOnce(f.client, ID, invalid, data, image, options(f)),{code:'PHOTO_INVALID_IDENTITY'});assert.equal(f.calls.acquire,0);
  }
  const f=fixture();await assert.rejects(sendPhotoOnce(f.client, ID, CHAT, data, image, options(f,{deviceType:undefined})),{code:'PHOTO_INVALID_DEVICE'});assert.equal(f.calls.acquire,0);
});
test('BSON promotion accepts safe numeric author and chat echoes but not numeric log IDs', async()=>{
  const {serialize,deserialize}=await import('bson');
  const pushed=deserialize(serialize(complete({chatId:Long.fromString('42'),authorId:Long.fromString('11'),attachment:JSON.stringify({k:'fixture'})})));
  assert.equal(typeof pushed.body.chatLog.chatId,'number');
  const f=fixture({pushed});const r=await sendPhotoOnce(f.client,'11','42',data,image,options(f));assert.equal(r.body.chatId,'42');assert.equal(r.body.photo.authorId,'11');
});
test('malformed completions, wrong recipient/type/author, and status failures never replay',async()=>{
  for(const change of [{chatId:'43'},{authorId:'12'},{type:1},{sendAt:0},{attachment:'not json'},{attachment:[]},{logId:'0'},{logId:'9223372036854775808'}]){
    const f=fixture({pushed:complete(change)});await assert.rejects(sendPhotoOnce(f.client,ID,CHAT,data,image,options(f)),{code:'PHOTO_INVALID_RESPONSE'});assert.equal(f.calls.ship.length,1);assert.equal(f.calls.raw.length,1);assert.equal(f.calls.closes,1);
  }
  const pushed=complete();pushed.body.status=5;const f=fixture({pushed});const r=await sendPhotoOnce(f.client,ID,CHAT,data,image,options(f));assert.equal(r.statusCode,5);assert.equal(f.calls.ship.length,1);
});
test('network exception closes once and never invokes convenience retry methods',async()=>{
  const f=fixture();f.client.sendPhoto=f.client.sendMediaViaLoco=f.client.executeWithReconnect=()=>assert.fail('retry API invoked');
  f.primitives.LocoConnection.prototype.writeRaw=async()=>{throw Error('secret fixture details');};
  await assert.rejects(sendPhotoOnce(f.client,ID,CHAT,data,image,options(f)),{code:'PHOTO_TRANSPORT_FAILED',message:'PHOTO_TRANSPORT_FAILED'});assert.equal(f.calls.ship.length,1);assert.equal(f.calls.packets.length,1);assert.equal(f.calls.closes,1);
});
test('timeout during POST prevents a later byte stream',async()=>{
  const f=fixture({pushed:null});f.primitives.LocoConnection.prototype.sendPacket=async()=>{await new Promise(r=>setTimeout(r,15));return packet(0,{o:0});};
  await assert.rejects(sendPhotoOnce(f.client,ID,CHAT,data,image,options(f,{completeTimeoutMs:5})),{code:'PHOTO_COMPLETE_TIMEOUT'});assert.equal(f.calls.raw.length,0);assert.equal(f.calls.closes,1);
});
