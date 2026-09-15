import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./keychain.swift', import.meta.url));
const LIMIT = 1024 * 1024;
const TIMEOUT = 60_000;
const ACCOUNTS = new Set(['account', 'pending']);
const MESSAGES = Object.freeze({
  UNSUPPORTED_PLATFORM: 'Keychain storage requires macOS.',
  INVALID_KEY: 'Unsupported vault account.',
  INVALID_VALUE: 'Vault value must be a JSON object.',
  INPUT_TOO_LARGE: 'Vault request exceeds the size limit.',
  OUTPUT_TOO_LARGE: 'Keychain helper output exceeds the size limit.',
  KEYCHAIN_TIMEOUT: 'Keychain helper timed out.',
  KEYCHAIN_ERROR: 'Keychain operation failed.',
  INVALID_RESPONSE: 'Keychain helper returned an invalid response.',
});
function failure(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.KEYCHAIN_ERROR);
  error.code = Object.hasOwn(MESSAGES, code) ? code : 'KEYCHAIN_ERROR';
  return error;
}
const objectValue = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Internal transport; exported for tests with a fake spawn implementation. */
export function createKeychainRunner(spawnImpl = spawn) {
  return (command, args, options) => new Promise((resolve, reject) => {
    let child;
    let timer;
    let finished = false;
    let bytes = 0;
    const chunks = [];
    const finish = (code, stdout) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code) {
        try { child?.kill('SIGKILL'); } catch { /* Never expose process errors. */ }
        reject(failure(code));
      } else resolve({ stdout, exitCode: 0 });
    };
    try {
      child = spawnImpl(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      timer = setTimeout(() => finish('KEYCHAIN_TIMEOUT'), options.timeout);
      child.on('error', () => finish('KEYCHAIN_ERROR'));
      child.stdin.on('error', () => finish('KEYCHAIN_ERROR'));
      for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
        stream.on('error', () => finish('KEYCHAIN_ERROR'));
        stream.on('data', (chunk) => {
          if (finished) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > options.maxOutputBytes) return finish('OUTPUT_TOO_LARGE');
          if (capture) chunks.push(data);
        });
      }
      child.on('close', (code) => {
        if (code !== 0) finish('KEYCHAIN_ERROR');
        else finish(null, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(options.input, 'utf8');
    } catch { finish('KEYCHAIN_ERROR'); }
  });
}

/** macOS generic-password storage. runner/platform injection is for isolated tests. */
export class KeychainVault {
  #runner;
  #platform;
  constructor({ runner = createKeychainRunner(), platform = process.platform } = {}) {
    this.#runner = runner;
    this.#platform = platform;
  }
  async get(key = 'account') { return this.#request('get', key); }
  async set(key, value) { await this.#request('set', key, value); }
  async delete(key) { await this.#request('delete', key); }

  async #request(action, key, value) {
    if (this.#platform !== 'darwin') throw failure('UNSUPPORTED_PLATFORM');
    if (!ACCOUNTS.has(key)) throw failure('INVALID_KEY');
    const request = { action, service: 'kakao-headless', account: key };
    if (action === 'set') {
      if (!objectValue(value)) throw failure('INVALID_VALUE');
      request.value = value;
    }
    let input;
    try {
      input = JSON.stringify(request);
      // toJSON must not turn a supplied object into a scalar or an array.
      if (action === 'set' && !objectValue(JSON.parse(input).value)) throw failure('INVALID_VALUE');
    } catch { throw failure('INVALID_VALUE'); }
    if (Buffer.byteLength(input) > LIMIT) throw failure('INPUT_TOO_LARGE');
    // No credentials are added to argv or environment. Do not inherit arbitrary env vars.
    const env = { PATH: '/usr/bin:/bin' };
    for (const name of ['HOME', 'TMPDIR']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    let result;
    try {
      result = await this.#runner('/usr/bin/swift', [HELPER], {
        input, env, timeout: TIMEOUT, maxOutputBytes: LIMIT,
      });
    } catch (error) {
      const code = ['KEYCHAIN_TIMEOUT', 'OUTPUT_TOO_LARGE'].includes(error?.code) ? error.code : 'KEYCHAIN_ERROR';
      throw failure(code);
    }
    if (!result || result.exitCode !== 0) throw failure('KEYCHAIN_ERROR');
    if (typeof result.stdout !== 'string') throw failure('INVALID_RESPONSE');
    if (Buffer.byteLength(result.stdout) > LIMIT) throw failure('OUTPUT_TOO_LARGE');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw failure('INVALID_RESPONSE'); }
    if (!objectValue(response) || typeof response.ok !== 'boolean') throw failure('INVALID_RESPONSE');
    if (!response.ok) throw failure('KEYCHAIN_ERROR');
    if (action === 'get') {
      if (response.value !== null && !objectValue(response.value)) throw failure('INVALID_RESPONSE');
      return response.value;
    }
    return undefined;
  }
}
