import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Long } from 'bson';
import { inspectImageBytes, validateImageMetadata } from './image.mjs';

const PROVIDER_VERSION = '2.37.1';
const DEFAULT_COMPLETE_TIMEOUT_MS = 60_000;
const requireFromProviderStore = createRequire(import.meta.url);

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function canonicalDecimal(value, { allowSafeNumber = false } = {}) {
  let text;
  if (typeof value === 'string') text = value;
  else if (allowSafeNumber && typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  // bson Long is accepted without coupling to a private provider type.
  else if (value && typeof value === 'object' && value._bsontype === 'Long' && typeof value.toString === 'function') text = value.toString();
  else return null;
  return typeof text === 'string' && /^[1-9][0-9]{0,18}$/.test(text) && BigInt(text) <= 9223372036854775807n ? text : null;
}
function rejectPacket(packet, code) {
  if (!isPlainObject(packet) || !Number.isSafeInteger(packet.statusCode) || !isPlainObject(packet.body)) fail(code);
  if (Object.hasOwn(packet.body, 'status') && !Number.isSafeInteger(packet.body.status)) fail(code);
  const bodyStatus = packet.body.status;
  const statusCode = packet.statusCode !== 0 ? packet.statusCode : (bodyStatus && bodyStatus !== 0 ? bodyStatus : 0);
  if (statusCode === 0) return null;
  return { statusCode, body: Number.isSafeInteger(bodyStatus) ? { status: bodyStatus } : {} };
}
function assertImage(data, image) {
  if (!Buffer.isBuffer(data)) fail('PHOTO_INVALID_IMAGE');
  validateImageMetadata(image);
  let inspected;
  try { inspected = inspectImageBytes(data); } catch { fail('PHOTO_INVALID_IMAGE'); }
  for (const key of ['kind', 'filename', 'mimeType', 'width', 'height', 'bytes', 'sha256', 'sha1']) if (image[key] !== inspected[key]) fail('PHOTO_IMAGE_METADATA_MISMATCH');
  return inspected;
}
function safeNetworkError(error) {
  if (error?.code === 'PHOTO_INVALID_RESPONSE' || error?.code === 'PHOTO_INVALID_IMAGE' || error?.code === 'PHOTO_IMAGE_METADATA_MISMATCH' || error?.code === 'PHOTO_COMPLETE_TIMEOUT') throw error;
  fail('PHOTO_TRANSPORT_FAILED');
}

/**
 * Private-provider coupling, intentionally pinned to agent-messenger 2.37.1.
 * These modules are not barrel exports: resolve package.json first, then load
 * connection/config by file URL. Version, layout, or export changes fail closed.
 */
export async function loadPhotoPrimitives() {
  let packagePath; let packageJson;
  try {
    packagePath = requireFromProviderStore.resolve('agent-messenger/package.json');
    packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(packagePath, 'utf8'));
  } catch { fail('PHOTO_PROVIDER_UNAVAILABLE'); }
  if (packageJson?.name !== 'agent-messenger' || packageJson.version !== PROVIDER_VERSION) fail('PHOTO_PROVIDER_VERSION_MISMATCH');
  const root = new URL('./', pathToFileURL(packagePath));
  try {
    const [connection, config] = await Promise.all([
      import(new URL('./dist/src/platforms/kakaotalk/protocol/connection.js', root).href),
      import(new URL('./dist/src/platforms/kakaotalk/protocol/config.js', root).href)
    ]);
    if (typeof connection.LocoConnection !== 'function' || typeof config.getLocoDeviceConfig !== 'function' || typeof config.MCCMNC !== 'string') fail('PHOTO_PROVIDER_CONTRACT_MISMATCH');
    const pc = config.getLocoDeviceConfig('pc'); const tablet = config.getLocoDeviceConfig('tablet');
    if (!isPlainObject(pc) || !isPlainObject(tablet) || typeof pc.os !== 'string' || typeof pc.appVersion !== 'string' || typeof tablet.os !== 'string' || typeof tablet.appVersion !== 'string') fail('PHOTO_PROVIDER_CONTRACT_MISMATCH');
    return { LocoConnection: connection.LocoConnection, getLocoDeviceConfig: config.getLocoDeviceConfig, MCCMNC: config.MCCMNC };
  } catch (error) { if (error?.code === 'PHOTO_PROVIDER_CONTRACT_MISMATCH') throw error; fail('PHOTO_PROVIDER_CONTRACT_MISMATCH'); }
}

