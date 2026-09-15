import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Long } from 'bson';
import { sendPhotoOnce } from './photo-transport.mjs';

export const SUPPORTED_VERSION = '2.37.1';
export function fail(code) { const e = new Error(code); e.code = code; throw e; }
export function validId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_ID');
  return value;
}
export function validAccount(a) {
  if (!a || typeof a.oauth_token !== 'string' || !a.oauth_token || typeof a.device_uuid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(a.device_uuid) || !['pc','tablet'].includes(a.device_type)) fail('INVALID_CREDENTIALS');
  validId(a.user_id);
  // Upstream CHECKIN currently coerces user IDs to Number. Fail rather than round.
  if (BigInt(a.user_id) > BigInt(Number.MAX_SAFE_INTEGER)) fail('UNSUPPORTED_USER_ID');
  return a;
}
export async function loadProvider() {
  try {
    const require = createRequire(import.meta.url);
    const metadata = JSON.parse(await readFile(require.resolve('agent-messenger/package.json'), 'utf8'));
    if (metadata.version !== SUPPORTED_VERSION) fail('PROVIDER_VERSION_MISMATCH');
    return await import('agent-messenger/kakaotalk');
  } catch (e) {
    if (e.code === 'PROVIDER_VERSION_MISMATCH') throw e;
    fail('PROVIDER_NOT_INSTALLED');
  }
}

export class LocoTransport {
  constructor(client, identity, options = {}) { this.client = client; this.identity = validId(identity); this.deviceType = options.deviceType ?? client.deviceType; }
  static async connect({ account, stateDir, provider }) {
    validAccount(account);
    const sdk = provider ?? await loadProvider();
    const cacheDir = join(stateDir, 'provider-cache');
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    // Isolate sync metadata from any existing agent-messenger login.
    process.env.AGENT_MESSENGER_CONFIG_DIR = cacheDir;
    const client = new sdk.KakaoTalkClient();
    try {
      await client.login({ oauthToken: account.oauth_token, userId: account.user_id, deviceUuid: account.device_uuid, deviceType: account.device_type });
      await client.acquireSession();
      return new LocoTransport(client, account.user_id, { deviceType: account.device_type });
    } catch { client.close(); fail('PROVIDER_LOGIN_FAILED'); }
  }
  async listChats(search) { return this.client.getChats({ all: true, search, resolveTitles: true }); }
  async getChat(chatId) { return this.client.getChat(validId(chatId)); }
  async getMembers(chatId) {
    const snapshot = await this.client.getMemberSnapshot(validId(chatId));
    if (snapshot.complete !== true || snapshot.chat_id !== chatId || snapshot.members.length !== snapshot.active_members) fail('INCOMPLETE_MEMBERS');
    for (const m of snapshot.members) validId(m.user_id);
    return snapshot.members;
  }
  async getMessages(chatId, options = {}) {
    const count = options.count ?? 30;
    if (!Number.isInteger(count) || count < 1 || count > 200) fail('INVALID_COUNT');
    if (options.from !== undefined) validId(options.from);
    validId(chatId);
    // The strict page API checks both packet and body status. The convenience
    // getMessages API can swallow transport failures and look like an empty room.
    let cursor = options.from;
    const rows = new Map();
    for (let i = 0; i < 50; i++) {
      const page = await this.client.getMessagePage(chatId, { count: 100, from: cursor });
      if (!Array.isArray(page.messages) || typeof page.complete !== 'boolean') fail('INVALID_HISTORY_PAGE');
      for (const row of page.messages) {
        const author = typeof row.author_id === 'number' && Number.isSafeInteger(row.author_id) && row.author_id > 0 ? String(row.author_id) : row.author_id;
        // Normalize only safe numeric user IDs. Never round chat/log IDs.
        rows.set(validId(row.log_id), author === undefined ? row : { ...row, author_id: author });
      }
      if (page.complete) return [...rows.values()].sort((a,b) => BigInt(a.log_id) < BigInt(b.log_id) ? -1 : 1).slice(-count);
      if (!page.next_cursor || page.next_cursor === cursor) fail('INCOMPLETE_HISTORY');
      cursor = validId(page.next_cursor);
    }
    fail('HISTORY_LIMIT_REACHED');
  }
  async writeOnce(chatId, text) {
    validId(chatId);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4000) fail('INVALID_TEXT');
    // Do NOT use client.sendMessage: executeWithReconnect can replay WRITE.
    // acquireSession may connect, but the raw session call below is invoked once.
    const session = await this.client.acquireSession();
    return session.sendMessage(Long.fromString(chatId), text);
  }
  async writeImageOnce(chatId, data, image) {
    return sendPhotoOnce(this.client, this.identity, validId(chatId), data, image, { deviceType: this.deviceType });
  }
  close() { this.client.close(); }
}
