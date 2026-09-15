import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const NAME = 'kakao-headless';
const DEFAULT_VERSION = '0.2.0';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.split(path.sep).includes('..')) {
    fail('INVALID_PATH', `${label} must be an absolute path without traversal or control characters`);
  }
  return path.normalize(value);
}

// Do not follow symlinks in any account-owned path, including ancestors.
async function inspect(file) {
  const parsed = path.parse(file);
  let current = parsed.root;
  const parts = file.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED', `Refusing symlink: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) fail('INVALID_PATH', `Not a directory: ${current}`);
    if (i === parts.length - 1) return stat;
  }
  return fs.lstat(parsed.root);
}
async function readOptional(file) {
  const stat = await inspect(file);
  if (!stat) return null;
  if (!stat.isFile()) fail('INVALID_PATH', `Not a regular file: ${file}`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function context(options = {}) {
  const { account, accountRoot, homeDir = os.homedir(), version = DEFAULT_VERSION } = options;
  if (typeof account !== 'string' || !/^(0|[1-9][0-9]*)$/.test(account)) fail('INVALID_ACCOUNT', 'An explicit canonical numeric account string is required');
  if (typeof version !== 'string' || !version || /[\0\r\n]/.test(version)) fail('INVALID_VERSION', 'version must be a nonempty single-line string');
  const root = accountRoot === undefined ? path.join(absolute(homeDir, 'homeDir'), '.aside', 'u', account) : absolute(accountRoot, 'accountRoot');
  const stat = await inspect(root);
  if (!stat?.isDirectory()) fail('ACCOUNT_MISSING', `Account root must already exist: ${root}`);
  return {
    account, accountRoot: root, version,
    nodePath: absolute(options.nodePath ?? process.execPath, 'nodePath'),
    cliPath: absolute(options.cliPath ?? fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'cliPath'),
    templatePath: absolute(options.templatePath ?? fileURLToPath(new URL('../skills/kakao-headless/SKILL.md', import.meta.url)), 'templatePath'),
    skillPath: path.join(root, 'skills/user/kakao-headless/SKILL.md'),
    manifestPath: path.join(root, 'integrations/kakao-headless/manifest.json'),
    lockPath: path.join(root, '.kakao-headless.lock'),
  };
}
function result(c, status, extra = {}) {
  return { status, account: c.account, accountRoot: c.accountRoot, skillPath: c.skillPath, manifestPath: c.manifestPath, ...extra };
}
async function desired(c) {
  const template = await readOptional(c.templatePath);
  if (!template) fail('TEMPLATE_MISSING', `Template missing: ${c.templatePath}`);
  const content = Buffer.from(template.toString('utf8') + `\n\n## Generated Aside runtime\n\nInstalled version: ${c.version}. For every CLI command above, use this exact runtime pair (append the command arguments):\n\n\`\`\`sh\n${quote(c.nodePath)} ${quote(c.cliPath)}\n\`\`\`\n\nRun the pair with \`doctor\` first. This section does not change the approval or safety workflow above.\n`);
  return { content, sha256: digest(content) };
}
async function state(c) {
  const skill = await readOptional(c.skillPath);
  const rawManifest = await readOptional(c.manifestPath);
  let manifest;
  try { manifest = rawManifest && JSON.parse(rawManifest.toString('utf8')); } catch { /* preserve malformed manifests */ }
  const managed = Boolean(manifest && manifest.integration === NAME && manifest.schemaVersion === 1 && manifest.account === c.account && manifest.accountRoot === c.accountRoot && manifest.skillPath === c.skillPath && typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256) && typeof manifest.version === 'string' && typeof manifest.installedAt === 'string' && typeof manifest.nodePath === 'string' && path.isAbsolute(manifest.nodePath) && typeof manifest.cliPath === 'string' && path.isAbsolute(manifest.cliPath));
  return { skill, rawManifest, manifest, managed, matches: managed && skill !== null && digest(skill) === manifest.sha256 };
}
async function runtimeMissing(c) {
  const missing = [];
  for (const [key, mode] of [['nodePath', constants.X_OK], ['cliPath', constants.R_OK]]) {
    try {
      // Runtime binaries may be installed through symlinks; no writes target them.
      const stat = await fs.stat(c[key]);
      if (!stat.isFile()) throw new Error('not a file');
      await fs.access(c[key], mode);
    } catch { missing.push(c[key]); }
  }
  return missing;
}
async function mkdirSafe(dir) {
  const stat = await inspect(dir);
  if (stat) {
    if (!stat.isDirectory()) fail('INVALID_PATH', `Not a directory: ${dir}`);
    return;
  }
  await mkdirSafe(path.dirname(dir));
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const created = await inspect(dir);
  if (!created?.isDirectory()) fail('INVALID_PATH', `Not a directory: ${dir}`);
}
async function stage(file, content) {
  await inspect(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
async function atomic(file, content) {
  const temporary = await stage(file, content);
  try { await inspect(file); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function locked(c, operation) {
  await inspect(c.lockPath);
  let lock;
  try { lock = await fs.open(c.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('LOCKED', 'Aside integration operation is locked; no stale lock is stolen'); throw error; }
  try { return await operation(); }
  finally { await lock.close(); await fs.unlink(c.lockPath); }
}

export async function installAside(options = {}) {
  const c = await context(options);
  return locked(c, async () => {
    const s = await state(c);
    if ((s.skill !== null || s.rawManifest !== null) && !s.matches) return result(c, 'preserved', { reason: s.managed ? 'modified' : 'unmanaged' });
    const d = await desired(c);
    const missing = await runtimeMissing(c);
    if (missing.length) return result(c, 'runtime_missing', { runtimeMissing: missing });
    if (s.matches && s.manifest.sha256 === d.sha256 && s.manifest.version === c.version && s.manifest.nodePath === c.nodePath && s.manifest.cliPath === c.cliPath) return result(c, 'unchanged', { version: c.version, sha256: d.sha256 });
    const manifest = { schemaVersion: 1, integration: NAME, account: c.account, accountRoot: c.accountRoot, skillPath: c.skillPath, version: c.version, nodePath: c.nodePath, cliPath: c.cliPath, sha256: d.sha256, installedAt: new Date().toISOString() };
    await mkdirSafe(path.dirname(c.skillPath));
    await mkdirSafe(path.dirname(c.manifestPath));
    // Stage both files before replacing either. Roll back ordinary write failures.
    // A process crash between renames remains fail-closed: the hash mismatch is preserved.
    const skillTemp = await stage(c.skillPath, d.content);
    let manifestTemp;
    let replaced = false;
    try {
      manifestTemp = await stage(c.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await inspect(c.skillPath);
      await inspect(c.manifestPath);
      await fs.rename(skillTemp, c.skillPath);
      replaced = true;
      await fs.rename(manifestTemp, c.manifestPath);
    } catch (error) {
      if (replaced) {
        try {
          if (s.skill === null) await fs.unlink(c.skillPath);
          else await atomic(c.skillPath, s.skill);
        } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Install failed; rollback failed, files are preserved fail-closed'); }
      }
      throw error;
    } finally {
      for (const file of [skillTemp, manifestTemp].filter(Boolean)) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return result(c, s.matches ? 'updated' : 'installed', { version: c.version, sha256: d.sha256 });
  });
}

export async function doctorAside(options = {}) {
  const c = await context(options);
  // Read-only: observe an active exclusive lock, never create directories or files.
  if (await inspect(c.lockPath)) fail('LOCKED', 'Aside integration operation is locked');
  const s = await state(c);
  const d = await desired(c);
  const missing = await runtimeMissing(c);
  let installationStatus;
  if (!s.skill) installationStatus = 'missing';
  else if (!s.matches) installationStatus = 'modified';
  else if (s.manifest.sha256 !== d.sha256 || s.manifest.version !== c.version || s.manifest.nodePath !== c.nodePath || s.manifest.cliPath !== c.cliPath) installationStatus = 'outdated';
  else installationStatus = 'installed';
  if (await inspect(c.lockPath)) fail('LOCKED', 'Aside integration operation is locked');
  return result(c, missing.length ? 'runtime_missing' : installationStatus, { installationStatus, managed: s.managed, version: s.manifest?.version ?? null, desiredVersion: c.version, runtimeMissing: missing, sha256: s.skill ? digest(s.skill) : null, desiredSha256: d.sha256 });
}

export async function uninstallAside(options = {}) {
  const c = await context(options);
  return locked(c, async () => {
    const s = await state(c);
    if (s.skill === null && s.rawManifest === null) return result(c, 'missing');
    if (!s.matches) return result(c, 'preserved', { reason: s.managed ? 'modified' : 'unmanaged' });
    await inspect(c.skillPath);
    await inspect(c.manifestPath);
    await fs.unlink(c.skillPath);
    try { await fs.unlink(c.manifestPath); }
    catch (error) {
      await atomic(c.skillPath, s.skill);
      throw error;
    }
    // Deliberately leave all directories and unrelated files alone.
    return result(c, 'uninstalled');
  });
}
