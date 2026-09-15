import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const TTL = 600_000;
const MAX_ID = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function id(value) {
  // Never coerce numbers: precision may already have been lost by the provider.
  if (value && typeof value === 'object' && value._bsontype === 'Long' && typeof value.toString === 'function') value = value.toString();
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > MAX_ID) fail('INVALID_ID');
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function syncDir(dir) { const h = await fs.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } }
async function atomic(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  let h;
  try {
    h = await fs.open(tmp, 'wx', 0o600);
    await h.writeFile(JSON.stringify(value)); await h.sync(); await h.close(); h = null;
    await fs.rename(tmp, file); await syncDir(path.dirname(file));
  } finally { if (h) await h.close().catch(() => {}); await fs.unlink(tmp).catch(() => {}); }
}

export class SendGuard {
  constructor({ stateDir, transport, now = Date.now }) {
    if (typeof stateDir !== 'string' || typeof now !== 'function') fail('INVALID_CONFIG');
    this.stateDir = path.resolve(stateDir); this.transport = transport; this.now = now;
  }
  async _dir() { await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 }); await fs.chmod(this.stateDir, 0o700); }
  _file(key, kind) { if (typeof key !== 'string' || !UUID.test(key)) fail('INVALID_PREVIEW_ID'); return path.join(this.stateDir, key + '.' + kind + '.json'); }
  _identity() { const v = this.transport?.identity; if (typeof v !== 'string' || !v.trim()) fail('INVALID_ACCOUNT'); return v; }
  _time() { const n = Number(this.now()); if (!Number.isFinite(n)) fail('INVALID_CLOCK'); return n; }
  async _room(chatId) {
    let room, members;
    try { room = await this.transport.getChat(chatId); members = await this.transport.getMembers(chatId); }
    catch { fail('RECIPIENT_LOOKUP_FAILED'); }
    try {
      if (!room || id(room.chat_id) !== chatId || (room.title !== null && typeof room.title !== 'string') || (room.display_name !== null && typeof room.display_name !== 'string') || !Array.isArray(members)) fail('INVALID_RECIPIENT');
      const label = room.title?.trim() || room.display_name?.trim();
      if (!label) fail('INVALID_RECIPIENT');
      const ids = members.map(m => id(m.user_id)).sort();
      if (new Set(ids).size !== ids.length) fail('INVALID_RECIPIENT');
      const fingerprint = hash({ chatId, title: room.title, displayName: room.display_name ?? null, type: room.type ?? null, members: ids });
      return { title: room.title, displayName: room.display_name, type: room.type ?? null, label, memberIds: ids, fingerprint };
    } catch { fail('INVALID_RECIPIENT'); }
  }
  async _read(file, missing) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { fail(e.code === 'ENOENT' ? missing : 'STATE_UNAVAILABLE'); }
  }
  async preview(chatId, text) {
    if (typeof chatId !== 'string') fail('INVALID_ID');
    chatId = id(chatId);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 4000) fail('INVALID_TEXT');
    const identity = this._identity(); const room = await this._room(chatId);
    if (this._identity() !== identity) fail('ACCOUNT_CHANGED');
    const createdAt = this._time(); const previewId = randomUUID();
    const record = { version: 1, previewId, identity, chatId, text, textFingerprint: hash(text), ...room, createdAt, expiresAt: createdAt + TTL };
    try { await this._dir(); await atomic(this._file(previewId, 'preview'), record); }
    catch { fail('STATE_UNAVAILABLE'); }
    return record;
  }
  async receipt(previewId) {
    const receiptFile = this._file(previewId, 'receipt');
    try { return JSON.parse(await fs.readFile(receiptFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') fail('STATE_UNAVAILABLE'); }
    return this._read(this._file(previewId, 'reservation'), 'RECEIPT_NOT_FOUND');
  }
  async send(previewId) {
    const previewFile = this._file(previewId, 'preview');
    const reservation = this._file(previewId, 'reservation');
    // A prior reservation always wins, regardless of its result or age.
    try { await fs.stat(reservation); fail('ALREADY_ATTEMPTED'); }
    catch (e) { if (e.code !== 'ENOENT') { if (e.code === 'ALREADY_ATTEMPTED') throw e; fail('STATE_UNAVAILABLE'); } }
    const p = await this._read(previewFile, 'PREVIEW_NOT_FOUND');
    try {
      if (!p || p.version !== 1 || p.previewId !== previewId ||
          typeof p.chatId !== 'string' || id(p.chatId) !== p.chatId ||
          typeof p.identity !== 'string' || !p.identity.trim() ||
          typeof p.text !== 'string' || !p.text.trim() || Buffer.byteLength(p.text, 'utf8') > 4000 || p.textFingerprint !== hash(p.text) ||
          !Number.isSafeInteger(p.createdAt) || p.createdAt < 0 || !Number.isSafeInteger(p.expiresAt) || p.expiresAt - p.createdAt !== TTL ||
          (p.title !== null && typeof p.title !== 'string') || (p.displayName !== null && typeof p.displayName !== 'string') ||
          !p.label || p.label !== (p.title?.trim() || p.displayName?.trim()) ||
          !Array.isArray(p.memberIds) || p.memberIds.some(v => typeof v !== 'string' || id(v) !== v) ||
          new Set(p.memberIds).size !== p.memberIds.length || JSON.stringify(p.memberIds) !== JSON.stringify([...p.memberIds].sort()) ||
          p.fingerprint !== hash({ chatId: p.chatId, title: p.title, displayName: p.displayName, type: p.type, members: p.memberIds })) fail('INVALID_PREVIEW');
    } catch { fail('INVALID_PREVIEW'); }
    const valid = () => {
      const time = this._time();
      if (!Number.isFinite(p.expiresAt) || time >= p.expiresAt || time < p.createdAt) fail('PREVIEW_EXPIRED');
      if (this._identity() !== p.identity) fail('ACCOUNT_CHANGED');
    };
    valid();
    const current = await this._room(p.chatId);
    if (current.fingerprint !== p.fingerprint) fail('RECIPIENT_CHANGED');
    valid();
    const initial = { previewId, chatId: p.chatId, status: 'unknown', code: 'ATTEMPT_RESERVED', attemptedAt: this._time() };
    let h;
    try {
      h = await fs.open(reservation, 'wx', 0o600);
      await h.writeFile(JSON.stringify(initial)); await h.sync(); await h.close(); h = null;
      await syncDir(this.stateDir);
    } catch (e) {
      if (h) await h.close().catch(() => {});
      fail(e.code === 'EEXIST' ? 'ALREADY_ATTEMPTED' : 'STATE_UNAVAILABLE');
    }
    const save = async (status, code, extra = {}) => {
      const result = { ...initial, status, code, ...extra, updatedAt: this._time() };
      try { await atomic(this._file(previewId, 'receipt'), result); } catch { fail('STATE_UNAVAILABLE'); }
      return result;
    };
    // Reservation stays forever, including failures before the raw write.
    try { valid(); } catch (e) { return save('rejected', e.code); }
    let response;
    try { response = await this.transport.writeOnce(p.chatId, p.text); }
    catch { return save('unknown', 'NETWORK_FAILURE'); }
    let logId;
    try {
      const packetStatus = response?.statusCode;
      const bodyStatus = response?.body?.status;
      if (!Number.isFinite(packetStatus) || (bodyStatus !== undefined && !Number.isFinite(bodyStatus))) return await save('unknown', 'INVALID_RESPONSE');
      if (packetStatus === -1) return await save('unknown', 'NETWORK_FAILURE');
      if (packetStatus !== 0 || (bodyStatus !== undefined && bodyStatus !== 0)) return await save('rejected', 'PROVIDER_REJECTED');
      logId = id(response.body?.logId);
      for (const key of ['chatId', 'chat_id']) {
        if (response.body[key] !== undefined && id(response.body[key]) !== p.chatId) return await save('unknown', 'RESPONSE_CHAT_MISMATCH');
        if (response[key] !== undefined && id(response[key]) !== p.chatId) return await save('unknown', 'RESPONSE_CHAT_MISMATCH');
      }
    } catch (e) { if (e.code === 'STATE_UNAVAILABLE') throw e; return save('unknown', 'INVALID_RESPONSE'); }
    // Persist acceptance before the optional history read.
    await save('accepted_unverified', 'HISTORY_NOT_VERIFIED', { logId });
    let verified = false;
    try {
      if (this._identity() === p.identity) {
        const messages = await this.transport.getMessages(p.chatId);
        verified = this._identity() === p.identity && Array.isArray(messages) && messages.some(m => {
          try { return id(m.log_id) === logId && id(m.author_id) === p.identity && m.message === p.text; } catch { return false; }
        });
      }
    } catch { /* Acceptance stands even if history is unavailable. */ }
    return save(verified ? 'verified' : 'accepted_unverified', verified ? 'HISTORY_MATCH' : 'HISTORY_NOT_VERIFIED', { logId });
  }
}
