import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KeychainVault, createKeychainRunner } from '../src/vault.mjs';

const success = (value = null) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, value }) });
const errorCode = (code) => (error) => error.code === code;
function mockVault(handler = () => success()) {
  const calls = [];
  const vault = new KeychainVault({ platform: 'darwin', runner: async (...args) => {
    calls.push(args);
    return handler(...args);
  } });
  return { vault, calls };
}

test('default get returns absent null and stored objects', async () => {
  const { vault, calls } = mockVault();
  assert.equal(await vault.get(), null);
  assert.deepEqual(JSON.parse(calls[0][2].input), { action: 'get', service: 'kakao-headless', account: 'account' });
  const stored = { token: 'private-token', nested: { expires: 10 } };
  assert.deepEqual(await mockVault(() => success(stored)).vault.get('pending'), stored);
});

test('set/delete use stdin only, fixed executable and helper, bounded options', async () => {
  const { vault, calls } = mockVault();
  const value = { password: 'DO-NOT-LEAK-12345', accessToken: 'PRIVATE-67890' };
  assert.equal(await vault.set('pending', value), undefined);
  assert.equal(await vault.delete('pending'), undefined);
  assert.deepEqual(JSON.parse(calls[0][2].input), { action: 'set', service: 'kakao-headless', account: 'pending', value });
  assert.deepEqual(JSON.parse(calls[1][2].input), { action: 'delete', service: 'kakao-headless', account: 'pending' });
  for (const [command, args, options] of calls) {
    assert.equal(command, '/usr/bin/swift');
    assert.equal(args.length, 1);
    assert.match(args[0], /\/src\/keychain\.swift$/);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.maxOutputBytes, 1024 * 1024);
    const exposed = JSON.stringify({ command, args, env: options.env });
    for (const secret of Object.values(value)) assert.equal(exposed.includes(secret), false);
    assert.ok(Object.keys(options.env).every(key => ['PATH', 'HOME', 'TMPDIR'].includes(key)));
  }
});

test('rejects all unsupported keys before invoking runner', async () => {
  const { vault, calls } = mockVault();
  for (const key of ['', 'other', '../account', 'ACCOUNT', 'account\n', null, 42, {}, ['account']]) {
    await assert.rejects(vault.get(key), errorCode('INVALID_KEY'));
    await assert.rejects(vault.set(key, {}), errorCode('INVALID_KEY'));
    await assert.rejects(vault.delete(key), errorCode('INVALID_KEY'));
  }
  await assert.rejects(vault.delete(), errorCode('INVALID_KEY'));
  assert.equal(calls.length, 0);
});

test('requires JSON object values and enforces request size', async () => {
  const { vault, calls } = mockVault();
  const circular = {}; circular.self = circular;
  for (const value of [undefined, null, 'secret', 4, true, [], 1n, circular, { x: 1n }, { toJSON: () => 'secret' }]) {
    await assert.rejects(vault.set('account', value), errorCode('INVALID_VALUE'));
  }
  await assert.rejects(vault.set('account', { token: 'x'.repeat(1024 * 1024) }), errorCode('INPUT_TOO_LARGE'));
  assert.equal(calls.length, 0);
  await vault.set('account', {});
});

test('nonmac operations fail clearly without executing a process', async () => {
  for (const platform of ['linux', 'win32']) {
    const vault = new KeychainVault({ platform, runner: () => assert.fail('must not execute') });
    for (const action of [() => vault.get(), () => vault.set('account', {}), () => vault.delete('pending')]) {
      await assert.rejects(action(), { code: 'UNSUPPORTED_PLATFORM', message: 'Keychain storage requires macOS.' });
    }
  }
});

test('sanitizes runner, helper and protocol failures', async () => {
  const secret = 'never-display-this';
  for (const handler of [
    () => { throw new Error(secret); },
    () => ({ exitCode: 1, stdout: secret, stderr: secret }),
    () => ({ exitCode: 0, stdout: JSON.stringify({ ok: false, error: secret }) }),
    () => ({ exitCode: 0, stdout: secret }),
    () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, value: secret }) }),
    () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true }) }),
    () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, value: [] }) }),
    () => undefined,
  ]) {
    await assert.rejects(mockVault(handler).vault.get(), error => {
      assert.equal(String(error).includes(secret), false);
      assert.equal(error.cause, undefined);
      assert.ok(['KEYCHAIN_ERROR', 'INVALID_RESPONSE'].includes(error.code));
      return true;
    });
  }
  await assert.rejects(mockVault(() => ({ exitCode: 0, stdout: 'x'.repeat(1024 * 1024 + 1) })).vault.get(), errorCode('OUTPUT_TOO_LARGE'));
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => { assert.equal(signal, 'SIGKILL'); child.killed = true; };
  return child;
}
const transportOptions = { input: '{"secret":"stdin-only"}', env: { PATH: '/usr/bin:/bin' }, timeout: 1000, maxOutputBytes: 1024 };

test('transport pipes input and captures stdout without passing input in spawn options', async () => {
  const child = fakeProcess();
  let input = '';
  child.stdin.on('data', chunk => { input += chunk; });
  const runner = createKeychainRunner((command, args, options) => {
    assert.equal(command, '/usr/bin/swift');
    assert.deepEqual(args, ['/helper.swift']);
    assert.deepEqual(options, { env: transportOptions.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    return child;
  });
  const promise = runner('/usr/bin/swift', ['/helper.swift'], transportOptions);
  child.stdout.write('{"ok":true}');
  child.stderr.write('not returned');
  child.emit('close', 0);
  assert.deepEqual(await promise, { exitCode: 0, stdout: '{"ok":true}' });
  assert.equal(input, transportOptions.input);
});

test('transport caps combined stdout and stderr and kills child', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const child = fakeProcess();
    const promise = createKeychainRunner(() => child)('/usr/bin/swift', [], { ...transportOptions, maxOutputBytes: 4 });
    child.stdout.write('123');
    child[stream].write('45');
    await assert.rejects(promise, errorCode('OUTPUT_TOO_LARGE'));
    assert.equal(child.killed, true);
  }
});

test('transport times out and kills child', async () => {
  const child = fakeProcess();
  await assert.rejects(createKeychainRunner(() => child)('/usr/bin/swift', [], { ...transportOptions, timeout: 5 }), errorCode('KEYCHAIN_TIMEOUT'));
  assert.equal(child.killed, true);
});

test('transport sanitizes spawn, pipe, and exit failures', async () => {
  const secret = 'private failure';
  await assert.rejects(createKeychainRunner(() => { throw new Error(secret); })('x', [], transportOptions), { code: 'KEYCHAIN_ERROR', message: 'Keychain operation failed.' });
  for (const target of ['process', 'stdin', 'stdout', 'stderr', 'exit']) {
    const child = fakeProcess();
    const promise = createKeychainRunner(() => child)('x', [], transportOptions);
    if (target === 'exit') child.emit('close', 7);
    else (target === 'process' ? child : child[target]).emit('error', new Error(secret));
    await assert.rejects(promise, { code: 'KEYCHAIN_ERROR', message: 'Keychain operation failed.' });
  }
});
