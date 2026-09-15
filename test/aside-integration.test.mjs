import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installAside, doctorAside, uninstallAside } from '../src/aside-integration.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
async function fixture(t) {
  // On macOS /var itself is a symlink; use the canonical temporary directory.
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'kakao-aside-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const accountRoot = path.join(base, 'account');
  await fs.mkdir(accountRoot);
  const templatePath = path.join(base, 'template.md');
  await fs.writeFile(templatePath, '---\nname: kakao-headless\n---\n\nOriginal safety workflow.\n');
  const options = { account: '0', accountRoot, templatePath, version: '0.2.0' };
  const skill = path.join(accountRoot, 'skills/user/kakao-headless/SKILL.md');
  const manifest = path.join(accountRoot, 'integrations/kakao-headless/manifest.json');
  return { base, options, skill, manifest, templatePath, accountRoot };
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function put(file, contents) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); }

test('initial install has private files, exact template, runtime and managed manifest', async t => {
  const f = await fixture(t);
  const result = await installAside(f.options);
  assert.equal(result.status, 'installed');
  const content = await fs.readFile(f.skill, 'utf8');
  assert.ok(content.startsWith(await fs.readFile(f.templatePath, 'utf8')));
  assert.ok(content.includes(process.execPath));
  assert.ok(content.includes('/src/cli.mjs'));
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  assert.equal(manifest.sha256, hash(content));
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.account, '0');
  assert.equal(manifest.accountRoot, f.accountRoot);
  assert.ok(path.isAbsolute(manifest.nodePath));
  assert.ok(path.isAbsolute(manifest.cliPath));
  assert.ok(Number.isFinite(Date.parse(manifest.installedAt)));
  assert.equal((await fs.stat(f.skill)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.manifest)).mode & 0o777, 0o600);
  assert.equal(await exists(path.join(f.accountRoot, '.kakao-headless.lock')), false);
});

test('repeat install is unchanged and leaves bytes and timestamp untouched', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  const before = await fs.readFile(f.manifest);
  assert.equal((await installAside(f.options)).status, 'unchanged');
  assert.deepEqual(await fs.readFile(f.manifest), before);
});

test('managed version and template updates install the current desired content', async t => {
  const f = await fixture(t);
  await installAside({ ...f.options, version: '0.1.1' });
  assert.equal((await doctorAside(f.options)).status, 'outdated');
  assert.equal((await installAside(f.options)).status, 'updated');
  await fs.appendFile(f.templatePath, '\nNew workflow step.\n');
  assert.equal((await doctorAside(f.options)).status, 'outdated');
  assert.equal((await installAside(f.options)).status, 'updated');
  assert.equal((await doctorAside(f.options)).status, 'installed');
});

test('edited managed skill is preserved by install and uninstall', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  await fs.appendFile(f.skill, '\nOperator edit.');
  const before = await fs.readFile(f.skill);
  const manifest = await fs.readFile(f.manifest);
  assert.deepEqual((await installAside(f.options)).reason, 'modified');
  assert.equal((await doctorAside(f.options)).status, 'modified');
  assert.equal((await uninstallAside(f.options)).status, 'preserved');
  assert.deepEqual(await fs.readFile(f.skill), before);
  assert.deepEqual(await fs.readFile(f.manifest), manifest);
});

test('unmanaged skill is preserved even when identical to desired bytes', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  const before = await fs.readFile(f.skill);
  await fs.unlink(f.manifest);
  assert.equal((await installAside(f.options)).reason, 'unmanaged');
  assert.equal((await uninstallAside(f.options)).status, 'preserved');
  assert.deepEqual(await fs.readFile(f.skill), before);
  assert.equal(await exists(f.manifest), false);
});

test('malformed or mismatched manifest never grants ownership', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  for (const invalid of ['not json', JSON.stringify({ ...manifest, account: '1' }), JSON.stringify({ ...manifest, accountRoot: f.base }), JSON.stringify({ ...manifest, skillPath: '/elsewhere' })]) {
    await fs.writeFile(f.manifest, invalid);
    assert.equal((await installAside(f.options)).reason, 'unmanaged');
    assert.equal((await uninstallAside(f.options)).status, 'preserved');
    assert.equal(await fs.readFile(f.manifest, 'utf8'), invalid);
  }
});

test('orphan manifest is preserved, not taken over or deleted', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  await fs.unlink(f.skill);
  assert.equal((await doctorAside(f.options)).status, 'missing');
  assert.equal((await installAside(f.options)).status, 'preserved');
  assert.equal((await uninstallAside(f.options)).status, 'preserved');
  assert.equal(await exists(f.manifest), true);
});

test('missing account is never created by any operation', async t => {
  const f = await fixture(t);
  const accountRoot = path.join(f.base, 'missing');
  for (const operation of [installAside, doctorAside, uninstallAside]) await assert.rejects(operation({ ...f.options, accountRoot }), { code: 'ACCOUNT_MISSING' });
  assert.equal(await exists(accountRoot), false);
});