export async function sendPhotoOnce(client, identity, chatId, data, image, options = {}) {
  const checkedImage = assertImage(data, image); // before acquireSession or any network
  if (typeof identity !== 'string' || typeof chatId !== 'string') fail('PHOTO_INVALID_IDENTITY');
  const authorId = canonicalDecimal(identity); const canonicalChatId = canonicalDecimal(chatId);
  if (authorId === null || canonicalChatId === null) fail('PHOTO_INVALID_IDENTITY');
  const deviceType = options.deviceType;
  if (deviceType !== 'pc' && deviceType !== 'tablet') fail('PHOTO_INVALID_DEVICE');
  const completeTimeoutMs = options.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;
  if (!Number.isSafeInteger(completeTimeoutMs) || completeTimeoutMs < 1 || completeTimeoutMs > DEFAULT_COMPLETE_TIMEOUT_MS) fail('PHOTO_INVALID_TIMEOUT');
  const primitives = options.primitives ?? await loadPhotoPrimitives();
  if (!isPlainObject(primitives) || typeof primitives.LocoConnection !== 'function' || typeof primitives.getLocoDeviceConfig !== 'function' || typeof primitives.MCCMNC !== 'string') fail('PHOTO_INVALID_PRIMITIVES');
  const device = primitives.getLocoDeviceConfig(deviceType);
  if (!isPlainObject(device) || typeof device.os !== 'string' || typeof device.appVersion !== 'string') fail('PHOTO_INVALID_PRIMITIVES');
  if (!client || typeof client.acquireSession !== 'function') fail('PHOTO_INVALID_CLIENT');
  let ship;
  try {
    const session = await client.acquireSession();
    if (!session || typeof session.shipMedia !== 'function') fail('PHOTO_INVALID_RESPONSE');
    ship = await session.shipMedia(Long.fromString(canonicalChatId), 2, data.length, createHash('sha1').update(data).digest('hex').toUpperCase(), checkedImage.mimeType === 'image/png' ? 'png' : 'jpg');
  } catch (error) { safeNetworkError(error); }
  const shipRejection = rejectPacket(ship, 'PHOTO_INVALID_RESPONSE'); if (shipRejection) return shipRejection;
  const { k: token, vh: host, p: port } = ship.body;
  if (typeof token !== 'string' || !token || typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('PHOTO_INVALID_RESPONSE');
  let conn; let timer = null; let resolveComplete; let timedOut = false; let closed = false;
  const close = () => { if (!closed && conn) { closed = true; try { conn.close(); } catch {} } };
  const complete = new Promise(resolve => { resolveComplete = resolve; });
  try {
    conn = new primitives.LocoConnection();
    if (!conn || typeof conn.connectSecure !== 'function' || typeof conn.sendPacket !== 'function' || typeof conn.writeRaw !== 'function' || typeof conn.onPush !== 'function' || typeof conn.close !== 'function') fail('PHOTO_INVALID_PRIMITIVES');
    conn.onPush(packet => { if (packet?.method === 'COMPLETE') resolveComplete(packet); });
    await conn.connectSecure(host, port);
    timer = setTimeout(() => { timedOut = true; resolveComplete(null); close(); }, completeTimeoutMs);
    const post = await conn.sendPacket('POST', { k: token, s: data.length, t: 2, u: Long.fromString(authorId), os: device.os, av: device.appVersion, nt: 0, mm: primitives.MCCMNC, f: checkedImage.filename, c: Long.fromString(canonicalChatId), mid: Long.ONE, ns: true, w: checkedImage.width, h: checkedImage.height });
    const postRejection = rejectPacket(post, 'PHOTO_INVALID_RESPONSE'); if (postRejection) return postRejection;
    if (timedOut) fail('PHOTO_COMPLETE_TIMEOUT');
    const offset = post.body.o === undefined ? 0 : post.body.o;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length) fail('PHOTO_INVALID_RESPONSE');
    if (offset < data.length) await conn.writeRaw(Buffer.from(data.subarray(offset)));
    const completed = await complete;
    if (completed === null) fail('PHOTO_COMPLETE_TIMEOUT');
    const completeRejection = rejectPacket(completed, 'PHOTO_INVALID_RESPONSE'); if (completeRejection) return completeRejection;
    if (completed.method !== 'COMPLETE') fail('PHOTO_INVALID_RESPONSE');
    const log = completed.body.chatLog;
    if (!isPlainObject(log)) fail('PHOTO_INVALID_RESPONSE');
    const logId = canonicalDecimal(log.logId); const echoedChatId = canonicalDecimal(log.chatId, { allowSafeNumber: true }); const echoedAuthorId = canonicalDecimal(log.authorId, { allowSafeNumber: true });
    if (logId === null || echoedChatId !== canonicalChatId || echoedAuthorId !== authorId || log.type !== 2 || !Number.isSafeInteger(log.sendAt) || log.sendAt <= 0) fail('PHOTO_INVALID_RESPONSE');
    let attachment; try { attachment = typeof log.attachment === 'string' ? JSON.parse(log.attachment) : log.attachment; } catch { fail('PHOTO_INVALID_RESPONSE'); }
    if (!isPlainObject(attachment)) fail('PHOTO_INVALID_RESPONSE');
    return { statusCode: 0, body: { status: 0, logId, chatId: canonicalChatId, photo: { authorId, type: 2, sentAt: log.sendAt, attachment } } };
  } catch (error) { safeNetworkError(error); }
  finally { if (timer !== null) clearTimeout(timer); close(); }
}
