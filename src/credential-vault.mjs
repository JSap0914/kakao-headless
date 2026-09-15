import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes as secureRandomBytes } from 'node:crypto';
import { KeychainVault } from './vault.mjs';

const CONTEXT = 'kakao-headless:credential-vault:v1';
const PAYLOAD_LIMIT = 64 * 1024;
const FILE_LIMIT = 128 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function failure() {
  const error = new Error('Credential storage operation failed.');
  error.code = 'CREDENTIAL_VAULT_ERROR';
  return error;
}
function account(value, root = value) {
  if (!object(value) || !object(root)) throw failure();
  for (const field of ['user_id', 'device_uuid', 'device_type']) {
    if (typeof value[field] !== 'string' || !value[field] || value[field] !== root[field]) throw failure();
  }
  if (typeof value.oauth_token !== 'string' || !value.oauth_token ||
      (value.refresh_token !== undefined && typeof value.refresh_token !== 'string')) throw failure();
  return value;
}
function rootAccount(value) {
  account(value);
  if (Buffer.byteLength(value.oauth_token, 'utf8') < 16) throw failure();
  // Bound even a root returned by a custom vault before processing its context.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PAYLOAD_LIMIT) throw failure();
  return value;
}
function context(root) {
  return Buffer.from(JSON.stringify([CONTEXT, root.user_id, root.device_uuid, root.device_type]), 'utf8');
}
function wrappingKey(root, salt, info) {
  const secret = Buffer.from(root.oauth_token, 'utf8');
  try { return Buffer.from(hkdfSync('sha256', secret, salt, info, 32)); }
  finally { secret.fill(0); }
}
function decode(value, length, max = length) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < length || bytes.length > max) throw failure();
  return bytes;
}
function decrypt(text, root) {
  const record = JSON.parse(text);
  if (!object(record) || record.v !== 1 ||
      Object.keys(record).sort().join(',') !== 'ciphertext,nonce,salt,tag,v') throw failure();
  const salt = decode(record.salt, 32);
  const nonce = decode(record.nonce, 12);
  const tag = decode(record.tag, 16);
  const ciphertext = decode(record.ciphertext, 1, PAYLOAD_LIMIT);
  const info = context(root);
  const key = wrappingKey(root, salt, info);
  let plaintext;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(info);
    cipher.setAuthTag(tag);
    plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    // Reject invalid UTF-8 rather than silently accepting replacement characters.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return account(JSON.parse(text), root);
  } finally { key.fill(0); plaintext?.fill(0); }
}

/**
 * Encrypted local rotation storage backed by an already-readable, immutable
 * Keychain root. This does not modify Keychain ACLs or retry denied mutations.
 * Existing state directories/files must already have private permissions.
 * Atomic replacement prevents partial records; callers must serialize mutations
 * across processes (there is intentionally no claim of cross-process locking).
 */
export class CredentialVault {
  #root;
  #dir;
  #file;
  #random;
  #queue = Promise.resolve();
  constructor({ rootVault = new KeychainVault(), stateDir, randomBytes = secureRandomBytes } = {}) {
    if (typeof stateDir !== 'string' || !stateDir || typeof randomBytes !== 'function') throw failure();
    this.#root = rootVault;
    this.#dir = path.resolve(stateDir);
    this.#file = path.join(this.#dir, 'credentials.enc.json');
    this.#random = randomBytes;
  }
  async get(key = 'account') { return this.#run(() => this.#get(key)); }
  async set(key, value) { return this.#run(() => this.#set(key, value)); }
  async delete(key) { return this.#run(() => this.#delete(key)); }

  #run(operation) {
    const result = this.#queue.then(operation).catch(() => { throw failure(); });
    this.#queue = result.catch(() => {});
    return result;
  }
  async #directory(create = false) {
    if (create) await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    let stat;
    try { stat = await fs.lstat(this.#dir); }
    catch (error) { if (error.code === 'ENOENT' && !create) return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
        (process.getuid && stat.uid !== process.getuid())) throw failure();
    return true;
  }
  async #read() {
    if (!await this.#directory()) return null;
    let handle;
    try {
      handle = await fs.open(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid()) || stat.size > FILE_LIMIT) throw failure();
      // A bounded read also enforces the cap if a file grows after stat().
      const bytes = Buffer.alloc(FILE_LIMIT + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > FILE_LIMIT) throw failure();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
    } finally { await handle.close(); }
  }
  async #load() {
    // Always read Keychain first, including when encrypted local state exists.
    const root = await this.#root.get('account');
    const record = await this.#read();
    if (root == null) {
      if (record !== null) throw failure();
      return { root: null, value: null };
    }
    rootAccount(root);
    return { root, value: record === null ? root : decrypt(record, root) };
  }
  async #get(key) {
    if (key === 'pending') return this.#root.get(key);
    if (key !== 'account') throw failure();
    return (await this.#load()).value;
  }
  async #set(key, value) {
    if (key === 'pending') return this.#root.set(key, value);
    if (key !== 'account') throw failure();
    const { root } = await this.#load();
    // Check both the supplied object and its JSON representation (including toJSON).
    account(value, root ?? value);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > PAYLOAD_LIMIT) throw failure();
    const normalized = account(JSON.parse(serialized), root ?? value);
    if (!root) {
      rootAccount(normalized);
      await this.#root.set('account', normalized);
      return;
    }
    const salt = this.#entropy(32);
    const nonce = this.#entropy(12);
    const info = context(root);
    const wrapping = wrappingKey(root, salt, info);
    const plaintext = Buffer.from(serialized, 'utf8');
    let record;
    try {
      const cipher = createCipheriv('aes-256-gcm', wrapping, nonce);
      cipher.setAAD(info);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      record = JSON.stringify({ v: 1, salt: salt.toString('base64'), nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    } finally { wrapping.fill(0); plaintext.fill(0); }
    await this.#write(record);
  }
  #entropy(size) {
    const bytes = this.#random(size);
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw failure();
    return Buffer.from(bytes);
  }
  async #write(record) {
    await this.#directory(true);
    const temp = path.join(this.#dir, `.credentials-${secureRandomBytes(16).toString('hex')}.tmp`);
    let handle;
    let created = false;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      created = true;
      await handle.writeFile(record, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.#file);
      await this.#syncDirectory();
    } finally {
      await handle?.close();
      if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async #syncDirectory() {
    const handle = await fs.open(this.#dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async #delete(key) {
    if (key === 'pending') return this.#root.delete(key);
    if (key !== 'account') throw failure();
    // Never reveal the stale root by deleting the sidecar before Keychain succeeds.
    await this.#root.delete('account');
    if (await this.#directory()) {
      try { await fs.unlink(this.#file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.#syncDirectory();
    }
  }
}