test('account must be explicitly supplied as a canonical numeric string', async t => {
  const f = await fixture(t);
  for (const account of [undefined, null, 0, 1, '', '00', '01', '-1', '+1', ' 0', '0 ', '0.0', '../0', '0/1', '１']) {
    for (const operation of [installAside, doctorAside, uninstallAside]) await assert.rejects(operation({ ...f.options, account }), { code: 'INVALID_ACCOUNT' });
  }
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
});

test('rejects relative and traversal paths before writes', async t => {
  const f = await fixture(t);
  for (const bad of ['relative', `${f.accountRoot}/../account`, `${f.accountRoot}/bad\npath`]) {
    await assert.rejects(installAside({ ...f.options, accountRoot: bad }), { code: 'INVALID_PATH' });
  }
  await assert.rejects(installAside({ ...f.options, nodePath: 'node' }), { code: 'INVALID_PATH' });
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
});

test('default account root is only homeDir/.aside/u/explicit-account', async t => {
  const f = await fixture(t);
  const homeDir = path.join(f.base, 'home');
  const root = path.join(homeDir, '.aside/u/12');
  await fs.mkdir(root, { recursive: true });
  const options = { ...f.options, account: '12', accountRoot: undefined, homeDir };
  assert.equal((await installAside(options)).accountRoot, root);
  assert.equal((await doctorAside(options)).status, 'installed');
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
  await assert.rejects(installAside({ ...options, account: '13' }), { code: 'ACCOUNT_MISSING' });
});

test('explicit operator root works independently of account numbering and home', async t => {
  const f = await fixture(t);
  const otherRoot = path.join(f.base, 'operator chosen root');
  await fs.mkdir(otherRoot);
  const options = { ...f.options, account: '42', accountRoot: otherRoot, homeDir: '/does/not/exist' };
  assert.equal((await installAside(options)).accountRoot, otherRoot);
  assert.equal((await doctorAside(options)).account, '42');
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
});

test('refuses symlink account root and ancestor components', async t => {
  const f = await fixture(t);
  const link = path.join(f.base, 'alias');
  await fs.symlink(f.accountRoot, link);
  await fs.mkdir(path.join(f.accountRoot, 'nested'));
  for (const accountRoot of [link, path.join(link, 'nested')]) {
    for (const operation of [installAside, doctorAside, uninstallAside]) await assert.rejects(operation({ ...f.options, accountRoot }), { code: 'SYMLINK_REFUSED' });
  }
});

test('refuses symlink skill, manifest, and owned directory components', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  for (const relative of ['skills', 'skills/user', 'skills/user/kakao-headless', 'integrations', 'integrations/kakao-headless']) {
    const target = path.join(f.accountRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(outside, target);
    await assert.rejects(installAside(f.options), { code: 'SYMLINK_REFUSED' });
    await fs.unlink(target);
  }
  await installAside(f.options);
  for (const target of [f.skill, f.manifest]) {
    const original = await fs.readFile(target);
    await fs.unlink(target);
    const foreign = path.join(outside, path.basename(target));
    await fs.writeFile(foreign, original);
    await fs.symlink(foreign, target);
    for (const operation of [installAside, doctorAside, uninstallAside]) await assert.rejects(operation(f.options), { code: 'SYMLINK_REFUSED' });
    assert.deepEqual(await fs.readFile(foreign), original);
    await fs.unlink(target);
    await fs.writeFile(target, original);
  }
});

test('doctor is read-only before and after install', async t => {
  const f = await fixture(t);
  assert.equal((await doctorAside(f.options)).status, 'missing');
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
  await installAside(f.options);
  const skill = await fs.readFile(f.skill);
  const manifest = await fs.readFile(f.manifest);
  const stats = await fs.stat(f.manifest);
  assert.equal((await doctorAside(f.options)).status, 'installed');
  assert.deepEqual(await fs.readFile(f.skill), skill);
  assert.deepEqual(await fs.readFile(f.manifest), manifest);
  assert.equal((await fs.stat(f.manifest)).mtimeMs, stats.mtimeMs);
});

test('runtime missing is reported without changing a managed install', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  const before = await fs.readFile(f.manifest);
  const options = { ...f.options, cliPath: path.join(f.base, 'missing-cli') };
  const status = await doctorAside(options);
  assert.equal(status.status, 'runtime_missing');
  assert.equal(status.installationStatus, 'outdated');
  assert.deepEqual(status.runtimeMissing, [options.cliPath]);
  assert.equal((await installAside(options)).status, 'runtime_missing');
  assert.deepEqual(await fs.readFile(f.manifest), before);
  assert.equal(await exists(path.join(f.accountRoot, '.kakao-headless.lock')), false);
});

test('selective uninstall leaves unrelated skills, settings, directories and files intact', async t => {
  const f = await fixture(t);
  const unrelated = ['AGENTS.md', 'settings.json', 'skills/builtin/kakao/SKILL.md', 'skills/user/other/SKILL.md', 'skills/user/kakao-headless/notes.txt', 'integrations/kakao-headless/operator.txt'];
  for (const relative of unrelated) await put(path.join(f.accountRoot, relative), `untouched ${relative}`);
  await installAside(f.options);
  assert.equal((await uninstallAside(f.options)).status, 'uninstalled');
  assert.equal(await exists(f.skill), false);
  assert.equal(await exists(f.manifest), false);
  for (const relative of unrelated) assert.equal(await fs.readFile(path.join(f.accountRoot, relative), 'utf8'), `untouched ${relative}`);
  assert.equal((await uninstallAside(f.options)).status, 'missing');
});

test('runtime pair shell-quotes spaces, apostrophes and shell metacharacters exactly', async t => {
  const f = await fixture(t);
  const dir = path.join(f.base, "runtime space ' quote $HOME ; literal");
  await fs.mkdir(dir);
  const nodePath = path.join(dir, "node ' binary");
  const cliPath = path.join(dir, "cli ' ; echo BAD.mjs");
  await fs.symlink(process.execPath, nodePath);
  await fs.writeFile(cliPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  await installAside({ ...f.options, nodePath, cliPath });
  const text = await fs.readFile(f.skill, 'utf8');
  const command = text.match(/```sh\n([^\n]+)\n```/)[1];
  const output = await run('/bin/sh', ['-c', `${command} doctor`]);
  assert.equal(output.stdout.trim(), '["doctor"]');
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  assert.equal(manifest.nodePath, nodePath);
  assert.equal(manifest.cliPath, cliPath);
});

test('exclusive lock prevents writes and is never stolen, including symlink locks', async t => {
  const f = await fixture(t);
  const lock = path.join(f.accountRoot, '.kakao-headless.lock');
  await fs.writeFile(lock, 'other operation');
  for (const operation of [installAside, doctorAside, uninstallAside]) await assert.rejects(operation(f.options), { code: 'LOCKED' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'other operation');
  assert.equal(await exists(f.skill), false);
  await fs.unlink(lock);
  await fs.symlink(f.templatePath, lock);
  await assert.rejects(installAside(f.options), { code: 'SYMLINK_REFUSED' });
});

test('cooperating concurrent installs cannot both acquire the operation lock', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([installAside(f.options), installAside(f.options)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'LOCKED');
  assert.equal((await doctorAside(f.options)).status, 'installed');
});

test('missing template and invalid destination fail safely and release lock', async t => {
  const f = await fixture(t);
  await assert.rejects(installAside({ ...f.options, templatePath: path.join(f.base, 'missing-template') }), { code: 'TEMPLATE_MISSING' });
  assert.deepEqual(await fs.readdir(f.accountRoot), []);
  await fs.mkdir(f.manifest, { recursive: true });
  await assert.rejects(installAside(f.options), { code: 'INVALID_PATH' });
  assert.equal(await exists(f.skill), false);
  assert.equal(await exists(path.join(f.accountRoot, '.kakao-headless.lock')), false);
  await fs.rmdir(f.manifest);
  assert.equal((await installAside(f.options)).status, 'installed');
});

test('failed managed update leaves prior skill and manifest bytes intact', async t => {
  const f = await fixture(t);
  await installAside(f.options);
  const skill = await fs.readFile(f.skill);
  const manifest = await fs.readFile(f.manifest);
  await assert.rejects(installAside({ ...f.options, templatePath: path.join(f.base, 'missing'), version: '0.3.0' }), { code: 'TEMPLATE_MISSING' });
  assert.deepEqual(await fs.readFile(f.skill), skill);
  assert.deepEqual(await fs.readFile(f.manifest), manifest);
  assert.equal((await doctorAside(f.options)).status, 'installed');
});

test('staging permission failure preserves prior managed files and removes temporary files', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses filesystem permission checks');
  const f = await fixture(t);
  await installAside(f.options);
  const beforeSkill = await fs.readFile(f.skill);
  const beforeManifest = await fs.readFile(f.manifest);
  const manifestDir = path.dirname(f.manifest);
  await fs.chmod(manifestDir, 0o500);
  try {
    await assert.rejects(installAside({ ...f.options, version: '0.3.0' }), error => ['EACCES', 'EPERM'].includes(error.code));
    assert.deepEqual(await fs.readFile(f.skill), beforeSkill);
    assert.deepEqual(await fs.readFile(f.manifest), beforeManifest);
    assert.deepEqual(await fs.readdir(path.dirname(f.skill)), ['SKILL.md']);
    assert.deepEqual(await fs.readdir(manifestDir), ['manifest.json']);
    assert.equal(await exists(path.join(f.accountRoot, '.kakao-headless.lock')), false);
  } finally {
    await fs.chmod(manifestDir, 0o700);
  }
  assert.equal((await doctorAside(f.options)).status, 'installed');
});
